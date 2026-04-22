/* ══════════════════════════════════════════════════════════════
   OS Process Simulator — app.js
   ══════════════════════════════════════════════════════════════ */

/* ─── Estado global ─────────────────────────────────────────── */
const STATE = {
  processes: [],   // Array de objetos proceso
  autoTimer: null, // ID del intervalo auto-step
  step: 0,         // Contador de pasos
};

const STATES = ['new', 'ready', 'running', 'waiting', 'terminated'];

/* ─── Elementos DOM ─────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const btnAdd   = $('btn-add');
const btnRun   = $('btn-run');
const btnAuto  = $('btn-auto');
const btnReset = $('btn-reset');
const logBox   = $('log-box');
const speedInput = $('speed');
const speedLabel = $('speed-label');
const procTbody  = $('proc-tbody');
const procCounter = $('proc-counter');

/* ─── Reloj en tiempo real ───────────────────────────────────── */
function updateClock() {
  const now = new Date();
  $('clock').textContent =
    String(now.getHours()).padStart(2,'0') + ':' +
    String(now.getMinutes()).padStart(2,'0') + ':' +
    String(now.getSeconds()).padStart(2,'0');
}
setInterval(updateClock, 1000);
updateClock();

/* ─── Log ────────────────────────────────────────────────────── */
function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  const now = new Date();
  const ts = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;
  line.textContent = `${ts} ${msg}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
  // Limitar a 80 líneas
  while (logBox.children.length > 80) logBox.removeChild(logBox.firstChild);
}

/* ─── Creación de proceso ────────────────────────────────────── */
btnAdd.addEventListener('click', () => {
  const pid      = parseInt($('pid').value);
  const arrival  = parseInt($('arrival').value) || 0;
  const burst    = parseInt($('burst').value);
  const priority = parseInt($('priority').value) || 1;
  const pages    = parseInt($('pages').value) || 1;
  const initState = $('init-state').value;

  if (!pid || isNaN(pid)) { log('ERROR: PID inválido.', 'error'); return; }
  if (!burst || burst < 1) { log('ERROR: Burst Time debe ser ≥ 1.', 'error'); return; }
  if (STATE.processes.find(p => p.pid === pid)) {
    log(`ERROR: PID ${pid} ya existe.`, 'error'); return;
  }

  const proc = {
    pid,
    arrival,
    burst,
    remaining: burst,
    priority,
    pages,
    state: initState,
    history: [initState],
    created: Date.now(),
  };

  STATE.processes.push(proc);
  log(`Proceso PID-${pid} creado → estado: ${initState.toUpperCase()} | BT:${burst} PRI:${priority} PGS:${pages}`, 'ok');
  renderAll();

  // Limpiar campos
  ['pid','arrival','burst','priority','pages'].forEach(id => $(id).value = '');
});

/* ─── Lógica de transición de estados ───────────────────────── */
/**
 * Aplica un paso de simulación:
 * - NEW   → READY (si está en new)
 * - READY → RUNNING (toma el de mayor prioridad)
 * - RUNNING → WAITING (random 30%), TERMINATED (si remaining=0), o se decrementa
 * - WAITING → READY
 */
function stepSimulation() {
  if (STATE.processes.length === 0) {
    log('No hay procesos para simular.', 'warn'); return;
  }

  const alive = STATE.processes.filter(p => p.state !== 'terminated');
  if (alive.length === 0) {
    log('Todos los procesos han terminado.', 'warn');
    if (STATE.autoTimer) toggleAuto();
    return;
  }

  STATE.step++;
  log(`── STEP ${STATE.step} ──────────────────────────`, 'info');

  // 1. NEW → READY
  STATE.processes
    .filter(p => p.state === 'new')
    .forEach(p => transition(p, 'ready', 'admitted'));

  // 2. WAITING → READY (I/O completado, random 60%)
  STATE.processes
    .filter(p => p.state === 'waiting')
    .forEach(p => {
      if (Math.random() < 0.6) transition(p, 'ready', 'I/O done');
    });

  // 3. Si hay RUNNING, procesarlo
  const running = STATE.processes.filter(p => p.state === 'running');
  running.forEach(p => {
    p.remaining--;
    log(`PID-${p.pid} ejecutando... remaining=${p.remaining}`, 'info');

    if (p.remaining <= 0) {
      transition(p, 'terminated', 'completado');
    } else if (Math.random() < 0.25) {
      // I/O interrupt → waiting
      transition(p, 'waiting', 'I/O request');
    } else if (Math.random() < 0.15) {
      // Preempt
      transition(p, 'ready', 'preempted');
    }
  });

  // 4. Elegir un proceso READY para hacer RUNNING (máx 1 CPU)
  const nowRunning = STATE.processes.filter(p => p.state === 'running').length;
  if (nowRunning === 0) {
    const readyQueue = STATE.processes
      .filter(p => p.state === 'ready')
      .sort((a, b) => a.priority - b.priority); // menor número = mayor prioridad
    if (readyQueue.length > 0) {
      transition(readyQueue[0], 'running', 'dispatched');
    }
  }

  renderAll();
}

function transition(proc, newState, reason) {
  const prev = proc.state;
  proc.state = newState;
  proc.history.push(newState);
  log(`PID-${proc.pid}: ${prev.toUpperCase()} → ${newState.toUpperCase()} (${reason})`, 'event');
}

/* ─── Auto step ──────────────────────────────────────────────── */
function toggleAuto() {
  if (STATE.autoTimer) {
    clearInterval(STATE.autoTimer);
    STATE.autoTimer = null;
    btnAuto.classList.remove('active');
    log('Auto-step desactivado.', 'warn');
  } else {
    const ms = parseInt(speedInput.value);
    STATE.autoTimer = setInterval(stepSimulation, ms);
    btnAuto.classList.add('active');
    log(`Auto-step activado cada ${ms}ms`, 'ok');
  }
}

btnRun.addEventListener('click', stepSimulation);
btnAuto.addEventListener('click', toggleAuto);

btnReset.addEventListener('click', () => {
  if (STATE.autoTimer) { clearInterval(STATE.autoTimer); STATE.autoTimer = null; btnAuto.classList.remove('active'); }
  STATE.processes = [];
  STATE.step = 0;
  log('Sistema reseteado.', 'warn');
  renderAll();
});

/* ─── Velocidad ──────────────────────────────────────────────── */
speedInput.addEventListener('input', () => {
  const ms = parseInt(speedInput.value);
  speedLabel.textContent = (ms/1000).toFixed(1) + 's';
  if (STATE.autoTimer) {
    clearInterval(STATE.autoTimer);
    STATE.autoTimer = setInterval(stepSimulation, ms);
  }
});

/* ─── Acciones desde la tabla ────────────────────────────────── */
function manualTransition(pid, toState) {
  const proc = STATE.processes.find(p => p.pid === pid);
  if (!proc || proc.state === 'terminated') return;
  transition(proc, toState, 'manual');
  renderAll();
}

function deleteProcess(pid) {
  const idx = STATE.processes.findIndex(p => p.pid === pid);
  if (idx === -1) return;
  STATE.processes.splice(idx, 1);
  log(`PID-${pid} eliminado.`, 'warn');
  renderAll();
}

/* ─── Render: Tabla ──────────────────────────────────────────── */
function renderTable() {
  if (STATE.processes.length === 0) {
    procTbody.innerHTML = `<tr class="empty-row"><td colspan="7">No hay procesos. Agrega uno →</td></tr>`;
    procCounter.textContent = '0 processes';
    return;
  }

  procCounter.textContent = `${STATE.processes.length} process${STATE.processes.length > 1 ? 'es' : ''}`;

  procTbody.innerHTML = STATE.processes.map(p => {
    const badge = `<span class="state-badge badge-${p.state}">${p.state}</span>`;
    const actions = p.state !== 'terminated'
      ? STATES.filter(s => s !== p.state && s !== 'new')
          .map(s => `<button class="act-btn" onclick="manualTransition(${p.pid},'${s}')" title="→ ${s}">${stateIcon(s)}</button>`)
          .join('') +
        `<button class="act-btn del" onclick="deleteProcess(${p.pid})" title="Eliminar">✕</button>`
      : `<button class="act-btn del" onclick="deleteProcess(${p.pid})" title="Eliminar">✕</button>`;

    return `
      <tr data-pid="${p.pid}">
        <td style="color:var(--cyan);font-weight:700">${p.pid}</td>
        <td>${p.arrival}</td>
        <td>${p.burst}${p.state !== 'terminated' ? `<span style="color:var(--muted)">/${p.remaining}</span>` : ''}</td>
        <td>${p.priority}</td>
        <td>${p.pages}</td>
        <td>${badge}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');
}

