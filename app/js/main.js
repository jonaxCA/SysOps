// Main entry — wires the UI to CorePool + Scheduler.

(function () {
  // Slider 1..5 → ms por tick (mayor = más lento, menor = más rápido).
  const SPEED_MS = { 1: 600, 2: 400, 3: 250, 4: 150, 5: 80 };
  let TICK_MS = 250;

  let pool = null;
  let scheduler = null;
  let memory = null;
  let processList = [];

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);

  // ---------- Process list ----------
  function renderProcessList() {
    window.__processList = processList; // expuesto para fork-client.js
    const tbody = $('process-list');
    tbody.innerHTML = '';
    for (const p of processList) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.pid}</td><td>${p.arrival}</td><td>${p.burst}</td>
                      <td>${p.priority}</td><td>${p.pages}</td>
                      <td>${(p.affinity || []).join(',') || 'any'}</td>
                      <td>${p.queueLevel ?? 0}</td>
                      <td><button data-pid="${p.pid}" class="del-proc danger" data-tip="Eliminar">×</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.del-proc').forEach(btn => {
      btn.onclick = () => {
        processList = processList.filter(p => p.pid !== btn.dataset.pid);
        renderProcessList();
        UI.toast(`Proceso ${btn.dataset.pid} eliminado`, 'info', 1800);
      };
    });
    const cnt = $('proc-count'); if (cnt) cnt.textContent = processList.length;
    refreshStartButton();
  }

  function refreshStartButton() {
    if (!UI || !UI.setBtnReason) return;
    if (processList.length === 0) {
      UI.setBtnReason('btn-start', 'Agrega al menos un proceso primero');
    } else {
      UI.setBtnReason('btn-start', null);
    }
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
    if (bad) return;

    const affRaw = $('in-affinity').value.trim();
    const affinity = affRaw ? affRaw.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [];
    processList.push({
      pid,
      arrival,
      burst,
      priority:   parseInt($('in-priority').value, 10) || 0,
      pages:      Math.max(0, parseInt($('in-pages').value, 10) || 0),
      affinity,
      queueLevel: Math.max(0, Math.min(2, parseInt($('in-queue').value, 10) || 0))
    });
    $('in-pid').value = '';
    renderProcessList();
    UI.toast(`Proceso ${pid} agregado`, 'ok', 1500);
  }

  function preloadDemo() {
    processList = [
      { pid: 'P1', arrival: 0, burst: 6, priority: 2, pages: 3, affinity: [],     queueLevel: 0 },
      { pid: 'P2', arrival: 1, burst: 4, priority: 1, pages: 2, affinity: [],     queueLevel: 1 },
      { pid: 'P3', arrival: 2, burst: 8, priority: 3, pages: 4, affinity: [],     queueLevel: 2 },
      { pid: 'P4', arrival: 3, burst: 3, priority: 2, pages: 2, affinity: [],     queueLevel: 0 },
      { pid: 'P5', arrival: 4, burst: 5, priority: 1, pages: 3, affinity: [0, 1], queueLevel: 1 },
      { pid: 'P6', arrival: 5, burst: 7, priority: 2, pages: 4, affinity: [],     queueLevel: 2 },
      { pid: 'P7', arrival: 6, burst: 2, priority: 1, pages: 1, affinity: [],     queueLevel: 0 },
      { pid: 'P8', arrival: 7, burst: 4, priority: 3, pages: 2, affinity: [],     queueLevel: 1 }
    ];
    renderProcessList();
  }

  // ---------- Render simulation state ----------
  function renderCores() {
    const wrap = $('cores');
    wrap.innerHTML = '';
    if (!pool) return;
    for (const c of pool.cores) {
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
    svg.innerHTML = '';
    if (!scheduler) return;
    const cores = pool.cores.length;
    const rowH = 30, pad = 60;
    const maxTime = Math.max(scheduler.now, 10);
    const unit = Math.max(8, Math.floor((svg.clientWidth - pad - 20) / maxTime));

    // axis
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

    // core labels
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

    scheduler.gantt.forEach(g => drawSeg(g.coreId, g.pid, g.start, g.end));
    scheduler.activeSegments.forEach((seg, coreId) =>
      drawSeg(coreId, seg.pid, seg.start, scheduler.now));

    svg.setAttribute('height', cores * rowH + 30);
  }

  const _palette = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
                    '#1abc9c','#e67e22','#34495e','#16a085','#c0392b'];
  const _colorCache = {};
  function colorFor(pid) {
    if (!_colorCache[pid])
      _colorCache[pid] = _palette[Object.keys(_colorCache).length % _palette.length];
    return _colorCache[pid];
  }

  function renderState() {
    if (!scheduler) return;

    $('clock').textContent = scheduler.now;
    $('queue-ready').textContent =
      scheduler.ready.map(p => p.pid).join(', ') || '—';

    const m = scheduler.metrics();
    $('metric-tat').textContent = m.avgTat;
    $('metric-wait').textContent = m.avgWait;
    $('metric-resp').textContent = m.avgResp;
    $('metric-cpu').textContent = m.cpuUtil + '%';
    $('metric-cs').textContent = m.contextSwitches;
    $('metric-th').textContent = m.throughput;
    $('metric-done').textContent = m.completed + '/' + m.total;
    $('metric-speedup').textContent = m.speedup;
    renderPerCore(m.perCore);

    // Fused state + per-process metrics into the single state-table
    // (PID | Estado | Restante | Burst | AT | CT | TAT | WT | RT).
    const metricsByPid = new Map(m.rows.map(r => [r.pid, r]));
    const tbody = $('state-table');
    if (tbody) {
      tbody.innerHTML = '';
      for (const p of scheduler.processes.values()) {
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

  function renderMemory() {
    const wrap = $('mem-frames');
    wrap.innerHTML = '';

    // Preview cuando no hay simulación: dibuja frames libres según config actual.
    if (!memory) {
      const memSize = parseInt($('in-mem-size').value, 10) || 64;
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
      ev.textContent = '— Inicia una simulación para ver actividad de memoria —';
      ev.className = 'mem-event';
      return;
    }
    const last = memory.lastEvent;
    memory.frames.forEach((f, idx) => {
      const div = document.createElement('div');
      div.className = 'frame ' + (f ? 'frame-used' : 'frame-empty');
      if (last && last.frame === idx) {
        div.classList.add(last.type === 'fault' ? 'frame-fault' : 'frame-hit');
      }
      div.innerHTML = `
        <div class="frame-idx">F${idx}</div>
        ${f
          ? `<div class="frame-pid" style="background:${colorFor(f.pid)}">${f.pid}</div>
             <div class="frame-page">pg ${f.page}</div>
             <div class="frame-bit">R=${f.refBit}</div>`
          : `<div class="frame-empty-lbl">libre</div>`}
      `;
      wrap.appendChild(div);
    });

    const s = memory.summary();
    $('mem-algo').textContent = s.algorithm;
    $('mem-faults').textContent = s.faults;
    $('mem-hits').textContent = s.hits;
    $('mem-fault-rate').textContent = s.faultRate + '%';
    $('mem-frag').textContent = s.intFrag;
    $('mem-used').textContent = s.framesUsed + '/' + s.framesTotal;

    const ev = memory.lastEvent;
    if (ev) {
      const evicted = ev.evicted ? ` (sale ${ev.evicted.pid}:p${ev.evicted.page})` : '';
      $('mem-last-event').textContent =
        `t=${ev.t} · ${ev.type === 'fault' ? '⚠ FAULT' : '✓ HIT'} · ${ev.pid}:p${ev.page} → F${ev.frame}${evicted}`;
      $('mem-last-event').className = 'mem-event ' + (ev.type === 'fault' ? 'mem-event-fault' : 'mem-event-hit');
    }
  }

  function renderPageTable() {
    const tb = $('page-table');
    tb.innerHTML = '';
    if (!memory) return;
    for (const row of memory.pageTable()) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.pid}</td><td>${row.page}</td>
                      <td>${row.frame == null ? '—' : 'F' + row.frame}</td>
                      <td>${row.valid ? '✓' : '—'}</td>
                      <td>${row.ref}</td>`;
      tb.appendChild(tr);
    }
  }

  function lightStateDiagram() {
    if (!scheduler) return;
    const has = { NEW: false, READY: false, RUNNING: false, WAITING: false, TERMINATED: false };
    for (const p of scheduler.processes.values()) has[p.state] = true;
    document.querySelectorAll('.state-node').forEach(n => {
      const s = n.dataset.state;
      n.classList.toggle('lit-' + s, !!has[s]);
    });
  }

  function refresh() {
    renderCores(); renderGantt(); renderState();
    renderMemory(); renderPageTable(); lightStateDiagram();
    refreshDoom();
  }

  // ----- Doom HUD + Arena snapshot -----
  let doomLastTick = 0, doomCtxLast = 0, doomLastFaults = 0;
  let doomIntermissionShown = false;

  function pidColorIdx(pid) {
    if (!pid) return 0;
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) | 0;
    return Math.abs(h) % 6;
  }

  function refreshDoom() {
    if (!window.DoomHUD) return;
    if (!scheduler) {
      DoomHUD.renderEmpty();
      if (window.DoomArena && DoomArena.isActive()) DoomArena.update([], 0);
      doomLastFaults = 0; doomIntermissionShown = false;
      return;
    }
    const m = scheduler.metrics();
    const memSum = memory ? memory.summary() : { framesUsed: 0, framesTotal: 1, faultRate: 0, faults: 0 };
    const memFree = memSum.framesTotal === 0 ? 100
      : 100 * (1 - memSum.framesUsed / memSum.framesTotal);

    // Detect new page faults since last refresh → marine takes damage.
    if (window.DoomArena && DoomArena.isActive() && memSum.faults > doomLastFaults) {
      DoomArena.reportPageFault();
    }
    doomLastFaults = memSum.faults;

    // ctx switches per tick (rate)
    const dt = Math.max(1, scheduler.now - doomLastTick);
    const ctxRate = (m.contextSwitches - doomCtxLast) / dt;
    doomLastTick = scheduler.now;
    doomCtxLast = m.contextSwitches;

    const cores = pool ? pool.cores.length : 0;
    const allDone = scheduler.processes.size > 0 &&
      [...scheduler.processes.values()].every(p => p.state === 'TERMINATED');

    DoomHUD.render({
      hasSim: true,
      running: pool ? pool.cores.filter(c => c.busy).length : 0,
      cpuUtil: parseFloat(m.cpuUtil),
      memFree,
      faultRate: parseFloat(memSum.faultRate),
      ctxPerTick: ctxRate,
      readyOver: scheduler.ready.length - cores,
      ready: scheduler.ready.length,
      kills: parseInt(m.completed),
      total: m.total,
      algo: scheduler.algorithm,
      quantum: ['RR','MLQ','MLFQ'].includes(scheduler.algorithm) ? scheduler.quantum : null,
      cores,
      now: scheduler.now,
      allDone
    });

    if (window.DoomArena && DoomArena.isActive() && pool) {
      window.__poolCoresCount = pool.cores.length;
      const coreData = pool.cores.map(c => {
        const proc = c.pid ? scheduler.processes.get(c.pid) : null;
        return {
          id: c.id,
          pid: c.pid,
          remaining: proc ? proc.remaining : 0,
          burst: proc ? proc.burst : 0,
          queueLevel: proc ? (proc.queueLevel || 0) : 0,
          color: pidColorIdx(c.pid)
        };
      });
      DoomArena.update(coreData, scheduler.now);
    }

    // Intermission: solo cuando la sim TERMINA estando en Doom mode,
    // con delay para que el último kill se aprecie. Si la sim terminó
    // en modo normal, doomIntermissionShown se marca true igual para
    // evitar que aparezca al activar Doom después.
    if (allDone && !doomIntermissionShown) {
      doomIntermissionShown = true;
      if (window.DoomArena && DoomArena.isActive()) {
        const stats = {
          algo: scheduler.algorithm,
          kills: parseInt(m.completed),
          total: m.total,
          time: scheduler.now,
          avgTat: m.avgTat,
          avgWait: m.avgWait,
          cpuUtil: m.cpuUtil,
          faults: memSum.faults,
          ctx: m.contextSwitches
        };
        const ganttSvg = document.getElementById('gantt');
        const ganttHTML = ganttSvg ? ganttSvg.outerHTML : '';
        setTimeout(() => {
          // Re-check: el usuario puede haber salido de Doom durante el delay.
          if (DoomArena.isActive()) DoomArena.showIntermission(stats, ganttHTML);
        }, 1500);
      }
    }
  }

  // ---------- Run controls ----------
  function startSim() {
    if (processList.length === 0) {
      UI.toast('Agrega al menos un proceso primero', 'err');
      UI.activateTab('procesos');
      return;
    }

    const numCores = Math.max(1, parseInt($('in-cores').value, 10) || 1);
    const quantum = Math.max(1, parseInt($('in-quantum').value, 10) || 3);
    const memorySize = Math.max(4, parseInt($('in-mem-size').value, 10) || 64);
    const pageSize = Math.max(1, parseInt($('in-page-size').value, 10) || 4);

    // Heurísticas de advertencia (no bloquean, solo informan).
    const totalPagesNeeded = processList.reduce((s, p) => s + (p.pages || 0), 0);
    const numFrames = Math.floor(memorySize / pageSize);
    if (totalPagesNeeded > numFrames * 3) {
      UI.toast(`Memoria muy pequeña: ${totalPagesNeeded} páginas demandadas vs ${numFrames} frames. Esperá muchos page faults.`, 'warn', 5000);
    }
    const algo = $('in-algo').value;
    if ((algo === 'MLQ' || algo === 'MLFQ') && processList.every(p => (p.queueLevel || 0) === 0)) {
      UI.toast(`${algo} usa niveles de cola 0–2, pero todos tus procesos están en nivel 0. La diferencia será imperceptible.`, 'warn', 5000);
    }
    const usingAffinity = processList.some(p => p.affinity && p.affinity.length);
    if (usingAffinity) {
      const maxAff = Math.max(...processList.flatMap(p => p.affinity || [-1]));
      if (maxAff >= numCores) {
        UI.toast(`Affinity referencia core ${maxAff} pero solo configuraste ${numCores} cores. Esos procesos quedarán bloqueados.`, 'err', 5500);
      }
    }

    memory = new MemoryManager({
      memorySize, pageSize, algorithm: $('in-mem-algo').value
    });

    if (pool) pool.destroy();
    window.__poolCoresCount = numCores;
    doomLastFaults = 0; doomLastTick = 0; doomCtxLast = 0; doomIntermissionShown = false;
    pool = new CorePool(numCores, TICK_MS, (msg) => {
      // Each worker 'tick' = one CPU step = one page reference.
      if (msg.type === 'tick' && memory) {
        const page = memory.pageForStep(msg.pid, msg.executed - 1);
        if (page != null) memory.reference(msg.pid, page);
      }
      scheduler.handleWorkerEvent(msg);
      refresh();
    });

    // Expose for console debugging if needed.
    window.__mem = memory; window.__sched = scheduler; window.__pool = pool;

    scheduler = new Scheduler({
      pool, algorithm: $('in-algo').value, quantum,
      tickMs: TICK_MS, onUpdate: refresh
    });
    processList.forEach(p => {
      scheduler.addProcess(p);
      memory.registerProcess(p);
    });
    // Wrap the scheduler's onUpdate to detect end-of-sim → confetti + toast.
    const origOnUpdate = scheduler.onUpdate;
    let endNotified = false;
    scheduler.onUpdate = () => {
      origOnUpdate();
      if (!endNotified && !scheduler.isRunning() && scheduler.now > 0) {
        const allDone = [...scheduler.processes.values()].every(p => p.state === 'TERMINATED');
        if (allDone) {
          endNotified = true;
          UI.confetti();
          UI.toast(`🎉 Simulación completa en ${scheduler.now} unidades de tiempo`, 'ok', 4000);
        }
      }
    };
    scheduler.start();
    refresh();
    UI.activateTab('sim');
    UI.toast('Simulación iniciada', 'info', 1500);
  }

  function pauseSim() { if (scheduler) scheduler.pause(); }
  function resumeSim() { if (scheduler && !scheduler.isRunning()) scheduler.start(); }
  function resetSim() {
    if (scheduler) scheduler.pause();
    if (pool) pool.destroy();
    pool = null; scheduler = null; memory = null;
    doomLastFaults = 0; doomLastTick = 0; doomCtxLast = 0; doomIntermissionShown = false;
    const interm = document.getElementById('doom-intermission');
    if (interm) interm.style.display = 'none';
    // Limpia las arenas Doom (evita cores fantasma de la sim previa).
    window.__poolCoresCount = parseInt($('in-cores').value, 10) || 4;
    if (window.DoomArena && DoomArena.isActive()) DoomArena.resetForNewSim();
    refresh();
    $('clock').textContent = '0';
  }

  // ---------- Wire up ----------
  function toggleQuantum() {
    const algo = $('in-algo').value;
    const needsQuantum = ['RR', 'MLQ', 'MLFQ'].includes(algo);
    $('lbl-quantum').style.display = needsQuantum ? '' : 'none';
  }

  function refreshFramesLabel() {
    const m = parseInt($('in-mem-size').value, 10) || 0;
    const p = parseInt($('in-page-size').value, 10) || 1;
    $('lbl-frames').textContent = Math.max(1, Math.floor(m / p));
  }

  // Parses procesos/memoria text files. Both can coexist in one file.
  // Process line: PID,Arrival,Burst,Priority,Pages[,QueueLevel]
  // Memory line:  Memoria=64 | PageSize=4 | Frames=16 (Frames is informativo,
  //               se recalcula desde Memoria/PageSize).
  // Lines starting with '#' or empty lines are ignored.
  function parseConfigFile(text) {
    const procs = [];
    let mem = null, ps = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^Memoria\s*=/i.test(line))   { mem = parseInt(line.split('=')[1], 10); continue; }
      if (/^PageSize\s*=/i.test(line))  { ps  = parseInt(line.split('=')[1], 10); continue; }
      if (/^Frames\s*=/i.test(line))    { /* informativo */ continue; }
      // Heuristic: process line starts with PID-like token (not just header).
      if (/^pid/i.test(line)) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 5) continue;
      const [pid, arr, bur, pri, pg, q] = parts;
      procs.push({
        pid: String(pid),
        arrival: parseInt(arr, 10) || 0,
        burst: Math.max(1, parseInt(bur, 10) || 1),
        priority: parseInt(pri, 10) || 0,
        pages: Math.max(0, parseInt(pg, 10) || 0),
        affinity: [],
        queueLevel: Math.max(0, Math.min(2, parseInt(q, 10) || 0))
      });
    }
    return { procs, mem, pageSize: ps };
  }

  // ---------- Predefined scenarios ----------
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
        queueLevel: Math.floor(Math.random() * 3)
      });
    }
    renderProcessList();
    UI.toast(`Cargados ${processList.length} procesos (alta carga)`, 'ok');
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
        queueLevel: Math.floor(Math.random() * 3)
      });
    }
    $('in-cores').value = 8;
    renderProcessList();
    UI.toast('20 procesos con 8 cores listos', 'ok');
  }

  function preloadDemoToast() {
    preloadDemo();
    UI.toast('Demo de 8 procesos cargada', 'ok', 1500);
  }

  // ---------- Comparisons ----------
  const ALL_SCHED   = ['FCFS','SJF','HRRN','PRIO','RR','SRTF','PRIO_P','MLQ','MLFQ'];
  const ALL_MEM     = ['FIFO','LRU','OPT','CLOCK','SC'];
  const ALL_CORES   = [1, 2, 4, 8];
  const MEM_SIZES   = [16, 32, 64, 128];

  function currentConfig() {
    return {
      processes: processList,
      numCores:   Math.max(1, parseInt($('in-cores').value, 10) || 1),
      quantum:    Math.max(1, parseInt($('in-quantum').value, 10) || 3),
      memorySize: Math.max(4, parseInt($('in-mem-size').value, 10) || 64),
      pageSize:   Math.max(1, parseInt($('in-page-size').value, 10) || 4),
      memAlgo:    $('in-mem-algo').value,
      algorithm:  $('in-algo').value
    };
  }

  function compareScheduling() {
    if (processList.length === 0) {
      UI.toast('Agrega procesos antes de comparar', 'err');
      UI.activateTab('procesos'); return;
    }
    const base = currentConfig();
    const rows = ALL_SCHED.map(algo =>
      window.FastSim.runFast({ ...base, algorithm: algo }));
    renderComparison('Scheduling — ' + base.memAlgo + ' / ' + base.numCores + ' cores',
      rows, 'algorithm', 'avgTat', 'Avg Turnaround');
  }

  function compareMemory() {
    if (processList.length === 0) {
      UI.toast('Agrega procesos antes de comparar', 'err');
      UI.activateTab('procesos'); return;
    }
    const base = currentConfig();
    const rows = ALL_MEM.map(memAlgo =>
      window.FastSim.runFast({ ...base, memAlgo }));
    renderComparison('Memoria — ' + base.algorithm + ' / mem=' + base.memorySize,
      rows, 'memAlgo', 'pageFaults', 'Page Faults');
  }

  function compareCores() {
    if (processList.length === 0) {
      UI.toast('Agrega procesos antes de comparar', 'err');
      UI.activateTab('procesos'); return;
    }
    const base = currentConfig();
    const rows = ALL_CORES.map(n =>
      window.FastSim.runFast({ ...base, numCores: n }));
    renderComparison('Cores — ' + base.algorithm,
      rows, 'numCores', 'time', 'Tiempo total');
  }

  function compareMemorySizes() {
    if (processList.length === 0) {
      UI.toast('Agrega procesos antes de comparar', 'err');
      UI.activateTab('procesos'); return;
    }
    const base = currentConfig();
    const rows = MEM_SIZES.map(m =>
      window.FastSim.runFast({ ...base, memorySize: m }));
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

    // Table
    const tbl = document.createElement('table');
    tbl.className = 'data small';
    tbl.innerHTML = `<thead><tr>
      <th>${labelKey}</th><th>Tiempo</th><th>Avg TAT</th><th>Avg WT</th>
      <th>Avg RT</th><th>CPU%</th><th>Throughput</th>
      <th>Ctx Sw</th><th>Faults</th><th>Tasa</th>
    </tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    let bestIdx = 0;
    rows.forEach((r, i) => {
      if (r[chartKey] < rows[bestIdx][chartKey]) bestIdx = i;
    });
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

    // Bar chart
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
      UI.toast(`Cargados ${cfg.procs.length} procesos`
        + (cfg.mem ? ` · memoria=${cfg.mem}` : '')
        + (cfg.pageSize ? ` · pageSize=${cfg.pageSize}` : ''),
        cfg.procs.length > 0 ? 'ok' : 'warn');
    };
    reader.readAsText(file);
  }

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
        refresh();
      };
    }
    if (window.DoomHUD) DoomHUD.renderEmpty();

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
    $('btn-cmp-sched').onclick = compareScheduling;
    $('btn-cmp-mem').onclick = compareMemory;
    $('btn-cmp-cores').onclick = compareCores;
    $('btn-cmp-mem-size').onclick = compareMemorySizes;
    $('btn-start').onclick = startSim;
    $('btn-pause').onclick = pauseSim;
    $('btn-resume').onclick = resumeSim;
    $('btn-reset').onclick = resetSim;
    $('in-algo').addEventListener('change', toggleQuantum);
    $('in-mem-size').addEventListener('input', () => { refreshFramesLabel(); refresh(); });
    $('in-page-size').addEventListener('input', () => { refreshFramesLabel(); refresh(); });
    $('in-mem-algo').addEventListener('change', refresh);

    // Speed slider: cambia tickMs en vivo, sin reset.
    if ($('speed-slider')) {
      $('speed-slider').addEventListener('input', (e) => {
        const lvl = parseInt(e.target.value, 10) || 3;
        TICK_MS = SPEED_MS[lvl] || 250;
        if (pool) pool.setTickMs(TICK_MS);
        if (scheduler) scheduler.setTickMs(TICK_MS);
      });
    }
    $('in-file').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (f) loadFromFile(f);
    });
    toggleQuantum();
    refreshFramesLabel();
    renderProcessList();
    refresh(); // primer render: muestra frames preview en pestaña Memoria
  });
})();
