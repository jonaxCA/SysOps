// doom-arena.js — vista alternativa de cores con canvas pixel-art.
//
// Cada core es un canvas independiente. Cuando hay un proceso corriendo,
// se dibuja un sprite de "demonio" pixel-art con paleta única por PID.
// Cuando termina, animación de explosión radial frame-by-frame con
// partículas y banner "TERMINATED".
//
// Eventos especiales:
//   - reportPageFault(): el aro de daño global parpadea rojo brevemente.
//   - MLFQ demotion: el sprite se dibuja con paleta degradada según
//     queueLevel del proceso (0=normal, 1=desaturado, 2=gris/oscuro).

(function () {
  // ----- Sprite definitions: 8x10 pixel grids -----
  // Color index: 0 transparent, 1 dark outline, 2 mid, 3 eye/horn,
  // 4 mouth/teeth, 5 body
  const SPRITES = [
    // imp
    [[0,0,1,1,1,1,0,0],
     [0,1,2,2,2,2,1,0],
     [1,2,3,2,2,3,2,1],
     [1,2,2,2,2,2,2,1],
     [0,1,2,4,4,2,1,0],
     [0,0,1,2,2,1,0,0],
     [0,1,5,5,5,5,1,0],
     [1,5,5,5,5,5,5,1],
     [0,5,1,5,5,1,5,0],
     [0,5,0,0,0,0,5,0]],
    // pinky
    [[0,1,1,1,1,1,1,0],
     [1,2,2,2,2,2,2,1],
     [1,2,3,2,2,3,2,1],
     [1,2,4,2,2,4,2,1],
     [0,1,2,2,2,2,1,0],
     [0,1,5,5,5,5,1,0],
     [1,5,5,5,5,5,5,1],
     [0,5,5,5,5,5,5,0],
     [5,5,1,5,5,1,5,5],
     [5,0,0,0,0,0,0,5]],
    // cacodemon
    [[0,0,1,1,1,1,0,0],
     [0,1,1,2,2,1,1,0],
     [1,2,3,2,2,3,2,1],
     [0,1,2,2,2,2,1,0],
     [0,0,1,4,4,1,0,0],
     [0,1,5,5,5,5,1,0],
     [0,5,5,5,5,5,5,0],
     [1,5,5,5,5,5,5,1],
     [0,5,0,5,5,0,5,0],
     [0,0,0,5,5,0,0,0]],
    // lost soul / skull
    [[0,1,1,1,1,1,1,0],
     [1,2,2,2,2,2,2,1],
     [1,2,4,1,1,4,2,1],
     [1,2,4,1,1,4,2,1],
     [0,1,2,3,3,2,1,0],
     [0,0,1,5,5,1,0,0],
     [0,1,5,5,5,5,1,0],
     [1,5,1,5,5,1,5,1],
     [0,5,0,5,5,0,5,0],
     [0,0,0,5,5,0,0,0]]
  ];

  // 6 paletas base [transparent, dark, mid, eyes, mouth, body]
  const PALS = [
    ['t','#7a0000','#cc2200','#ffdd00','#380000','#ff7744'],
    ['t','#00307a','#0077cc','#44ddff','#001c44','#33aaff'],
    ['t','#005a0a','#00aa22','#aaff44','#003008','#44ff77'],
    ['t','#6b006b','#bb00bb','#ffaaff','#380038','#ff55ff'],
    ['t','#6b4400','#cc8800','#ffdd44','#3a2000','#ffaa33'],
    ['t','#006b5a','#009999','#44ffee','#003333','#00ddcc']
  ];

  const PS = 5; // pixel size for sprites

  // ----- State -----
  let active = false;
  let coreCanvases = new Map();    // coreId -> {canvas, ctx, w, h}
  let coreSnapshot = new Map();    // coreId -> {pid, queueLevel, remaining, burst, color}
  let prevPids = new Map();        // coreId -> previous pid (for kill detection)
  let explosions = new Map();      // coreId -> {frame, maxF, palIdx}
  let animFrame = null;
  let damageFlashUntil = 0;        // global red overlay timestamp
  let bobPhase = 0;                // for idle bobbing animation

  function isActive() { return active; }

  function setActive(v) {
    active = v;
    document.body.classList.toggle('doom-mode', v);
    const std = document.getElementById('cores');
    const arena = document.getElementById('doom-arena');
    if (std)   std.style.display   = v ? 'none' : '';
    if (arena) arena.style.display = v ? '' : 'none';
    if (v) {
      buildArena();
      startLoop();
    } else {
      stopLoop();
      coreCanvases.clear();
    }
  }

  // ----- Build arena DOM (one canvas per core) -----
  function buildArena() {
    const grid = document.getElementById('doom-arena');
    if (!grid) return;
    const numCores = window.__poolCoresCount || 4;
    grid.innerHTML = '';
    coreCanvases.clear();
    for (let i = 0; i < numCores; i++) {
      const room = document.createElement('div');
      room.className = 'arena-room';
      room.innerHTML = `
        <div class="arena-header">
          <span class="arena-id">CORE ${i}</span>
          <span class="arena-state idle" id="arena-state-${i}">IDLE</span>
        </div>
        <canvas class="arena-canvas" id="arena-cvs-${i}"></canvas>
        <div class="arena-info" id="arena-info-${i}">—</div>`;
      grid.appendChild(room);
    }
    // Set canvas pixel dimensions based on rendered size.
    requestAnimationFrame(() => {
      for (let i = 0; i < numCores; i++) {
        const cvs = document.getElementById(`arena-cvs-${i}`);
        if (!cvs) continue;
        cvs.width = cvs.offsetWidth || 220;
        cvs.height = cvs.offsetHeight || 130;
        coreCanvases.set(i, {
          canvas: cvs, ctx: cvs.getContext('2d'),
          w: cvs.width, h: cvs.height
        });
      }
    });
  }

  // ----- External update from main.js -----
  function update(coresInfo, schedulerInfo) {
    if (!active) return;
    // If pool size changed, rebuild.
    if (coresInfo.length !== coreCanvases.size && coresInfo.length > 0) {
      window.__poolCoresCount = coresInfo.length;
      buildArena();
    }
    coresInfo.forEach(c => {
      const prev = prevPids.get(c.id);
      if (prev && !c.pid) {
        // Was running, now idle → kill explosion.
        const lastSnap = coreSnapshot.get(c.id);
        const palIdx = lastSnap ? lastSnap.color % PALS.length : 0;
        explosions.set(c.id, { frame: 0, maxF: 22, palIdx, pid: prev });
        if (window.DoomHUD) DoomHUD.setFaceTemp('grin', 700);
      }
      prevPids.set(c.id, c.pid || null);
      coreSnapshot.set(c.id, c);
    });
  }

  function reportPageFault() {
    damageFlashUntil = Date.now() + 350;
    if (window.DoomHUD) DoomHUD.setFaceTemp('pain', 450);
  }

  // ----- Animation loop -----
  function startLoop() {
    if (animFrame) return;
    const loop = () => {
      if (!active) { animFrame = null; return; }
      bobPhase = (bobPhase + 1) % 1000;
      coreCanvases.forEach((c, id) => drawCore(id, c));
      drawDamageOverlay();
      animFrame = requestAnimationFrame(loop);
    };
    animFrame = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
  }

  // ----- Drawing -----
  function drawCore(id, c) {
    const ctx = c.ctx, w = c.w, h = c.h;
    const ex = explosions.get(id);
    const snap = coreSnapshot.get(id);
    const stateEl = document.getElementById(`arena-state-${id}`);
    const infoEl = document.getElementById(`arena-info-${id}`);

    if (ex) {
      drawExplosion(ctx, w, h, ex.frame, ex.maxF, ex.palIdx);
      ex.frame++;
      if (ex.frame > ex.maxF) explosions.delete(id);
      if (stateEl) { stateEl.textContent = 'KILL!'; stateEl.className = 'arena-state kill'; }
      if (infoEl)  infoEl.textContent  = `— PID ${ex.pid} terminated —`;
      return;
    }

    if (snap && snap.pid) {
      drawRunning(ctx, w, h, snap);
      if (stateEl) { stateEl.textContent = 'IN COMBAT'; stateEl.className = 'arena-state busy'; }
      if (infoEl) {
        const ql = (snap.queueLevel || 0);
        const qTag = ql > 0 ? ` Q${ql}` : '';
        infoEl.textContent = `${snap.pid} · ${snap.remaining ?? '?'}t${qTag}`;
      }
      return;
    }

    drawIdle(ctx, w, h);
    if (stateEl) { stateEl.textContent = 'CLEAR'; stateEl.className = 'arena-state idle'; }
    if (infoEl)  infoEl.textContent  = '—';
  }

  function drawIdle(ctx, w, h) {
    ctx.fillStyle = '#0a0a0e';
    ctx.fillRect(0, 0, w, h);
    // grid floor
    ctx.strokeStyle = '#11111a';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 14) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.fillStyle = '#222230';
    ctx.font = 'bold 11px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('IDLE', w / 2, h / 2);
  }

  function drawRunning(ctx, w, h, snap) {
    ctx.fillStyle = '#0a0a0e';
    ctx.fillRect(0, 0, w, h);
    const palIdx = (snap.color != null ? snap.color : 0) % PALS.length;
    let pal = PALS[palIdx];

    // Apply MLFQ demotion: degrade palette saturation.
    const ql = snap.queueLevel || 0;
    if (ql > 0) pal = degradePalette(pal, ql);

    // floor grid (warm tint)
    ctx.strokeStyle = '#13130f';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 14) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 14) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // ambient glow
    const cx = w / 2, cy = (h - 18) / 2 + 4;
    const grd = ctx.createRadialGradient(cx, cy + 4, 0, cx, cy + 4, 60);
    grd.addColorStop(0, pal[2] + '33');
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    // sprite with subtle bobbing
    const spriteIdx = (hashPid(snap.pid) ) % SPRITES.length;
    const bob = Math.sin(bobPhase * 0.12) * 1.2;
    drawSprite(ctx, SPRITES[spriteIdx], pal, cx, cy + bob);

    // queue level indicator (corner glow)
    if (ql > 0) {
      const qColors = ['', '#ff8800', '#ff3333'];
      ctx.fillStyle = qColors[ql] || '#fff';
      ctx.fillRect(w - 10, 4, 6, 6);
      ctx.fillStyle = '#000';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`Q${ql}`, 4, h - 18);
    }

    // burst progress bar
    if (snap.burst) {
      const prog = 1 - (snap.remaining || 0) / snap.burst;
      const bw = w - 24, bh = 4, by = h - 10;
      ctx.fillStyle = '#0a0a0e';
      ctx.fillRect(12, by, bw, bh);
      ctx.fillStyle = pal[2];
      ctx.fillRect(12, by, Math.floor(bw * prog), bh);
      ctx.strokeStyle = '#222';
      ctx.strokeRect(12, by, bw, bh);
    }

    // PID label
    ctx.fillStyle = pal[3];
    ctx.font = 'bold 8px "Press Start 2P", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(snap.pid, 4, 12);
  }

  function drawExplosion(ctx, w, h, frame, maxF, palIdx) {
    ctx.fillStyle = '#0a0a0e';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = (h - 18) / 2 + 4;
    const prog = frame / maxF;
    const maxR = Math.min(w, h) * 0.46;
    const clrs = ['#ffff00', '#ff8800', '#ff4400', '#aa2200', '#330000'];
    for (let i = 4; i >= 0; i--) {
      const r = maxR * prog * (1 - i * 0.13);
      if (r <= 0) continue;
      const a = Math.max(0, Math.floor((1 - Math.pow(prog, 0.7)) * 255))
        .toString(16).padStart(2, '0');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = clrs[i] + a;
      ctx.fill();
    }
    if (prog < 0.7) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const dist = maxR * 0.6 * prog;
        ctx.fillStyle = '#ffcc00';
        ctx.fillRect(cx + Math.cos(angle) * dist - 2, cy + Math.sin(angle) * dist - 2, 5, 5);
      }
    }
    if (prog > 0.35 && prog < 0.95) {
      const alpha = Math.sin((prog - 0.35) / 0.6 * Math.PI);
      ctx.fillStyle = `rgba(255,170,0,${alpha.toFixed(2)})`;
      ctx.font = 'bold 9px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TERMINATED', cx, cy + 38);
    }
  }

  function drawSprite(ctx, sprite, pal, cx, cy) {
    const sh = sprite.length, sw = sprite[0].length;
    const sx = Math.floor(cx - sw * PS / 2);
    const sy = Math.floor(cy - sh * PS / 2);
    for (let r = 0; r < sh; r++) {
      for (let c = 0; c < sw; c++) {
        const ci = sprite[r][c];
        if (!ci) continue;
        ctx.fillStyle = pal[ci];
        ctx.fillRect(sx + c * PS, sy + r * PS, PS, PS);
      }
    }
  }

  function drawDamageOverlay() {
    const remain = damageFlashUntil - Date.now();
    if (remain <= 0) return;
    const overlay = document.getElementById('doom-damage-flash');
    if (!overlay) return;
    overlay.style.opacity = Math.min(1, remain / 350) * 0.55;
  }

  // Cleanup overlay opacity when no flash
  setInterval(() => {
    const overlay = document.getElementById('doom-damage-flash');
    if (overlay && damageFlashUntil < Date.now()) overlay.style.opacity = 0;
  }, 100);

  function degradePalette(pal, level) {
    // Convert mid + body to grayscale-ish blend; level 1 = 50%, level 2 = 80%.
    const factor = level === 1 ? 0.55 : 0.85;
    return pal.map((c, i) => {
      if (i === 0) return c;
      return blendToGray(c, factor);
    });
  }
  function blendToGray(hex, f) {
    if (hex[0] !== '#' || hex.length !== 7) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const gy = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    const nr = Math.round(r * (1 - f) + gy * f);
    const ng = Math.round(g * (1 - f) + gy * f);
    const nb = Math.round(b * (1 - f) + gy * f);
    return '#' + [nr, ng, nb].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function hashPid(pid) {
    if (!pid) return 0;
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // ----- Intermission "Level Complete" -----
  function showIntermission(stats, ganttSvgHTML) {
    if (!active) return;
    const root = document.getElementById('doom-intermission');
    if (!root) return;
    root.innerHTML = `
      <div class="interm-box">
        <div class="interm-title">LEVEL COMPLETE</div>
        <div class="interm-sub">${levelLabel(stats.algo)} · scheduling finished</div>
        <div class="interm-stats">
          <div class="interm-row"><span>KILLS</span><span class="iv">${stats.kills} / ${stats.total}</span></div>
          <div class="interm-row"><span>TIME</span><span class="iv">${stats.time}t</span></div>
          <div class="interm-row"><span>AVG TURNAROUND</span><span class="iv">${stats.avgTat}</span></div>
          <div class="interm-row"><span>AVG WAIT</span><span class="iv">${stats.avgWait}</span></div>
          <div class="interm-row"><span>CPU UTILIZATION</span><span class="iv">${stats.cpuUtil}%</span></div>
          <div class="interm-row"><span>PAGE FAULTS</span><span class="iv">${stats.faults}</span></div>
          <div class="interm-row"><span>CONTEXT SWITCHES</span><span class="iv">${stats.ctx}</span></div>
        </div>
        <div class="interm-gantt">
          <div class="gantt-lbl">GANTT — paralelo por core</div>
          <div class="gantt-wrap">${ganttSvgHTML}</div>
        </div>
        <button class="interm-close" id="interm-close">[ CONTINUE ]</button>
      </div>`;
    root.style.display = 'flex';
    document.getElementById('interm-close').onclick = () => { root.style.display = 'none'; };
    if (window.DoomHUD) DoomHUD.setFaceTemp('grin', 4000);
  }
  function levelLabel(algo) {
    const map = { FCFS:'E1M1', SJF:'E1M2', HRRN:'E1M3', PRIO:'E1M4',
                  RR:'E2M1', SRTF:'E2M2', PRIO_P:'E2M3', MLQ:'E3M1', MLFQ:'E3M2' };
    return (map[algo] || 'E?M?') + '  ' + (algo || '');
  }

  function resetForNewSim() {
    coreSnapshot.clear();
    prevPids.clear();
    explosions.clear();
    if (active) buildArena();
  }

  window.DoomArena = {
    setActive, isActive, update,
    reportPageFault, showIntermission,
    resetForNewSim
  };
})();