function stateIcon(s) {
  return { ready: '▶', running: '⚡', waiting: '⏸', terminated: '✓' }[s] || s;
}

/* ─── Render: Diagrama SVG ───────────────────────────────────── */
function renderDiagram() {
  const counts = { new: 0, ready: 0, running: 0, waiting: 0, terminated: 0 };
  STATE.processes.forEach(p => counts[p.state]++);

  STATES.forEach(s => {
    const node = document.getElementById(`node-${s}`);
    const countEl = document.getElementById(`count-${s}`);
    if (!node || !countEl) return;

    const c = counts[s];
    countEl.textContent = `${c} proc${c !== 1 ? 's' : ''}`;

    if (c > 0) node.classList.add('node-active');
    else node.classList.remove('node-active');
  });
}

/* ─── Render: Stats ──────────────────────────────────────────── */
function renderStats() {
  $('stat-total').textContent   = STATE.processes.length;
  $('stat-running').textContent = STATE.processes.filter(p => p.state === 'running').length;
  $('stat-done').textContent    = STATE.processes.filter(p => p.state === 'terminated').length;
  $('stat-waiting').textContent = STATE.processes.filter(p => p.state === 'waiting').length;
}

/* ─── Render: Todo ───────────────────────────────────────────── */
function renderAll() {
  renderTable();
  renderDiagram();
  renderStats();
}

/* ─── Inicializar ────────────────────────────────────────────── */
renderAll();
log('Sistema listo. Crea procesos y pulsa STEP o AUTO.', 'ok');
