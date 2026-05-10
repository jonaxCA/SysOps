// CorePool — manages N Web Workers, one per simulated CPU core.
//
// Each Worker is a real OS thread. The pool exposes a small API used by
// the scheduler: list free cores, assign a process, preempt a core.

(function () {
  class CorePool {
    constructor(numCores, tickMs, onEvent) {
      this.tickMs = tickMs;
      this.onEvent = onEvent;
      const blob = new Blob([window.WORKER_SOURCE], { type: 'application/javascript' });
      this.workerUrl = URL.createObjectURL(blob);
      this.cores = [];
      for (let i = 0; i < numCores; i++) this.cores.push(this.spawnCore(i));
    }

    spawnCore(id) {
      const worker = new Worker(this.workerUrl);
      const core = { id, worker, busy: false, pid: null, remaining: 0 };
      worker.postMessage({ type: 'config', tickMs: this.tickMs });
      worker.onmessage = (e) => {
        const msg = e.data;
        msg.coreId = id;
        if (msg.type === 'tick') {
          core.remaining = msg.remaining;
        } else if (msg.type === 'done' || msg.type === 'quantum-expired'
                   || msg.type === 'preempted') {
          core.busy = false;
          core.pid = null;
          core.remaining = 0;
        }
        this.onEvent(msg);
      };
      return core;
    }

    freeCores(allowedIds = null) {
      return this.cores.filter(c =>
        !c.busy && (!allowedIds || allowedIds.length === 0 || allowedIds.includes(c.id))
      );
    }

    busyCores() { return this.cores.filter(c => c.busy); }

    assign(coreId, pid, burst, quantum) {
      const core = this.cores[coreId];
      core.busy = true;
      core.pid = pid;
      core.remaining = burst;
      core.worker.postMessage({ type: 'run', pid, burst, quantum });
    }

    preempt(coreId) {
      this.cores[coreId].worker.postMessage({ type: 'preempt' });
    }

    destroy() {
      this.cores.forEach(c => c.worker.terminate());
      URL.revokeObjectURL(this.workerUrl);
    }
  }

  window.CorePool = CorePool;
})();
