// fork-client.js — cliente WebSocket para el backend Node de Fase 6.
//
// Pinta la simulación que ocurre en el servidor: cada proceso del simulador
// es un proceso REAL del SO (fork()), con su PID nativo visible.

(function () {
  let ws = null;
  let coresState = [];
  let log = [];
  let endSummary = null;

  const $ = (id) => document.getElementById(id);

  function setStatus(text, ok) {
    const el = $('fk-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'fk-status ' + (ok ? 'fk-ok' : 'fk-err');
  }

  function pushLog(line, kind) {
    log.unshift({ line, kind, t: Date.now() });
    if (log.length > 60) log.pop();
    renderLog();
  }

  function renderLog() {
    const el = $('fk-log');
    if (!el) return;
    el.innerHTML = log.map(e =>
      `<div class="fk-line fk-${e.kind || ''}">${e.line}</div>`
    ).join('');
  }

  function renderCores() {
    const el = $('fk-cores');
    if (!el) return;
    el.innerHTML = '';
    coresState.forEach((c, idx) => {
      const div = document.createElement('div');
      div.className = 'core ' + (c.busy ? 'core-busy' : 'core-idle');
      div.innerHTML = `
        <div class="core-title">Core ${idx}</div>
        <div class="core-pid">${c.pid || '—'}</div>
        <div class="core-rem">${c.osPid ? 'OS PID ' + c.osPid : 'idle'}</div>
        <div class="core-rem">${c.busy ? 'rem ' + (c.remaining ?? '?') : ''}</div>`;
      el.appendChild(div);
    });
  }

  function renderSummary() {
    const el = $('fk-summary');
    if (!el) return;
    if (!endSummary) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <h4>Resultado final (t=${endSummary.time})</h4>
      <ul class="metrics">
        <li>Avg Turnaround: <strong>${endSummary.avgTat}</strong></li>
        <li>Avg Waiting: <strong>${endSummary.avgWait}</strong></li>
        <li>Avg Response: <strong>${endSummary.avgResp}</strong></li>
      </ul>
      <table class="data small">
        <thead><tr><th>PID</th><th>OS PID</th><th>Core</th>
                   <th>AT</th><th>BT</th><th>CT</th></tr></thead>
        <tbody>${endSummary.rows.map(r => `
          <tr><td>${r.pid}</td><td><code>${r.osPid ?? '—'}</code></td>
              <td>${r.coreId ?? '—'}</td>
              <td>${r.arrival}</td><td>${r.burst}</td><td>${r.completion}</td></tr>
        `).join('')}</tbody>
      </table>`;
  }

  function ensureCores(n) {
    while (coresState.length < n) coresState.push({ busy: false, pid: null, osPid: null });
    coresState.length = n;
    renderCores();
  }

  function connect() {
    const url = $('fk-url').value || 'ws://localhost:8765';
    if (ws) try { ws.close(); } catch {}
    setStatus('conectando…', false);
    ws = new WebSocket(url);
    ws.onopen = () => {
      setStatus('conectado a ' + url, true);
      pushLog('WebSocket conectado', 'ok');
    };
    ws.onclose = () => {
      setStatus('desconectado', false);
      pushLog('WebSocket cerrado', 'err');
    };
    ws.onerror = () => {
      setStatus('error de conexión (¿corriste `npm start` en server/?)', false);
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
  }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        pushLog(`Servidor activo · PID node ${msg.pid} · puerto ${msg.port}`, 'info');
        break;
      case 'started':
        endSummary = null; renderSummary();
        ensureCores(msg.numCores);
        pushLog(`Simulación iniciada · ${msg.algorithm} · ${msg.numCores} cores · ${msg.total} procesos · server PID ${msg.serverPid}`, 'info');
        break;
      case 'arrive':
        pushLog(`t=${msg.t} · ${msg.pid} llega a READY`, 'info');
        break;
      case 'fork':
        coresState[msg.coreId] = {
          busy: true, pid: msg.pid, osPid: msg.osPid, remaining: '?'
        };
        renderCores();
        pushLog(`t=${msg.t} · 🍴 fork() · ${msg.pid} → OS PID <strong>${msg.osPid}</strong> en core ${msg.coreId}`, 'fork');
        break;
      case 'tick':
        if (coresState[msg.coreId]) coresState[msg.coreId].remaining = msg.remaining;
        renderCores();
        break;
      case 'done':
        pushLog(`t=${msg.t} · ✅ ${msg.pid} terminó (OS PID ${msg.osPid})`, 'done');
        break;
      case 'exit':
        if (coresState[msg.coreId]) coresState[msg.coreId] = { busy: false, pid: null, osPid: null };
        renderCores();
        pushLog(`t=${msg.t} · proceso OS PID ${msg.osPid} salió (code=${msg.code})`, 'exit');
        break;
      case 'end':
        endSummary = msg.summary;
        renderSummary();
        pushLog(`t=${msg.t} · 🏁 simulación completa`, 'ok');
        break;
      case 'stopped':
        pushLog(`t=${msg.t} · simulación detenida por el cliente`, 'err');
        break;
    }
  }

  function startBackend() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      window.UI && UI.toast('Conéctate al backend primero (botón Conectar)', 'err');
      return;
    }
    if (!window.__processList || window.__processList.length === 0) {
      window.UI && UI.toast('Agrega procesos en la pestaña Procesos antes de ejecutar', 'err');
      window.UI && UI.activateTab('procesos');
      return;
    }
    const algo = $('fk-algo').value;
    const numCores = Math.max(1, parseInt($('in-cores').value, 10) || 1);
    log = []; renderLog();
    coresState = []; renderCores();
    endSummary = null; renderSummary();
    ws.send(JSON.stringify({
      type: 'start',
      processes: window.__processList,
      numCores,
      algorithm: algo,
      tickMs: 250
    }));
  }

  function stopBackend() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('fk-connect')) return;
    $('fk-connect').onclick = connect;
    $('fk-run').onclick = startBackend;
    $('fk-stop').onclick = stopBackend;
  });
})();
