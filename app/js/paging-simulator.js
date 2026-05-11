// PagingSimulator — motor independiente para la pestaña Paginación.
//
// No usa Web Workers ni cores. Su única responsabilidad: tomar la lista
// expandida de ejecutables y generar referencias a memoria que el
// MemoryManager procesa, mostrando faults / hits / reemplazos en vivo.
//
// Modelo simple round-robin: en cada tick, cada ejecutable activo hace
// UNA referencia a la próxima página de su cadena. Termina cuando todos
// completan sus N referencias (= burst).
//
// Esto es suficiente para visualizar el comportamiento de los algoritmos
// de reemplazo bajo carga concurrente sin acoplarse al scheduler.

(function () {
  class PagingSimulator {
    constructor({ executables, memory, tickMs = 250, onUpdate }) {
      this.execs = executables.map(p => ({
        pid: p.pid,
        owner: p.owner || p.pid,
        burst: p.burst,
        arrival: p.arrival,
        step: 0,
        terminated: false,
        started: false
      }));
      this.memory = memory;
      this.tickMs = tickMs;
      this.onUpdate = onUpdate || (() => {});
      this.now = 0;
      this.timer = null;
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }
    pause() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
    isRunning() { return this.timer !== null; }
    setTickMs(ms) {
      this.tickMs = ms;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), ms);
      }
    }

    tick() {
      this.now++;
      let activeAny = false;

      for (const e of this.execs) {
        if (e.terminated) continue;
        if (e.arrival > this.now) continue;
        e.started = true;
        activeAny = true;

        const page = this.memory.pageForStep(e.pid, e.step);
        if (page != null) this.memory.reference(e.pid, page);
        e.step++;
        if (e.step >= e.burst) e.terminated = true;
      }

      this.onUpdate();

      if (!activeAny && this.execs.every(e => e.terminated || e.arrival > this.now + 50)) {
        // Todo terminó (o llegadas muy futuras).
        this.pause();
      }
    }

    metrics() {
      const total = this.execs.length;
      const done = this.execs.filter(e => e.terminated).length;
      return { total, done, now: this.now };
    }
  }

  window.PagingSimulator = PagingSimulator;
})();
