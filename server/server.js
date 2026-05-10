// server.js — backend del simulador con fork() real.
//
// Arquitectura:
//   * Servidor HTTP + WebSocket (puerto 8765).
//   * Cuando un cliente envía 'start', el server actúa como kernel:
//       - Mantiene cola READY, N "cores" virtuales.
//       - Por cada proceso despachado, llama a child_process.fork() y
//         deja que ese hijo (proceso del SO con PID propio) ejecute su
//         burst en paralelo real con los demás hijos.
//       - Recibe ticks/done por IPC y los reenvía por WS al GUI.
//
// Esto es paralelismo de proceso al estilo UNIX (fork) — distinto de los
// Web Workers (threads) que usa el simulador en vivo del navegador.

const http = require('http');
const path = require('path');
const { fork } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = 8765;
const CHILD_SCRIPT = path.join(__dirname, 'child-process.js');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('SysOps Fork Backend OK. Conecta vía ws://localhost:' + PORT);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] cliente conectado');
  let session = null;

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (session) session.stop();
      session = startSimulation(msg, send);
    } else if (msg.type === 'stop' && session) {
      session.stop();
      session = null;
    }
  });

  ws.on('close', () => {
    console.log('[WS] cliente desconectado');
    if (session) session.stop();
  });

  send({ type: 'welcome', pid: process.pid, port: PORT });
});

// ----------------------------------------------------------------------
// Simulación: scheduling no-preemptivo multi-core con fork real por proceso
// Algoritmos soportados: FCFS, SJF, HRRN, PRIO
// (Versión preemptiva queda fuera de alcance para mantener el demo de fork
//  claro y sin SIGSTOP/SIGCONT, que en Windows no es portable.)
// ----------------------------------------------------------------------
function startSimulation(cfg, send) {
  const { processes = [], numCores = 2, algorithm = 'FCFS', tickMs = 200 } = cfg;
  const procs = processes.map(p => ({
    ...p,
    remaining: p.burst,
    state: 'NEW',
    executed: 0,
    firstRun: null,
    completion: null,
    coreId: null,
    osPid: null,
    child: null
  }));
  const cores = Array.from({ length: numCores }, (_, id) => ({ id, busy: false, pid: null }));
  const ready = [];
  let now = 0;
  let stopped = false;

  send({ type: 'started', algorithm, numCores, total: procs.length, serverPid: process.pid });

  function hrrn(p) {
    const wait = Math.max(0, (now - p.arrival) - p.executed);
    return (wait + p.burst) / p.burst;
  }

  function sortReady() {
    if (algorithm === 'SJF')        ready.sort((a, b) => a.burst - b.burst);
    else if (algorithm === 'HRRN')  ready.sort((a, b) => hrrn(b) - hrrn(a));
    else if (algorithm === 'PRIO')  ready.sort((a, b) => a.priority - b.priority);
    else /* FCFS */                 ready.sort((a, b) => a.arrival - b.arrival);
  }

  function dispatch() {
    sortReady();
    for (const c of cores) {
      if (c.busy || ready.length === 0) continue;
      const proc = ready.shift();
      proc.state = 'RUNNING';
      proc.coreId = c.id;
      if (proc.firstRun === null) proc.firstRun = now;
      c.busy = true;
      c.pid = proc.pid;

      // *** Fork real del SO ***
      const child = fork(CHILD_SCRIPT, [], { silent: false });
      proc.child = child;
      proc.osPid = child.pid;

      send({
        type: 'fork',
        pid: proc.pid, coreId: c.id, osPid: child.pid, t: now,
        msg: `fork() → SO PID ${child.pid} para ${proc.pid} en core ${c.id}`
      });

      child.on('message', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'tick') {
          proc.executed = m.executed;
          proc.remaining = m.remaining;
          send({ type: 'tick', pid: proc.pid, coreId: c.id, osPid: child.pid,
                 executed: m.executed, remaining: m.remaining, t: now });
        } else if (m.type === 'done') {
          proc.state = 'TERMINATED';
          proc.completion = now;
          send({ type: 'done', pid: proc.pid, coreId: c.id, osPid: child.pid, t: now });
        }
      });

      child.on('exit', (code) => {
        send({ type: 'exit', pid: proc.pid, coreId: c.id, osPid: child.pid,
               code, t: now });
        c.busy = false;
        c.pid = null;
        proc.child = null;
        if (!stopped) { dispatch(); checkEnd(); }
      });

      child.send({ type: 'run', pid: proc.pid, burst: proc.remaining, tickMs });
    }
  }

  function checkEnd() {
    if (procs.every(p => p.state === 'TERMINATED')) {
      stopped = true;
      clearInterval(clockTimer);
      // Reporte final con métricas.
      const completed = procs.filter(p => p.completion != null);
      const safeAvg = (sel) => completed.length === 0 ? 0
        : completed.reduce((s, p) => s + sel(p), 0) / completed.length;
      const summary = {
        time: now,
        avgTat:  safeAvg(p => p.completion - p.arrival).toFixed(2),
        avgWait: safeAvg(p => p.completion - p.arrival - p.burst).toFixed(2),
        avgResp: safeAvg(p => (p.firstRun ?? p.arrival) - p.arrival).toFixed(2),
        rows: procs.map(p => ({
          pid: p.pid, osPid: p.osPid, arrival: p.arrival, burst: p.burst,
          completion: p.completion, coreId: p.coreId
        }))
      };
      send({ type: 'end', t: now, summary });
    }
  }

  const clockTimer = setInterval(() => {
    if (stopped) return;
    now++;
    for (const p of procs) {
      if (p.state === 'NEW' && p.arrival <= now) {
        p.state = 'READY';
        ready.push(p);
        send({ type: 'arrive', pid: p.pid, t: now });
      }
    }
    dispatch();
    send({ type: 'clock', t: now });
    checkEnd();
  }, tickMs);

  return {
    stop() {
      stopped = true;
      clearInterval(clockTimer);
      // Termina hijos vivos (kill envía SIGTERM, en Windows usa TerminateProcess).
      procs.forEach(p => { if (p.child) try { p.child.kill(); } catch {} });
      send({ type: 'stopped', t: now });
    }
  };
}

server.listen(PORT, () => {
  console.log(`[fork-backend] listo en http://localhost:${PORT}`);
  console.log(`[fork-backend] PID del servidor: ${process.pid}`);
  console.log('[fork-backend] esperando clientes WebSocket...');
});
