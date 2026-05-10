// doom-hud.js — HUD canvas pixel-art con cara animada del marine.
//
// Reescrito para usar <canvas> con sprites indexados por paleta (técnica
// del prototipo de referencia). Cara con 5 moods + reacciones temporales:
//   - 'grin' por 700ms cuando termina un proceso (kill).
//   - 'pain' por 500ms cuando ocurre un page fault.
//   - 'angry' sostenida cuando hay alta presión / context switching.
//   - 'dead' si todo terminó.

(function () {
  // ----- Face sprites: 8x8 pixel grids -----
  // Color index: 0 transparent, 1 skin shadow, 2 cheeks/dirt, 3 eyes,
  // 4 mouth open / blood, 5 helmet
  const FACES = {
    neutral: [
      [0,5,5,5,5,5,5,0],
      [5,1,1,1,1,1,1,5],
      [5,1,3,2,2,3,1,5],
      [5,1,1,2,2,1,1,5],
      [5,1,1,1,1,1,1,5],
      [5,1,3,3,3,3,1,5],
      [5,1,1,1,1,1,1,5],
      [0,5,5,5,5,5,5,0]
    ],
    grin: [
      [0,5,5,5,5,5,5,0],
      [5,1,1,1,1,1,1,5],
      [5,1,3,2,2,3,1,5],
      [5,1,1,1,1,1,1,5],
      [5,3,3,3,3,3,3,5],
      [5,1,3,3,3,3,1,5],
      [5,1,1,1,1,1,1,5],
      [0,5,5,5,5,5,5,0]
    ],
    pain: [
      [0,5,5,5,5,5,5,0],
      [5,4,1,1,1,1,4,5],
      [5,1,3,4,4,3,1,5],
      [5,4,1,1,1,1,4,5],
      [5,1,4,4,4,4,1,5],
      [5,1,2,2,2,2,1,5],
      [5,1,1,1,1,1,1,5],
      [0,5,5,5,5,5,5,0]
    ],
    angry: [
      [0,5,5,5,5,5,5,0],
      [5,4,4,4,4,4,4,5],
      [5,4,3,4,4,3,4,5],
      [5,4,4,4,4,4,4,5],
      [5,4,4,4,4,4,4,5],
      [5,3,3,3,3,3,3,5],
      [5,4,4,4,4,4,4,5],
      [0,5,5,5,5,5,5,0]
    ],
    dead: [
      [0,5,5,5,5,5,5,0],
      [5,1,1,1,1,1,1,5],
      [5,1,4,1,1,4,1,5],
      [5,1,4,4,4,4,1,5],
      [5,1,1,1,1,1,1,5],
      [5,1,2,1,1,2,1,5],
      [5,1,1,1,1,1,1,5],
      [0,5,5,5,5,5,5,0]
    ]
  };
  const FACE_PAL = ['#0d0d12','#c8956c','#8b5a2b','#ffffff','#ff2200','#d4a017'];
  const FS = 5;     // pixel scale for face

  let curFace = 'neutral';
  let tempTimer = null;
  let faceCanvas = null;
  let faceCtx = null;

  function ensureFace() {
    // Siempre re-consulta el DOM. Si el HUD fue reconstruido (toggle off/on),
    // el canvas anterior quedó zombie y hay que tomar la nueva referencia.
    const cvs = document.getElementById('doom-face-canvas');
    if (cvs !== faceCanvas) {
      faceCanvas = cvs;
      faceCtx = cvs ? cvs.getContext('2d') : null;
    }
  }

  function _drawFace(mood) {
    ensureFace();
    if (!faceCtx) return;
    const sprite = FACES[mood] || FACES.neutral;
    const w = faceCanvas.width, h = faceCanvas.height;
    faceCtx.fillStyle = '#111';
    faceCtx.fillRect(0, 0, w, h);
    const offX = Math.floor((w - 8 * FS) / 2);
    const offY = Math.floor((h - 8 * FS) / 2);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const ci = sprite[r][c];
        if (!ci) continue;
        faceCtx.fillStyle = FACE_PAL[ci];
        faceCtx.fillRect(offX + c * FS, offY + r * FS, FS, FS);
      }
    }
  }

  function setFace(mood) {
    if (tempTimer) { clearTimeout(tempTimer); tempTimer = null; }
    curFace = mood;
    ensureFace();
    _drawFace(mood);
  }

  function setFaceTemp(mood, dur = 600) {
    if (tempTimer) clearTimeout(tempTimer);
    ensureFace();
    _drawFace(mood);
    tempTimer = setTimeout(() => { tempTimer = null; _drawFace(curFace); }, dur);
  }

  function pickFace({ hasSim, allDone, faultRate, ctxPerTick, readyOver, cpuUtil }) {
    if (!hasSim)   return 'neutral';
    if (allDone)   return 'grin';
    if (faultRate > 50 || readyOver > 4)         return 'pain';
    if (faultRate > 25 || ctxPerTick > 2.5)      return 'angry';
    if (faultRate > 10 || readyOver > 1)         return 'angry';
    if (cpuUtil > 60)                            return 'neutral';
    return 'neutral';
  }

  function bullets(n, max) {
    const cap = Math.min(n, max);
    let html = '';
    for (let i = 0; i < cap; i++) html += '<span class="hud-bullet"></span>';
    if (n > max) html += `<span class="hud-overflow">+${n - max}</span>`;
    return html;
  }

  function levelName(algo) {
    if (!algo || algo === '—') return 'READY';
    const map = {
      FCFS:'E1M1', SJF:'E1M2', HRRN:'E1M3', PRIO:'E1M4',
      RR:'E2M1', SRTF:'E2M2', PRIO_P:'E2M3',
      MLQ:'E3M1', MLFQ:'E3M2'
    };
    return (map[algo] || 'E?M?') + '  ' + algo;
  }

  function valClass(v, low, high) {
    if (v >= high) return 'ok';
    if (v >= low)  return 'warn';
    return 'danger';
  }

  function render(snap) {
    const root = document.getElementById('doom-hud-root');
    if (!root) return;
    if (!window.DoomArena || !DoomArena.isActive()) { root.innerHTML = ''; return; }

    const cpu   = Math.round(snap.cpuUtil  || 0);
    const armor = Math.round(snap.memFree  || 0);
    const target = pickFace(snap);
    if (target !== curFace && !tempTimer) setFace(target);

    if (!root.firstChild) {
      // First mount: build skeleton, then keep updating.
      root.innerHTML = `
        <div class="doom-hud">
          <div class="hud-face-cell">
            <canvas id="doom-face-canvas" width="60" height="60"></canvas>
          </div>
          <div class="hud-cell">
            <span class="hud-label">HEALTH (CPU)</span>
            <span class="hud-value" id="hud-health">0%</span>
            <div class="hud-bar-mini"><span id="hud-health-bar"></span></div>
          </div>
          <div class="hud-cell">
            <span class="hud-label">ARMOR (MEM)</span>
            <span class="hud-value" id="hud-armor">0%</span>
            <div class="hud-bar-mini armor"><span id="hud-armor-bar"></span></div>
          </div>
          <div class="hud-cell">
            <span class="hud-label">AMMO (READY)</span>
            <span class="hud-value" id="hud-ammo">0</span>
            <div class="hud-ammo-bullets" id="hud-bullets"></div>
          </div>
          <div class="hud-cell">
            <span class="hud-label">KILLS</span>
            <span class="hud-value ok" id="hud-kills">0/0</span>
          </div>
          <div class="hud-cell">
            <span class="hud-label">LEVEL</span>
            <span class="hud-value lvl" id="hud-level">—</span>
            <span class="hud-meta" id="hud-meta">—</span>
          </div>
        </div>`;
      ensureFace();
      _drawFace(curFace);
    }

    const $ = (id) => document.getElementById(id);
    const elH = $('hud-health'); elH.textContent = cpu + '%';
    elH.className = 'hud-value ' + valClass(cpu, 30, 60);
    $('hud-health-bar').style.width = cpu + '%';
    $('hud-health-bar').parentElement.classList.toggle('danger', cpu < 30);

    const elA = $('hud-armor'); elA.textContent = armor + '%';
    elA.className = 'hud-value ' + valClass(armor, 20, 50);
    $('hud-armor-bar').style.width = armor + '%';

    $('hud-ammo').textContent = snap.ready || 0;
    $('hud-bullets').innerHTML = bullets(snap.ready || 0, 14);

    $('hud-kills').innerHTML =
      `${snap.kills || 0}<span class="hud-meta"> / ${snap.total || 0}</span>`;

    $('hud-level').textContent = levelName(snap.algo);
    $('hud-meta').textContent =
      `Q ${snap.quantum || '∞'} · ${snap.cores || 0} cores · t ${snap.now || 0}`;
  }

  function renderEmpty() {
    // Marine en reposo: HP/armor llenos, no es estado de "muerto".
    render({ hasSim: false, ready: 0, kills: 0, total: 0,
             cpuUtil: 100, memFree: 100, algo: '—', cores: 0, now: 0 });
  }

  window.DoomHUD = { render, renderEmpty, setFace, setFaceTemp };
})();
