// Scheduler — main-thread coordinator.
//
// Responsibilities:
//   * Track simulated time (ticks every tickMs).
//   * Move processes through states NEW -> READY -> RUNNING -> TERMINATED.
//   * Decide which ready process runs on which free core (algorithm-dependent).
//   * For preemptive algorithms, decide which running process should be evicted.
//   * Record Gantt segments per core for the visualization.
//
// Algorithms supported (Phase 2):
//   FCFS, SJF, HRRN          — non-preemptive
//   SRTF, RR, PRIO_P         — preemptive
//   PRIO                     — non-preemptive priority
//   MLQ                      — Multilevel Queue (3 niveles, prioridad estricta)
//   MLFQ                     — Multilevel Feedback Queue (3 niveles, demotion por quantum)

(function () {
  // ---------- Algorithm metadata ----------
  // priority: lower number = higher priority (clásico Unix nice-style)

  function hrrnRatio(p, now) {
    const wait = Math.max(0, (now - p.arrival) - p.executed);
    return (wait + p.burst) / p.burst;
  }

  // Sort the ready queue in dispatch order for the chosen algorithm.
  function sortReady(ready, algo, now) {
    switch (algo) {
      case 'FCFS':
        ready.sort((a, b) => a.arrival - b.arrival || a.pid.localeCompare(b.pid)); break;
      case 'SJF':
        ready.sort((a, b) => a.burst - b.burst); break;
      case 'SRTF':
        ready.sort((a, b) => a.remaining - b.remaining); break;
      case 'HRRN':
        ready.sort((a, b) => hrrnRatio(b, now) - hrrnRatio(a, now)); break;
      case 'PRIO':
      case 'PRIO_P':
        ready.sort((a, b) => a.priority - b.priority); break;
      case 'MLQ':
      case 'MLFQ':
        ready.sort((a, b) => (a.queueLevel || 0) - (b.queueLevel || 0)
                          || a.arrival - b.arrival); break;
      case 'RR':
      default:
        break; // FIFO order is preserved naturally
    }
  }

  // Decide preemptions for preemptive algorithms.
  // Returns an array of coreIds to preempt this tick.
  function preemptionCandidates(algo, ready, runningOn) {
    const decisions = [];
    if (ready.length === 0 || runningOn.size === 0) return decisions;

    if (algo === 'SRTF') {
      const cands = [...ready].sort((a, b) => a.remaining - b.remaining);
      const running = [...runningOn.entries()].sort((a, b) => b[1].remaining - a[1].remaining);
      for (const [coreId, runProc] of running) {
        if (cands.length === 0) break;
        if (cands[0].remaining < runProc.remaining) {
          decisions.push(coreId);
          cands.shift();
        } else break;
      }
    } else if (algo === 'PRIO_P') {
      const cands = [...ready].sort((a, b) => a.priority - b.priority);
      const running = [...runningOn.entries()].sort((a, b) => b[1].priority - a[1].priority);
      for (const [coreId, runProc] of running) {
        if (cands.length === 0) break;
        if (cands[0].priority < runProc.priority) {
          decisions.push(coreId);
          cands.shift();
        } else break;
      }
    } else if (algo === 'MLQ' || algo === 'MLFQ') {
      // Higher-priority queue (lower level number) preempts lower.
      const cands = [...ready].sort((a, b) => (a.queueLevel || 0) - (b.queueLevel || 0));
      const running = [...runningOn.entries()]
        .sort((a, b) => (b[1].queueLevel || 0) - (a[1].queueLevel || 0));
      for (const [coreId, runProc] of running) {
        if (cands.length === 0) break;
        if ((cands[0].queueLevel || 0) < (runProc.queueLevel || 0)) {
          decisions.push(coreId);
          cands.shift();
        } else break;
      }
    }
    return decisions;
  }

  // MLFQ quantum per queue level.
  const MLFQ_QUANTUMS = [2, 4, 8];
  const MLFQ_LEVELS = MLFQ_QUANTUMS.length;

  function quantumFor(algo, proc, defaultQuantum) {
    if (algo === 'RR') return defaultQuantum;
    if (algo === 'MLFQ') {
      return MLFQ_QUANTUMS[Math.min(proc.queueLevel || 0, MLFQ_LEVELS - 1)];
    }
    if (algo === 'MLQ') {
      // Convention: top queue (level 0) is RR with the configured quantum,
      // lower queues are FCFS (run to completion or preemption).
      return (proc.queueLevel || 0) === 0 ? defaultQuantum : Infinity;
    }
    return Infinity;
  }

  // ---------- Scheduler ----------
  class Scheduler {
    constructor({ pool, algorithm, quantum, tickMs, onUpdate }) {
      this.pool = pool;
      this.algorithm = algorithm;
      this.quantum = quantum || 4;
      this.tickMs = tickMs;
      this.onUpdate = onUpdate || (() => {});
      this.processes = new Map();
      this.ready = [];
      this.runningOn = new Map();        // coreId -> proc reference
      this.now = 0;
      this.timer = null;
      this.gantt = [];                   // [{coreId, pid, start, end}]
      this.activeSegments = new Map();   // coreId -> {pid, start}
      this.contextSwitches = 0;
    }

    addProcess(p) {
      this.processes.set(p.pid, {
        pid: p.pid,
        arrival: p.arrival,
        burst: p.burst,
        priority: p.priority ?? 0,
        pages: p.pages ?? 0,
        affinity: p.affinity || [],
        queueLevel: p.queueLevel ?? 0,
        remaining: p.burst,
        state: 'NEW',
        firstRun: null,
        completion: null,
        executed: 0,
        readyAt: null
      });
    }

    start() { if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs); }
    pause() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
    isRunning() { return this.timer !== null; }

    tick() {
      this.now++;

      // 1. Admit arrivals.
      for (const p of this.processes.values()) {
        if (p.state === 'NEW' && p.arrival <= this.now) {
          p.state = 'READY';
          p.readyAt = this.now;
          this.ready.push(p);
        }
      }

      // 2. Preemption pass (only for preemptive algorithms).
      const toPreempt = preemptionCandidates(this.algorithm, this.ready, this.runningOn);
      toPreempt.forEach(coreId => this.pool.preempt(coreId));
      // Once preempt messages are processed asynchronously, the worker reports
      // 'preempted' and handleWorkerEvent re-dispatches. We still call
      // dispatch() below to fill any cores that were already free.

      // 3. Dispatch ready -> free cores.
      this.dispatch();

      // 4. End-of-simulation check.
      const allDone = this.processes.size > 0
        && [...this.processes.values()].every(p => p.state === 'TERMINATED');
      if (allDone) this.pause();

      this.onUpdate();
    }

    dispatch() {
      if (this.ready.length === 0) return;
      sortReady(this.ready, this.algorithm, this.now);

      const stillReady = [];
      for (const proc of this.ready) {
        const free = this.pool.freeCores(proc.affinity);
        if (free.length === 0) { stillReady.push(proc); continue; }
        const core = free[0];
        proc.state = 'RUNNING';
        if (proc.firstRun === null) proc.firstRun = Math.max(this.now - 1, proc.arrival);
        this.runningOn.set(core.id, proc);
        this.activeSegments.set(core.id, { pid: proc.pid, start: Math.max(this.now - 1, 0) });
        this.contextSwitches++;
        const q = quantumFor(this.algorithm, proc, this.quantum);
        this.pool.assign(core.id, proc.pid, proc.remaining, q);
      }
      this.ready = stillReady;
    }

    handleWorkerEvent(msg) {
      const proc = this.processes.get(msg.pid);
      if (!proc) return;

      if (msg.type === 'tick') {
        proc.remaining = msg.remaining;
        proc.executed = msg.executed;
      } else if (msg.type === 'done') {
        proc.state = 'TERMINATED';
        proc.completion = this.now;
        proc.remaining = 0;
        this.closeSegment(msg.coreId);
        this.runningOn.delete(msg.coreId);
        this.dispatch();
      } else if (msg.type === 'quantum-expired') {
        proc.state = 'READY';
        proc.remaining = msg.remaining;
        proc.executed = msg.executed;
        proc.readyAt = this.now;
        // MLFQ: demote the process one level (if not already at the bottom).
        if (this.algorithm === 'MLFQ') {
          proc.queueLevel = Math.min((proc.queueLevel || 0) + 1, MLFQ_LEVELS - 1);
        }
        this.ready.push(proc);
        this.closeSegment(msg.coreId);
        this.runningOn.delete(msg.coreId);
        this.dispatch();
      } else if (msg.type === 'preempted') {
        proc.state = 'READY';
        proc.remaining = msg.remaining;
        proc.executed = msg.executed;
        proc.readyAt = this.now;
        this.ready.push(proc);
        this.closeSegment(msg.coreId);
        this.runningOn.delete(msg.coreId);
        this.dispatch();
      }
      this.onUpdate();
    }

    closeSegment(coreId) {
      const seg = this.activeSegments.get(coreId);
      if (seg && this.now > seg.start) {
        this.gantt.push({ coreId, pid: seg.pid, start: seg.start, end: this.now });
      }
      this.activeSegments.delete(coreId);
    }

    metrics() {
      // Per-process rows.
      const rows = [];
      for (const p of this.processes.values()) {
        if (p.completion === null) {
          rows.push({ pid: p.pid, arrival: p.arrival, burst: p.burst,
                      completion: '-', tat: '-', wait: '-', response: '-' });
        } else {
          const tat = p.completion - p.arrival;
          const wait = tat - p.burst;
          const response = (p.firstRun ?? p.arrival) - p.arrival;
          rows.push({ pid: p.pid, arrival: p.arrival, burst: p.burst,
                      completion: p.completion, tat, wait, response });
        }
      }
      const done = rows.filter(r => r.completion !== '-');
      const avg = (key) => done.length === 0 ? '0'
        : (done.reduce((s, r) => s + r[key], 0) / done.length).toFixed(2);

      // Per-core stats (combine closed gantt segments + active segment).
      const numCores = this.pool.cores.length;
      const perCore = [];
      for (let id = 0; id < numCores; id++) {
        const closed = this.gantt.filter(g => g.coreId === id);
        const active = this.activeSegments.get(id);
        const busy = closed.reduce((s, g) => s + (g.end - g.start), 0)
                   + (active ? this.now - active.start : 0);
        const idle = Math.max(0, this.now - busy);
        const util = this.now === 0 ? 0 : (100 * busy / this.now);
        // Distinct processes that ran on this core.
        const pidSet = new Set(closed.map(g => g.pid));
        if (active) pidSet.add(active.pid);
        perCore.push({
          coreId: id, busy, idle, util: util.toFixed(1),
          processes: pidSet.size,
          currentPid: active ? active.pid : null
        });
      }

      // Aggregate.
      const busyTime = perCore.reduce((s, c) => s + c.busy, 0);
      const totalCoreTime = this.now * numCores;
      const cpuUtil = totalCoreTime === 0 ? '0' : (100 * busyTime / totalCoreTime).toFixed(1);
      const throughput = this.now === 0 ? '0' : (done.length / this.now).toFixed(3);
      const completed = done.length;
      const totalBurst = [...this.processes.values()].reduce((s, p) => s + p.burst, 0);
      const speedup = (numCores > 1 && this.now > 0)
        ? (totalBurst / this.now).toFixed(2) + 'x'
        : '—';

      return {
        rows, avgTat: avg('tat'), avgWait: avg('wait'), avgResp: avg('response'),
        cpuUtil, contextSwitches: this.contextSwitches,
        perCore, throughput, completed, total: this.processes.size,
        speedup
      };
    }
  }

  window.Scheduler = Scheduler;
  // Expose helpers for the fast (headless) simulator used in comparisons.
  window.SchedulerLogic = {
    sortReady, preemptionCandidates, quantumFor,
    MLFQ_LEVELS, MLFQ_QUANTUMS
  };
})();
