// ui-helpers.js — toasts, tabs, modal, validación, confetti.

(function () {
  // ---------- TOASTS ----------
  function toast(message, kind = 'info', timeout = 3500) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.innerHTML = `<span class="toast-icon">${iconFor(kind)}</span>
                    <span class="toast-msg">${message}</span>
                    <button class="toast-x" aria-label="cerrar">×</button>`;
    el.querySelector('.toast-x').onclick = () => dismiss(el);
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => dismiss(el), timeout);
  }
  function dismiss(el) {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }
  function iconFor(kind) {
    return { ok: '✓', err: '⚠', info: 'ℹ', warn: '!' }[kind] || 'ℹ';
  }

  // ---------- TABS ----------
  function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const panes = document.querySelectorAll('[data-tab-pane]');
    tabs.forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.tab;
        tabs.forEach(t => t.classList.toggle('active', t === btn));
        panes.forEach(p => p.classList.toggle('active', p.dataset.tabPane === id));
      };
    });
  }
  function activateTab(id) {
    document.querySelector(`.tab[data-tab="${id}"]`)?.click();
  }

  // ---------- MODAL ----------
  function showModal(title, htmlContent, onClose) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <header class="modal-header">
            <h3>${title}</h3>
            <button class="modal-x" aria-label="cerrar">×</button>
          </header>
          <div class="modal-body">${htmlContent}</div>
        </div>
      </div>`;
    const close = () => { root.innerHTML = ''; onClose && onClose(); };
    root.querySelector('.modal-x').onclick = close;
    root.querySelector('.modal-backdrop').onclick = (e) => {
      if (e.target.classList.contains('modal-backdrop')) close();
    };
    return close;
  }

  // ---------- TUTORIAL ----------
  const TUTORIAL_KEY = 'sysops_tutorial_seen';
  function showTutorial(force = false) {
    if (!force && localStorage.getItem(TUTORIAL_KEY)) return;
    const html = `
      <p>Bienvenido al simulador de Sistema Operativo.</p>
      <ol class="tut-steps">
        <li><strong>📋 Procesos</strong> — agrega procesos a mano o usa "Demo / Alta carga".</li>
        <li><strong>⚙️ Simulación</strong> — elige algoritmo, # de cores, y dale Play. Cada core es un Web Worker (thread real).</li>
        <li><strong>💾 Memoria</strong> — observa frames, page table y reemplazos en vivo.</li>
        <li><strong>📊 Comparar</strong> — corre todos los algoritmos a la vez y mira la mejor opción.</li>
        <li><strong>🍴 Fork Backend</strong> — ejecuta los procesos como forks reales del SO (PID nativos).</li>
      </ol>
      <p class="hint">Los íconos <span class="info-pill">ℹ</span> en cada panel explican qué hace y sus limitaciones. Las advertencias en rojo te dicen qué corregir antes de simular.</p>
      <div class="modal-actions">
        <label><input type="checkbox" id="tut-dont-show"> No mostrar de nuevo</label>
        <button class="primary" id="tut-ok">Empezar</button>
      </div>`;
    showModal('🚀 Bienvenido', html);
    document.getElementById('tut-ok').onclick = () => {
      if (document.getElementById('tut-dont-show').checked) {
        localStorage.setItem(TUTORIAL_KEY, '1');
      }
      document.getElementById('modal-root').innerHTML = '';
    };
  }

  // ---------- VALIDATION (in-form messages) ----------
  function setFieldError(inputId, message) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.classList.toggle('input-error', !!message);
    let err = inp.parentElement.querySelector('.field-err');
    if (message) {
      if (!err) {
        err = document.createElement('span');
        err.className = 'field-err';
        inp.parentElement.appendChild(err);
      }
      err.textContent = message;
    } else if (err) err.remove();
  }
  function clearFieldErrors(parentEl) {
    parentEl.querySelectorAll('.input-error').forEach(e => e.classList.remove('input-error'));
    parentEl.querySelectorAll('.field-err').forEach(e => e.remove());
  }

  // ---------- DISABLE BUTTON WITH REASON ----------
  function setBtnReason(btnId, reason) {
    const b = document.getElementById(btnId);
    if (!b) return;
    if (reason) {
      b.disabled = true;
      b.setAttribute('data-tip', reason);
    } else {
      b.disabled = false;
      b.removeAttribute('data-tip');
    }
  }

  // ---------- CONFETTI on simulation end ----------
  function confetti() {
    const root = document.getElementById('confetti-root');
    if (!root) return;
    const colors = ['#16a085','#3498db','#e74c3c','#f39c12','#9b59b6','#2ecc71'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = (Math.random() * 0.5) + 's';
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      root.appendChild(piece);
      setTimeout(() => piece.remove(), 2500);
    }
  }

  // ---------- TOOLTIPS (global, position:fixed → escape overflow) ----------
  let tipEl = null;
  function ensureTip() {
    if (tipEl) return;
    tipEl = document.createElement('div');
    tipEl.id = 'global-tooltip';
    tipEl.style.cssText = [
      'position:fixed', 'background:#1f2d3d', 'color:#fff',
      'padding:6px 10px', 'border-radius:4px', 'font-size:11px',
      'z-index:99999', 'pointer-events:none',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'opacity:0', 'transition:opacity 0.12s', 'display:none',
      'line-height:1.4'
    ].join(';');
    document.body.appendChild(tipEl);
  }
  function showTip(target) {
    ensureTip();
    const txt = target.getAttribute('data-tip') || target.getAttribute('data-tip-wide');
    if (!txt) return;
    const wide = target.hasAttribute('data-tip-wide');
    tipEl.textContent = txt;
    tipEl.style.whiteSpace = wide ? 'normal' : 'nowrap';
    tipEl.style.maxWidth = wide ? '280px' : 'none';
    tipEl.style.display = 'block';
    tipEl.style.opacity = '0';
    // Layout pass
    const r = target.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    // Prefer above; flip below if not enough space.
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8;
    let left = r.left + r.width / 2 - tr.width / 2;
    if (left < 8) left = 8;
    if (left + tr.width > window.innerWidth - 8) left = window.innerWidth - tr.width - 8;
    tipEl.style.top = top + 'px';
    tipEl.style.left = left + 'px';
    tipEl.style.opacity = '1';
  }
  function hideTip() {
    if (!tipEl) return;
    tipEl.style.opacity = '0';
    setTimeout(() => {
      if (tipEl && tipEl.style.opacity === '0') tipEl.style.display = 'none';
    }, 150);
  }
  function initTooltips() {
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip], [data-tip-wide]');
      if (t) showTip(t);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip], [data-tip-wide]');
      if (t) hideTip();
    });
    // Also hide on scroll/resize so the tip doesn't lag in stale position.
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  window.UI = {
    toast, initTabs, activateTab, showModal, showTutorial,
    setFieldError, clearFieldErrors, setBtnReason, confetti,
    initTooltips
  };
})();
