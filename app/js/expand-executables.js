// expand-executables.js — convierte la lista declarada de procesos
// (con campos T = threads, F = forks) en la lista real de "ejecutables"
// que el scheduler procesa.
//
// Reglas:
//   - Cada proceso declarado genera (F+1) "grupos de memoria":
//     el original + 1 fork por cada F. Los forks duplican páginas.
//   - Cada grupo de memoria genera T "ejecutables" (threads).
//     Los threads del mismo grupo comparten páginas.
//
// Naming:
//   T=1 F=0 → "P1"                          (1 ejecutable)
//   T=3 F=0 → "P1.t0", "P1.t1", "P1.t2"    (3 ejecutables, todos comparten owner "P1")
//   T=1 F=2 → "P1", "P1a", "P1b"           (3 ejecutables, owners distintos)
//   T=2 F=2 → "P1.t0", "P1.t1",
//             "P1a.t0", "P1a.t1",
//             "P1b.t0", "P1b.t1"            (6 ejecutables, 3 owners)

(function () {

  // Letras para forks: a, b, c, d, e
  const FORK_SUFFIX = ['', 'a', 'b', 'c', 'd', 'e', 'f'];

  function expandExecutables(processList) {
    const out = [];
    for (const p of processList) {
      const T = Math.max(1, Math.min(8, p.threads || 1));
      const F = Math.max(0, Math.min(5, p.forks || 0));

      for (let f = 0; f <= F; f++) {
        // Owner = grupo de memoria. Threads del mismo owner comparten páginas;
        // forks distintos = owners distintos.
        const ownerName = p.pid + (FORK_SUFFIX[f] || ('f' + f));

        for (let t = 0; t < T; t++) {
          // Si T=1, no agregamos sufijo .t0 (queda más limpio).
          const threadSuffix = T > 1 ? '.t' + t : '';
          const execPid = ownerName + threadSuffix;

          out.push({
            pid: execPid,
            basePid: p.pid,           // PID declarado (para agrupar visualmente)
            owner: ownerName,         // grupo de memoria
            kind: f === 0 ? 'thread' : 'fork',
            threadIdx: t,
            forkIdx: f,
            arrival: p.arrival,
            burst: p.burst,
            priority: p.priority || 0,
            pages: p.pages || 0,
            affinity: p.affinity || [],
            queueLevel: p.queueLevel || 0
          });
        }
      }
    }
    return out;
  }

  // Cuenta cuántos ejecutables generaría la lista actual (preview en UI).
  function countExecutables(processList) {
    let total = 0;
    for (const p of processList) {
      const T = Math.max(1, Math.min(8, p.threads || 1));
      const F = Math.max(0, Math.min(5, p.forks || 0));
      total += T * (F + 1);
    }
    return total;
  }

  window.expandExecutables = expandExecutables;
  window.countExecutables = countExecutables;
})();
