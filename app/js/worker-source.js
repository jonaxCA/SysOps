// Source code for the CPU worker. Stored as a string so it can be loaded
// from a Blob URL — this lets the simulator run by simply opening
// index.html in the browser (no HTTP server required).
//
// Each Worker instance simulates ONE CPU core. It runs in its own OS thread
// (the browser spawns a real thread per Worker), so multiple workers
// executing simultaneously is genuine parallelism — not cooperative
// scheduling on a single thread.
window.WORKER_SOURCE = `
let current = null;
let timer = null;
let tickMs = 200; // wall-clock ms per simulated time unit

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'config':
      tickMs = msg.tickMs;
      // If currently ticking, restart the timer so the new speed kicks in.
      if (timer && current) { stopTicking(); startTicking(); }
      break;
    case 'run':
      current = {
        pid: msg.pid,
        remaining: msg.burst,
        quantum: msg.quantum == null ? Infinity : msg.quantum,
        executed: 0
      };
      startTicking();
      break;
    case 'preempt':
      stopTicking();
      if (current) {
        self.postMessage({ type: 'preempted', pid: current.pid,
                           remaining: current.remaining, executed: current.executed });
        current = null;
      }
      break;
  }
};

function startTicking() {
  stopTicking();
  timer = setInterval(() => {
    if (!current) return;
    // Real CPU work so the worker actually exercises its thread.
    let sink = 0;
    for (let i = 0; i < 80000; i++) sink += Math.sqrt(i + 1);
    current.remaining--;
    current.executed++;
    self.postMessage({ type: 'tick', pid: current.pid,
                       remaining: current.remaining, executed: current.executed });
    if (current.remaining <= 0) {
      stopTicking();
      self.postMessage({ type: 'done', pid: current.pid, executed: current.executed });
      current = null;
    } else if (current.executed >= current.quantum) {
      stopTicking();
      self.postMessage({ type: 'quantum-expired', pid: current.pid,
                         remaining: current.remaining, executed: current.executed });
      current = null;
    }
  }, tickMs);
}

function stopTicking() {
  if (timer) { clearInterval(timer); timer = null; }
}
`;
