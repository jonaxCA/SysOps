// FastSim — headless deterministic simulator for the comparison module.
//
// The main GUI uses real Web Workers (one thread per core) for the live
// visualization. For comparing many algorithms / configurations side-by-side
// we need to run dozens of simulations in milliseconds, which is impractical
// with real workers. FastSim mirrors the live scheduler/memory logic but
// runs synchronously in the main thread.
//
// Both engines share the same building blocks (SchedulerLogic, MemoryManager)
// so behavior is consistent.

(function () {
  const { sortReady, preemptionCandidates, quantumFor } = window.SchedulerLogic;

  function runFast({ processes, algorithm, numCores, quantum,
                     memorySize, pageSize, memAlgo, maxTime = 100000 }) {
    const memory = new MemoryManager({ memorySize, pageSize, algorithm: memAlgo });
    const procs = processes.map(p => ({
      ...p,
      remaining: p.burst,
      state: 'NEW',
      firstRun: null,
      completion: null,
      executed: 0,
      queueLevel: p.queueLevel ?? 0,
      affinity: p.affinity || []
    }));
    procs.forEach(p => memory.registerProcess(p));

    const cores = Array.from({ length: numCores }, (_, id) =>
      ({ id, busy: false, proc: null, quantumLeft: 0 }));
    const ready = [];
    let now = 0;
    let contextSwitches = 0;
    const gantt = [];

    while (now < maxTime) {
      now++;

      // 1. Arrivals
      for (const p of procs) {
        if (p.state === 'NEW' && p.arrival <= now) {
          p.state = 'READY';
          ready.push(p);
        }
      }

      // 2. Preemption
      const runningMap = new Map(cores.filter(c => c.busy).map(c => [c.id, c.proc]));
      const preempt = preemptionCandidates(algorithm, ready, runningMap);
      for (const coreId of preempt) {
        const c = cores[coreId];
        if (!c.busy) continue;
        c.proc.state = 'READY';
        ready.push(c.proc);
        gantt.push({ coreId, pid: c.proc.pid, start: c.startedAt, end: now - 1 });
        c.busy = false; c.proc = null;
      }

      // 3. Dispatch
      sortReady(ready, algorithm, now);
      for (let i = 0; i < cores.length && ready.length > 0; i++) {
        if (cores[i].busy) continue;
        const idx = ready.findIndex(p =>
          !p.affinity || p.affinity.length === 0 || p.affinity.includes(i));
        if (idx < 0) continue;
        const proc = ready.splice(idx, 1)[0];
        proc.state = 'RUNNING';
        if (proc.firstRun === null) proc.firstRun = now - 1;
        cores[i].busy = true;
        cores[i].proc = proc;
        cores[i].quantumLeft = quantumFor(algorithm, proc, quantum);
        cores[i].startedAt = now - 1;
        contextSwitches++;
      }

      // 4. Execute one tick on each busy core (one page reference per tick).
      for (const c of cores) {
        if (!c.busy) continue;
        const p = c.proc;
        const page = memory.pageForStep(p.pid, p.executed);
        if (page != null) memory.reference(p.pid, page);
        p.executed++;
        p.remaining--;
        c.quantumLeft--;
        if (p.remaining <= 0) {
          p.state = 'TERMINATED';
          p.completion = now;
          gantt.push({ coreId: c.id, pid: p.pid, start: c.startedAt, end: now });
          c.busy = false; c.proc = null;
        } else if (c.quantumLeft <= 0) {
          p.state = 'READY';
          if (algorithm === 'MLFQ') {
            p.queueLevel = Math.min(p.queueLevel + 1,
              window.SchedulerLogic.MLFQ_LEVELS - 1);
          }
          ready.push(p);
          gantt.push({ coreId: c.id, pid: p.pid, start: c.startedAt, end: now });
          c.busy = false; c.proc = null;
        }
      }

      if (procs.every(p => p.state === 'TERMINATED')) break;
    }

    const completed = procs.filter(p => p.completion != null);
    const safeAvg = (sel) =>
      completed.length === 0 ? 0
      : completed.reduce((s, p) => s + sel(p), 0) / completed.length;
    const avgTat  = safeAvg(p => p.completion - p.arrival);
    const avgWait = safeAvg(p => p.completion - p.arrival - p.burst);
    const avgResp = safeAvg(p => (p.firstRun ?? p.arrival) - p.arrival);
    const totalCoreTime = now * numCores;
    const busyTime = gantt.reduce((s, g) => s + (g.end - g.start), 0);
    const cpuUtil = totalCoreTime === 0 ? 0 : (100 * busyTime / totalCoreTime);
    const throughput = now === 0 ? 0 : completed.length / now;
    const memSummary = memory.summary();

    return {
      algorithm, memAlgo, numCores, quantum, time: now,
      avgTat: +avgTat.toFixed(2),
      avgWait: +avgWait.toFixed(2),
      avgResp: +avgResp.toFixed(2),
      cpuUtil: +cpuUtil.toFixed(1),
      throughput: +throughput.toFixed(3),
      contextSwitches,
      pageFaults: memSummary.faults,
      faultRate: +memSummary.faultRate,
      completed: completed.length,
      total: procs.length
    };
  }

  window.FastSim = { runFast };
})();
