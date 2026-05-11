// main.js — entry point. Cablea UI con dos motores independientes:
//   * SCHEDULING: pool de Web Workers + Scheduler (cores, gantt, métricas).
//   * PAGINACIÓN: PagingSimulator + MemoryManager (frames, page table).
// Cada motor tiene su propio Start/Pause/Reset.

(function () {

  // Slider 1..5 → ms por tick (mayor = más lento, menor = más rápido).
  const SPEED_MS = { 1: 600, 2: 400, 3: 250, 4: 150, 5: 80 };
  let TICK_MS = 250;

  // ----- Estado global -----
  let processList = [];

  // Sesión de Scheduling
  const sched = { pool: null, scheduler: null };

  // Sesión de Paginación
  const paging = { memory: null, simulator: null };

  // Doom integration
  let doomLastTick = 0, doomCtxLast = 0, doomLastFaults = 0;
  let doomIntermissionShown = false;

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // PROCESOS
  // ============================================================
  function renderProcessList() {
    window.__processList = processList;
    const tbody = $('process-list');
    tbody.innerHTML = '';
    for (const p of processList) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.pid}</td><td>${p.arrival}</td><td>${p.burst}</td>
                      <td>${p.priority}</td><td>${p.pages}</td>
                      <td class="col-queue">${p.queueLevel ?? 0}</td>
                      <td>${p.threads ?? 1}</td>
                      <td>${p.forks ?? 0}</td>
                      <td><button data-pid="${p.pid}" class="del-proc danger" data-tip="Eliminar">×</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.del-proc').forEach(btn => {
      btn.onclick = () => {
        processList = processList.filter(p => p.pid !== btn.dataset.pid);
        renderProcessList();
        UI.toast(`Proceso ${btn.dataset.pid} eliminado`, 'info', 1500);
      };
    });
    const cnt = $('proc-count'); if (cnt) cnt.textContent = processList.length;
    updateExecPreview();
    refreshStartButtons();
  }

  function updateExecPreview() {
    const el = $('exec-preview');
    if (!el) return;
    const total = window.countExecutables ? window.countExecutables(processList) : processList.length;
    const declared = processList.length;
    if (total === declared) {
      el.textContent = `— ejecutables al simular: ${total}`;
    } else {
      el.textContent = `— ${declared} declarados → ${total} ejecutables (con threads/forks)`;
    }
  }

  function refreshStartButtons() {
    if (!UI || !UI.setBtnReason) return;
    const reason = processList.length === 0 ? 'Agrega al menos un proceso primero' : null;
    UI.setBtnReason('btn-sched-start', reason);
    UI.setBtnReason('btn-paging-start', reason);
  }

  function addProcessFromForm() {
    UI.clearFieldErrors($('btn-add').parentElement);
    const pid = $('in-pid').value.trim();
    let bad = false;
    if (!pid) {
      UI.setFieldError('in-pid', 'requerido');
      UI.toast('El PID es obligatorio', 'err'); bad = true;
    } else if (processList.find(p => p.pid === pid)) {
      UI.setFieldError('in-pid', 'duplicado');
      UI.toast(`Ya existe un proceso con PID "${pid}"`, 'err'); bad = true;
    }
    const burst = parseInt($('in-burst').value, 10);
    if (isNaN(burst) || burst < 1) {
      UI.setFieldError('in-burst', '≥ 1');
      UI.toast('Burst mínimo 1', 'err'); bad = true;
    }
    const arrival = parseInt($('in-arrival').value, 10);
    if (isNaN(arrival) || arrival < 0) {
      UI.setFieldError('in-arrival', '≥ 0');
      UI.toast('Arrival no puede ser negativo', 'err'); bad = true;
    }
    const threads = Math.max(1, Math.min(8, parseInt($('in-threads').value, 10) || 1));
    const forks   = Math.max(0, Math.min(5, parseInt($('in-forks').value,   10) || 0));
    if (bad) return;

    processList.push({
      pid, arrival, burst,
      priority:   parseInt($('in-priority').value, 10) || 0,
      pages:      Math.max(0, parseInt($('in-pages').value, 10) || 0),
      affinity:   [],
      queueLevel: Math.max(0, Math.min(2, parseInt($('in-queue').value, 10) || 0)),
      threads, forks
    });
    $('in-pid').value = '';
    renderProcessList();
    UI.toast(`Proceso ${pid} agregado`, 'ok', 1500);
  }

  function preloadDemo() {
    processList = [
      { pid:'P1', arrival:0, burst:6, priority:2, pages:3, affinity:[],     queueLevel:0, threads:1, forks:0 },
      { pid:'P2', arrival:1, burst:4, priority:1, pages:2, affinity:[],     queueLevel:1, threads:3, forks:0 },
      { pid:'P3', arrival:2, burst:8, priority:3, pages:4, affinity:[],     queueLevel:2, threads:1, forks:2 },
      { pid:'P4', arrival:3, burst:3, priority:2, pages:2, affinity:[],     queueLevel:0, threads:1, forks:0 },
      { pid:'P5', arrival:4, burst:5, priority:1, pages:3, affinity:[],     queueLevel:1, threads:2, forks:0 },
      { pid:'P6', arrival:5, burst:7, priority:2, pages:4, affinity:[],     queueLevel:2, threads:1, forks:1 },
      { pid:'P7', arrival:6, burst:2, priority:1, pages:1, affinity:[],     queueLevel:0, threads:1, forks:0 },
      { pid:'P8', arrival:7, burst:4, priority:3, pages:2, affinity:[],     queueLevel:1, threads:1, forks:0 }
    ];
    renderProcessList();
  }
  function preloadDemoToast() {
    preloadDemo();
    UI.toast('Demo cargada (8 procesos, mezcla con threads y forks)', 'ok', 2000);
  }

  function genHighLoad() {
    processList = [];
    for (let i = 1; i <= 30; i++) {
      processList.push({
        pid: 'P' + i,
        arrival:  Math.floor(Math.random() * 10),
        burst:    1 + Math.floor(Math.random() * 9),
        priority: 1 + Math.floor(Math.random() * 3),
        pages:    1 + Math.floor(Math.random() * 5),
        affinity: [],
        queueLevel: Math.floor(Math.random() * 3),
        threads: 1, forks: 0
      });
    }
    renderProcessList();
    UI.toast('30 procesos cargados (alta carga)', 'ok');
  }

  function genHighConcurrency() {
    processList = [];
    for (let i = 1; i <= 20; i++) {
      processList.push({
        pid: 'P' + i,
        arrival:  Math.floor(i / 4),
        burst:    3 + Math.floor(Math.random() * 6),
        priority: 1 + Math.floor(Math.random() * 3),
        pages:    2 + Math.floor(Math.random() * 4),
        affinity: [],
        queueLevel: Math.floor(Math.random() * 3),
        threads: i % 4 === 0 ? 2 : 1,
        forks:   i % 5 === 0 ? 1 : 0
      });
    }
    $('in-cores').value = 8;
    renderProcessList();
    UI.toast('20 procesos · algunos con threads/forks · 8 cores', 'ok');
  }

  // ============================================================
  // COLORES
  // ============================================================
  const _palette = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
                    '#1abc9c','#e67e22','#34495e','#16a085','#c0392b'];
  const _colorCache = {};
  function colorFor(key) {
    // Color por basePid (familia): los threads y forks de P1 comparten paleta.
    if (!key) return '#888';
    const family = key.split(/[\.a-z]/)[0]; // "P1.t0" → "P1"; "P1a" → "P1"
    if (!_colorCache[family])
      _colorCache[family] = _palette[Object.keys(_colorCache).length % _palette.length];
    return _colorCache[family];
  }

  // ============================================================
  // SCHEDULING
  // ============================================================
  function startScheduling() {
    if (processList.length === 0) {
      UI.toast('Agrega al menos un proceso primero', 'err');
      UI.activateTab('procesos'); return;
    }

    const numCores = Math.max(1, parseInt($('in-cores').value, 10) || 1);
    const quantum  = Math.max(1, parseInt($('in-quantum').value, 10) || 3);
    const algo     = $('in-algo').value;

    // Expandir threads + forks → lista real.
    const executables = window.expandExecutables(processList);
    if (executables.length !== processList.length) {
      UI.toast(`${processList.length} procesos declarados → ${executables.length} ejecutables`, 'info', 2500);
    }

    // Heurística de aviso.
    if ((algo === 'MLQ' || algo === 'MLFQ') && executables.every(p => (p.queueLevel || 0) === 0)) {
      UI.toast(`${algo} usa colas 0–2, pero todos están en cola 0. La diferencia será mínima.`, 'warn', 4500);
    }

    // Limpiar sesión previa.
    if (sched.pool) sched.pool.destroy();
    window.__poolCoresCount = numCores;
    doomLastTick = 0; doomCtxLast = 0; doomIntermissionShown = false;

    sched.pool = new CorePool(numCores, TICK_MS, (msg) => {
      sched.scheduler.handleWorkerEvent(msg);
      refreshScheduling();
    });
    sched.scheduler = new Scheduler({
      pool: sched.pool, algorithm: algo, quantum,
      tickMs: TICK_MS, onUpdate: refreshScheduling
    });
    executables.forEach(p => sched.scheduler.addProcess(p));

    // Wrap onUpdate para detectar fin y mostrar confetti.
    const origOnUpdate = sched.scheduler.onUpdate;
    let endNotified = false;
    sched.scheduler.onUpdate = () => {
      origOnUpdate();
      if (!endNotified && !sched.scheduler.isRunning() && sched.scheduler.now > 0) {
        const allDone = [...sched.scheduler.processes.values()].every(p => p.state === 'TERMINATED');
        if (allDone) {
          endNotified = true;
          if (!(window.DoomArena && DoomArena.isActive())) {
            UI.confetti();
            UI.toast(`🎉 Scheduling completo en ${sched.scheduler.now} ut`, 'ok', 4000);
          }
        }
      }
    };

    sched.scheduler.start();
    refreshScheduling();
    UI.activateTab('sched');
    UI.toast('Scheduling iniciado', 'info', 1500);

    // expose for console debug
    window.__sched = sched;
  }

  function pauseScheduling()  { if (sched.scheduler) sched.scheduler.pause(); }
  function resumeScheduling() { if (sched.scheduler && !sched.scheduler.isRunning()) sched.scheduler.start(); }
  function resetScheduling() {
    if (sched.scheduler) sched.scheduler.pause();
    if (sched.pool) sched.pool.destroy();
    sched.pool = null; sched.scheduler = null;
    doomLastTick = 0; doomCtxLast = 0; doomIntermissionShown = false;
    window.__poolCoresCount = parseInt($('in-cores').value, 10) || 4;
    if (window.DoomArena && DoomArena.isActive()) DoomArena.resetForNewSim();
    const interm = $('doom-intermission'); if (interm) interm.style.display = 'none';
    refreshScheduling();
    $('clock').textContent = '0';
  }

  function refreshScheduling() {
    renderCores(); renderGantt(); renderReadyTokens();
    renderSchedState(); lightStateDiagram(); refreshDoom();
  }

  function renderCores() {
    const wrap = $('cores');
    wrap.innerHTML = '';
    if (!sched.pool) return;
    for (const c of sched.pool.cores) {
      const div = document.createElement('div');
      div.className = 'core ' + (c.busy ? 'core-busy' : 'core-idle');
      div.innerHTML = `<div class="core-title">Core ${c.id}</div>
                       <div class="core-pid">${c.pid || '—'}</div>
                       <div class="core-rem">${c.busy ? 'rem ' + c.remaining : 'idle'}</div>`;
      wrap.appendChild(div);
    }
  }

  function renderGantt() {
    const svg = $('gantt');
    if (!svg) return;
    svg.innerHTML = '';
    if (!sched.scheduler) return;
    const cores = sched.pool.cores.length;
    const rowH = 30, pad = 60;
    const maxTime = Math.max(sched.scheduler.now, 10);
    const unit = Math.max(8, Math.floor((svg.clientWidth - pad - 20) / maxTime));

    for (let t = 0; t <= maxTime; t++) {
      const x = pad + t * unit;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', 10); line.setAttribute('y2', 10 + cores * rowH);
      line.setAttribute('stroke', '#eee');
      svg.appendChild(line);
      if (t % 5 === 0) {
        const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        txt.setAttribute('x', x); txt.setAttribute('y', 10 + cores * rowH + 14);
        txt.setAttribute('font-size', '10'); txt.setAttribute('fill', '#666');
        txt.textContent = t;
        svg.appendChild(txt);
      }
    }
    for (let c = 0; c < cores; c++) {
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', 4); txt.setAttribute('y', 10 + c * rowH + 20);
      txt.setAttribute('font-size', '12'); txt.setAttribute('fill', '#333');
      txt.textContent = `Core ${c}`;
      svg.appendChild(txt);
    }
    const drawSeg = (coreId, pid, start, end) => {
      const x = pad + start * unit, w = (end - start) * unit;
      const y = 10 + coreId * rowH;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', Math.max(1, w)); rect.setAttribute('height', rowH - 4);
      rect.setAttribute('fill', colorFor(pid));
      rect.setAttribute('stroke', '#222');
      svg.appendChild(rect);
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', x + 3); txt.setAttribute('y', y + 17);
      txt.setAttribute('font-size', '11'); txt.setAttribute('fill', '#fff');
      txt.textContent = pid;
      svg.appendChild(txt);
    };
    sched.scheduler.gantt.forEach(g => drawSeg(g.coreId, g.pid, g.start, g.end));
    sched.scheduler.activeSegments.forEach((seg, coreId) =>
      drawSeg(coreId, seg.pid, seg.start, sched.scheduler.now));
    svg.setAttribute('height', cores * rowH + 30);
  }

  function renderReadyTokens() {
    const wrap = $('ready-tokens');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!sched.scheduler || sched.scheduler.ready.length === 0) {
      wrap.innerHTML = '<span class="ready-empty">— cola vacía —</span>';
      return;
    }
    for (const p of sched.scheduler.ready) {
      const tok = document.createElement('span');
      tok.className = 'ready-token';
      tok.style.background = colorFor(p.pid);
      tok.innerHTML = `${p.pid} <small>${p.remaining}t</small>`;
      wrap.appendChild(tok);
    }
  }

  function renderSchedState() {
    if (!sched.scheduler) return;
    $('clock').textContent = sched.scheduler.now;

    const m = sched.scheduler.metrics();
    $('metric-tat').textContent = m.avgTat;
    $('metric-wait').textContent = m.avgWait;
    $('metric-resp').textContent = m.avgResp;
    $('metric-cpu').textContent = m.cpuUtil + '%';
    $('metric-cs').textContent = m.contextSwitches;
    $('metric-th').textContent = m.throughput;
    $('metric-done').textContent = m.completed + '/' + m.total;
    $('metric-speedup').textContent = m.speedup;
    renderPerCore(m.perCore);

    const metricsByPid = new Map(m.rows.map(r => [r.pid, r]));
    const tbody = $('state-table');
    if (tbody) {
      tbody.innerHTML = '';
      for (const p of sched.scheduler.processes.values()) {
        const r = metricsByPid.get(p.pid) || {};
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${p.pid}</td>
          <td class="state-${p.state}">${p.state}</td>
          <td>${p.remaining}</td>
          <td>${p.burst}</td>
          <td>${p.arrival}</td>
          <td>${r.completion ?? '—'}</td>
          <td>${r.tat ?? '—'}</td>
          <td>${r.wait ?? '—'}</td>
          <td>${r.response ?? '—'}</td>`;
        tbody.appendChild(tr);
      }
    }
  }

  function renderPerCore(perCore) {
    const wrap = $('per-core');
    wrap.innerHTML = '';
    if (!perCore) return;
    for (const c of perCore) {
      const card = document.createElement('div');
      card.className = 'percore-card';
      const utilNum = parseFloat(c.util);
      card.innerHTML = `
        <div class="percore-head">
          <strong>Core ${c.coreId}</strong>
          <span class="percore-now">${c.currentPid || 'idle'}</span>
        </div>
        <div class="percore-bar">
          <div class="percore-fill" style="width:${utilNum}%"></div>
          <span class="percore-pct">${c.util}%</span>
        </div>
        <div class="percore-stats">
          busy ${c.busy} · idle ${c.idle} · procs ${c.processes}
        </div>`;
      wrap.appendChild(card);
    }
  }

  function lightStateDiagram() {
    if (!sched.scheduler) {
      document.querySelectorAll('.state-node').forEach(n => {
        n.className = 'state-node';
      });
      return;
    }
    const has = { NEW: false, READY: false, RUNNING: false, WAITING: false, TERMINATED: false };
    for (const p of sched.scheduler.processes.values()) has[p.state] = true;
    document.querySelectorAll('.state-node').forEach(n => {
      const s = n.dataset.state;
      n.classList.toggle('lit-' + s, !!has[s]);
    });
  }

  // ============================================================
  // PAGINACIÓN
  // ============================================================
  function startPaging() {
    if (processList.length === 0) {
      UI.toast('Agrega al menos un proceso primero', 'err');
      UI.activateTab('procesos'); return;
    }

    const memorySize = Math.max(4, parseInt($('in-mem-size').value, 10) || 64);
    const pageSize   = Math.max(1, parseInt($('in-page-size').value, 10) || 4);
    const algorithm  = $('in-mem-algo').value;

    const executables = window.expandExecutables(processList);
    const totalPagesNeeded = executables.reduce((s, p) => s + (p.pages || 0), 0);
    const numFrames = Math.floor(memorySize / pageSize);
    if (totalPagesNeeded > numFrames * 3) {
      UI.toast(`Memoria pequeña: ${totalPagesNeeded} páginas demandadas vs ${numFrames} frames. Esperá muchos faults.`, 'warn', 4500);
    }

    paging.memory = new MemoryManager({ memorySize, pageSize, algorithm });
    executables.forEach(p => paging.memory.registerProcess(p));

    paging.simulator = new PagingSimulator({
      executables, memory: paging.memory, tickMs: TICK_MS,
      onUpdate: refreshPaging
    });
    doomLastFaults = 0;
    paging.simulator.start();
    refreshPaging();
    UI.activateTab('paging');
    UI.toast('Paginación iniciada', 'info', 1500);

    window.__paging = paging;
  }

  function pausePaging()  { if (paging.simulator) paging.simulator.pause(); }
  function resumePaging() { if (paging.simulator && !paging.simulator.isRunning()) paging.simulator.start(); }
  function resetPaging() {
    if (paging.simulator) paging.simulator.pause();
    paging.memory = null; paging.simulator = null;
    refreshPaging();
  }

  function refreshPaging() {
    renderMemory(); renderPageTable();
  }

  function renderMemory() {
    const wrap = $('mem-frames');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!paging.memory) {
      // Preview cuando no hay simulación.
      const memSize  = parseInt($('in-mem-size').value, 10) || 64;
      const pageSize = parseInt($('in-page-size').value, 10) || 4;
      const numFrames = Math.max(1, Math.floor(memSize / pageSize));
      for (let i = 0; i < numFrames; i++) {
        const div = document.createElement('div');
        div.className = 'frame frame-empty';
        div.innerHTML = `<div class="frame-idx">F${i}</div>
                         <div class="frame-empty-lbl">libre</div>`;
        wrap.appendChild(div);
      }
      $('mem-algo').textContent = $('in-mem-algo').value;
      $('mem-faults').textContent = '0';
      $('mem-hits').textContent = '0';
      $('mem-fault-rate').textContent = '0%';
      $('mem-frag').textContent = '0';
      $('mem-used').textContent = `0/${numFrames}`;
      const ev = $('mem-last-event');
      if (ev) {
        ev.textContent = '— Inicia la simulación para ver actividad —';
        ev.className = 'mem-event';
      }
      return;
    }

    const last = paging.memory.lastEvent;
    paging.memory.frames.forEach((f, idx) => {
      const div = document.createElement('div');
      div.className = 'frame ' + (f ? 'frame-used' : 'frame-empty');
      if (last && last.frame === idx) {
        div.classList.add(last.type === 'fault' ? 'frame-fault' : 'frame-hit');
      }
      div.innerHTML = `
        <div class="frame-idx">F${idx}</div>
        ${f
          ? `<div class="frame-pid" style="background:${colorFor(f.owner)}">${f.owner}</div>
             <div class="frame-page">pg ${f.page}</div>
             <div class="frame-bit">R=${f.refBit}</div>`
          : `<div class="frame-empty-lbl">libre</div>`}
      `;
      wrap.appendChild(div);
    });

    const s = paging.memory.summary();
    $('mem-algo').textContent = s.algorithm;
    $('mem-faults').textContent = s.faults;
    $('mem-hits').textContent = s.hits;
    $('mem-fault-rate').textContent = s.faultRate + '%';
    $('mem-frag').textContent = s.intFrag;
    $('mem-used').textContent = s.framesUsed + '/' + s.framesTotal;

    const ev = paging.memory.lastEvent;
    if (ev) {
      const evicted = ev.evicted ? ` (sale ${ev.evicted.owner}:p${ev.evicted.page})` : '';
      $('mem-last-event').textContent =
        `t=${ev.t} · ${ev.type === 'fault' ? '⚠ FAULT' : '✓ HIT'} · ${ev.owner}:p${ev.page} → F${ev.frame}${evicted}`;
      $('mem-last-event').className = 'mem-event ' + (ev.type === 'fault' ? 'mem-event-fault' : 'mem-event-hit');
    }
  }

  function renderPageTable() {
    const tb = $('page-table');
    if (!tb) return;
    tb.innerHTML = '';
    if (!paging.memory) return;
    for (const row of paging.memory.pageTable()) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.owner}</td><td>${row.page}</td>
                      <td>${row.frame == null ? '—' : 'F' + row.frame}</td>
                      <td>${row.valid ? '✓' : '—'}</td>
                      <td>${row.ref}</td>`;
      tb.appendChild(tr);
    }
  }

  // ============================================================
  // DOOM HUD/ARENA INTEGRATION
  // ============================================================
  function pidColorIdx(pid) {
    if (!pid) return 0;
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) | 0;
    return Math.abs(h) % 6;
  }

  function refreshDoom() {
    if (!window.DoomHUD) return;
    if (!sched.scheduler) {
      DoomHUD.renderEmpty();
      if (window.DoomArena && DoomArena.isActive()) DoomArena.update([], 0);
      doomLastFaults = 0;
      return;
    }
    const m = sched.scheduler.metrics();
    const memSum = paging.memory
      ? paging.memory.summary()
      : { framesUsed: 0, framesTotal: 1, faultRate: 0, faults: 0 };
    const memFree = memSum.framesTotal === 0 ? 100
      : 100 * (1 - memSum.framesUsed / memSum.framesTotal);

    if (window.DoomArena && DoomArena.isActive() && memSum.faults > doomLastFaults) {
      DoomArena.reportPageFault();
    }
    doomLastFaults = memSum.faults;

    const dt = Math.max(1, sched.scheduler.now - doomLastTick);
    const ctxRate = (m.contextSwitches - doomCtxLast) / dt;
    doomLastTick = sched.scheduler.now;
    doomCtxLast = m.contextSwitches;

    const cores = sched.pool ? sched.pool.cores.length : 0;
    const allDone = sched.scheduler.processes.size > 0 &&
      [...sched.scheduler.processes.values()].every(p => p.state === 'TERMINATED');

    DoomHUD.render({
      hasSim: true,
      running: sched.pool ? sched.pool.cores.filter(c => c.busy).length : 0,
      cpuUtil: parseFloat(m.cpuUtil),
      memFree,
      faultRate: parseFloat(memSum.faultRate),
      ctxPerTick: ctxRate,
      readyOver: sched.scheduler.ready.length - cores,
      ready: sched.scheduler.ready.length,
      kills: parseInt(m.completed),
      total: m.total,
      algo: sched.scheduler.algorithm,
      quantum: ['RR','MLQ','MLFQ'].includes(sched.scheduler.algorithm) ? sched.scheduler.quantum : null,
      cores, now: sched.scheduler.now, allDone
    });

    if (window.DoomArena && DoomArena.isActive() && sched.pool) {
      window.__poolCoresCount = sched.pool.cores.length;
      const coreData = sched.pool.cores.map(c => {
        const proc = c.pid ? sched.scheduler.processes.get(c.pid) : null;
        return {
          id: c.id, pid: c.pid,
          remaining: proc ? proc.remaining : 0,
          burst: proc ? proc.burst : 0,
          queueLevel: proc ? (proc.queueLevel || 0) : 0,
          color: pidColorIdx(c.pid)
        };
      });
      DoomArena.update(coreData, sched.scheduler.now);
    }

    // Intermission con delay solo si la sim termina en Doom mode.
    if (allDone && !doomIntermissionShown) {
      doomIntermissionShown = true;
      if (window.DoomArena && DoomArena.isActive()) {
        const stats = {
          algo: sched.scheduler.algorithm,
          kills: parseInt(m.completed),
          total: m.total,
          time: sched.scheduler.now,
          avgTat: m.avgTat,
          avgWait: m.avgWait,
          cpuUtil: m.cpuUtil,
          faults: memSum.faults,
          ctx: m.contextSwitches
        };
        const ganttHTML = buildIntermissionGantt();
        setTimeout(() => {
          if (DoomArena.isActive()) DoomArena.showIntermission(stats, ganttHTML);
        }, 1500);
      }
    }
  }

  function buildIntermissionGantt() {
    if (!sched.scheduler || !sched.pool) return '';
    const cores = sched.pool.cores.length;
    const rowH = 24, pad = 56, labelPad = 6;
    const maxTime = Math.max(sched.scheduler.now, 10);
    const unit = 28;
    const w = pad + maxTime * unit + 12;
    const h = cores * rowH + 28;

    const allSegs = [...sched.scheduler.gantt];
    sched.scheduler.activeSegments.forEach((seg, coreId) => {
      allSegs.push({ coreId, pid: seg.pid, start: seg.start, end: sched.scheduler.now });
    });

    let parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet" style="width:100%;height:auto;display:block;background:#0a0a0e">`);
    for (let t = 0; t <= maxTime; t++) {
      const x = pad + t * unit;
      parts.push(`<line x1="${x}" y1="4" x2="${x}" y2="${4 + cores * rowH}" stroke="#222" stroke-width="1"/>`);
      if (t % 5 === 0) {
        parts.push(`<text x="${x}" y="${4 + cores * rowH + 14}" font-size="10" fill="#888" text-anchor="middle" font-family="monospace">${t}</text>`);
      }
    }
    for (let c = 0; c < cores; c++) {
      parts.push(`<text x="${labelPad}" y="${4 + c * rowH + 16}" font-size="11" fill="#bbb" font-family="monospace">Core ${c}</text>`);
    }
    for (const g of allSegs) {
      const x = pad + g.start * unit;
      const segW = Math.max(2, (g.end - g.start) * unit);
      const y = 4 + g.coreId * rowH;
      const color = colorFor(g.pid);
      parts.push(`<rect x="${x}" y="${y}" width="${segW}" height="${rowH - 4}" fill="${color}" stroke="#000" stroke-width="1"/>`);
      parts.push(`<text x="${x + 4}" y="${y + 14}" font-size="10" fill="#fff" font-family="monospace" font-weight="bold">${g.pid}</text>`);
    }
    parts.push('</svg>');
    return parts.join('');
  }

  // ============================================================
  // COMPARACIONES (usan FastSim sobre la lista expandida)
  // ============================================================
  const ALL_SCHED = ['FCFS','SJF','HRRN','PRIO','RR','SRTF','PRIO_P','MLQ','MLFQ'];
  const ALL_MEM   = ['FIFO','LRU','OPT','CLOCK','SC'];
  const ALL_CORES = [1, 2, 4, 8];
  const MEM_SIZES = [16, 32, 64, 128];

  function currentConfig() {
    return {
      processes: window.expandExecutables(processList),
      numCores:   Math.max(1, parseInt($('in-cores').value, 10) || 1),
      quantum:    Math.max(1, parseInt($('in-quantum').value, 10) || 3),
      memorySize: Math.max(4, parseInt($('in-mem-size').value, 10) || 64),
      pageSize:   Math.max(1, parseInt($('in-page-size').value, 10) || 4),
      memAlgo:    $('in-mem-algo').value,
      algorithm:  $('in-algo').value
    };
  }

  function noProcsGuard() {
    if (processList.length === 0) {
      UI.toast('Agrega procesos antes de comparar', 'err');
      UI.activateTab('procesos'); return true;
    }
    return false;
  }

  function compareScheduling() {
    if (noProcsGuard()) return;
    const base = currentConfig();
    const rows = ALL_SCHED.map(a => window.FastSim.runFast({ ...base, algorithm: a }));
    renderComparison('Scheduling — ' + base.memAlgo + ' / ' + base.numCores + ' cores',
      rows, 'algorithm', 'avgTat', 'Avg Turnaround');
  }
  function compareMemory() {
    if (noProcsGuard()) return;
    const base = currentConfig();
    const rows = ALL_MEM.map(m => window.FastSim.runFast({ ...base, memAlgo: m }));
    renderComparison('Memoria — ' + base.algorithm + ' / mem=' + base.memorySize,
      rows, 'memAlgo', 'pageFaults', 'Page Faults');
  }
  function compareCores() {
    if (noProcsGuard()) return;
    const base = currentConfig();
    const rows = ALL_CORES.map(n => window.FastSim.runFast({ ...base, numCores: n }));
    renderComparison('Cores — ' + base.algorithm,
      rows, 'numCores', 'time', 'Tiempo total');
  }
  function compareMemorySizes() {
    if (noProcsGuard()) return;
    const base = currentConfig();
    const rows = MEM_SIZES.map(m => window.FastSim.runFast({ ...base, memorySize: m }));
    rows.forEach((r, i) => r.memorySize = MEM_SIZES[i]);
    renderComparison('Tamaño de memoria — ' + base.algorithm + ' / ' + base.memAlgo,
      rows, 'memorySize', 'pageFaults', 'Page Faults');
  }

  function renderComparison(title, rows, labelKey, chartKey, chartLabel) {
    const wrap = $('cmp-result');
    wrap.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = title;
    wrap.appendChild(h);

    const tbl = document.createElement('table');
    tbl.className = 'data small';
    tbl.innerHTML = `<thead><tr>
      <th>${labelKey}</th><th>Tiempo</th><th>Avg TAT</th><th>Avg WT</th>
      <th>Avg RT</th><th>CPU%</th><th>Throughput</th>
      <th>Ctx Sw</th><th>Faults</th><th>Tasa</th>
    </tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    let bestIdx = 0;
    rows.forEach((r, i) => { if (r[chartKey] < rows[bestIdx][chartKey]) bestIdx = i; });
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i === bestIdx) tr.className = 'cmp-best';
      tr.innerHTML = `
        <td><strong>${r[labelKey]}</strong></td>
        <td>${r.time}</td><td>${r.avgTat}</td><td>${r.avgWait}</td>
        <td>${r.avgResp}</td><td>${r.cpuUtil}%</td><td>${r.throughput}</td>
        <td>${r.contextSwitches}</td><td>${r.pageFaults}</td><td>${r.faultRate}%</td>`;
      tb.appendChild(tr);
    });
    wrap.appendChild(tbl);

    const max = Math.max(...rows.map(r => r[chartKey]), 1);
    const chartH = 160, barW = 50, gap = 16, pad = 40;
    const w = pad + rows.length * (barW + gap);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', chartH + 30);
    svg.setAttribute('class', 'cmp-chart');
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', 4); lbl.setAttribute('y', 12);
    lbl.setAttribute('font-size', '11'); lbl.setAttribute('fill', '#666');
    lbl.textContent = chartLabel + ' (menor = mejor)';
    svg.appendChild(lbl);
    rows.forEach((r, i) => {
      const v = r[chartKey];
      const h = max === 0 ? 0 : (v / max) * chartH;
      const x = pad + i * (barW + gap);
      const y = chartH - h + 14;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', barW); rect.setAttribute('height', h);
      rect.setAttribute('fill', i === bestIdx ? '#16a085' : '#3498db');
      svg.appendChild(rect);
      const v1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      v1.setAttribute('x', x + barW/2); v1.setAttribute('y', y - 3);
      v1.setAttribute('text-anchor', 'middle');
      v1.setAttribute('font-size', '11'); v1.setAttribute('fill', '#222');
      v1.textContent = v;
      svg.appendChild(v1);
      const v2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      v2.setAttribute('x', x + barW/2); v2.setAttribute('y', chartH + 28);
      v2.setAttribute('text-anchor', 'middle');
      v2.setAttribute('font-size', '11'); v2.setAttribute('fill', '#444');
      v2.textContent = r[labelKey];
      svg.appendChild(v2);
    });
    wrap.appendChild(svg);
    UI.toast(`Mejor: ${rows[bestIdx][labelKey]} (${chartLabel.toLowerCase()} = ${rows[bestIdx][chartKey]})`, 'ok', 3000);
  }

  // ============================================================
  // FILE LOADER
  // ============================================================
  function parseConfigFile(text) {
    const procs = [];
    let mem = null, ps = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^Memoria\s*=/i.test(line))   { mem = parseInt(line.split('=')[1], 10); continue; }
      if (/^PageSize\s*=/i.test(line))  { ps  = parseInt(line.split('=')[1], 10); continue; }
      if (/^Frames\s*=/i.test(line))    { continue; }
      if (/^pid/i.test(line)) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 5) continue;
      const [pid, arr, bur, pri, pg, q, t, f] = parts;
      procs.push({
        pid: String(pid),
        arrival: parseInt(arr, 10) || 0,
        burst: Math.max(1, parseInt(bur, 10) || 1),
        priority: parseInt(pri, 10) || 0,
        pages: Math.max(0, parseInt(pg, 10) || 0),
        affinity: [],
        queueLevel: Math.max(0, Math.min(2, parseInt(q, 10) || 0)),
        threads: Math.max(1, Math.min(8, parseInt(t, 10) || 1)),
        forks:   Math.max(0, Math.min(5, parseInt(f, 10) || 0))
      });
    }
    return { procs, mem, pageSize: ps };
  }

  function loadFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const cfg = parseConfigFile(reader.result);
      if (cfg.procs.length) {
        processList = cfg.procs;
        renderProcessList();
      }
      if (cfg.mem)      { $('in-mem-size').value = cfg.mem; }
      if (cfg.pageSize) { $('in-page-size').value = cfg.pageSize; }
      refreshFramesLabel();
      refreshPaging();
      UI.toast(`Cargados ${cfg.procs.length} procesos`
        + (cfg.mem ? ` · memoria=${cfg.mem}` : '')
        + (cfg.pageSize ? ` · pageSize=${cfg.pageSize}` : ''),
        cfg.procs.length > 0 ? 'ok' : 'warn');
    };
    reader.readAsText(file);
  }

  // ============================================================
  // UTILS
  // ============================================================
  function refreshFramesLabel() {
    const m = parseInt($('in-mem-size').value, 10) || 0;
    const p = parseInt($('in-page-size').value, 10) || 1;
    $('lbl-frames').textContent = Math.max(1, Math.floor(m / p));
  }

  function updateAlgoUI() {
    const algo = $('in-algo').value;
    const needsQuantum = ['RR', 'MLQ', 'MLFQ'].includes(algo);
    const needsQueue   = ['MLQ', 'MLFQ'].includes(algo);
    $('lbl-quantum').style.display = needsQuantum ? '' : 'none';
    $('lbl-queue').style.display   = needsQueue   ? '' : 'none';
    document.body.classList.toggle('show-queue', needsQueue);
  }
  // Alias por compatibilidad con el wire-up antiguo si se llama.
  const toggleQuantum = updateAlgoUI;

  // ============================================================
  // WIRE-UP
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    UI.initTabs();
    UI.initTooltips();
    UI.showTutorial(false);

    if ($('btn-tutorial')) $('btn-tutorial').onclick = () => UI.showTutorial(true);
    if ($('btn-show-tutorial')) $('btn-show-tutorial').onclick = () => UI.showTutorial(true);

    // Doom mode toggle
    if ($('btn-doom') && window.DoomArena) {
      $('btn-doom').onclick = () => {
        const next = !DoomArena.isActive();
        DoomArena.setActive(next);
        $('btn-doom').classList.toggle('active', next);
        UI.toast(next ? '🔥 Doom mode: ON' : 'Doom mode: OFF', 'info', 1400);
        refreshScheduling();
      };
    }
    if (window.DoomHUD) DoomHUD.renderEmpty();

    // Procesos
    $('btn-add').onclick = addProcessFromForm;
    $('btn-preload').onclick = preloadDemoToast;
    $('btn-scn-load').onclick = genHighLoad;
    $('btn-scn-conc').onclick = genHighConcurrency;
    $('btn-scn-clear').onclick = () => {
      if (processList.length === 0) { UI.toast('La lista ya está vacía', 'info', 1200); return; }
      const n = processList.length;
      processList = []; renderProcessList();
      UI.toast(`${n} procesos eliminados`, 'info', 1500);
    };

    // Scheduling controls
    $('btn-sched-start').onclick = startScheduling;
    $('btn-sched-pause').onclick = pauseScheduling;
    $('btn-sched-resume').onclick = resumeScheduling;
    $('btn-sched-reset').onclick = resetScheduling;

    // Paging controls
    $('btn-paging-start').onclick = startPaging;
    $('btn-paging-pause').onclick = pausePaging;
    $('btn-paging-resume').onclick = resumePaging;
    $('btn-paging-reset').onclick = resetPaging;

    // Comparaciones
    $('btn-cmp-sched').onclick = compareScheduling;
    $('btn-cmp-mem').onclick = compareMemory;
    $('btn-cmp-cores').onclick = compareCores;
    $('btn-cmp-mem-size').onclick = compareMemorySizes;

    // Inputs
    $('in-algo').addEventListener('change', toggleQuantum);
    $('in-mem-size').addEventListener('input', () => { refreshFramesLabel(); refreshPaging(); });
    $('in-page-size').addEventListener('input', () => { refreshFramesLabel(); refreshPaging(); });
    $('in-mem-algo').addEventListener('change', refreshPaging);
    $('in-cores').addEventListener('input', () => {
      window.__poolCoresCount = parseInt($('in-cores').value, 10) || 4;
    });
    $('in-file').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (f) loadFromFile(f);
    });

    // Speed slider
    if ($('speed-slider')) {
      $('speed-slider').addEventListener('input', (e) => {
        const lvl = parseInt(e.target.value, 10) || 3;
        TICK_MS = SPEED_MS[lvl] || 250;
        if (sched.pool) sched.pool.setTickMs(TICK_MS);
        if (sched.scheduler) sched.scheduler.setTickMs(TICK_MS);
        if (paging.simulator) paging.simulator.setTickMs(TICK_MS);
      });
    }

    toggleQuantum();
    refreshFramesLabel();
    renderProcessList();
    refreshScheduling();
    refreshPaging();
  });
})();
