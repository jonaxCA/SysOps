// MemoryManager — physical memory + paging + 5 replacement algorithms.
//
// Responsibilities:
//   * Hold a fixed set of frames (memorySize / pageSize).
//   * Resolve page references (pid, pageIdx). Hit -> update bookkeeping.
//     Miss (page fault) -> load into a free frame, or evict a victim per the
//     selected algorithm (FIFO, LRU, OPT, CLOCK, SC).
//   * Track total faults / hits, internal fragmentation, and a "lastEvent"
//     used by the UI to animate which page just entered/left.
//
// Reference strings are precomputed per process at registration so OPT can
// look ahead deterministically.

(function () {

  // Tiny PRNG so each PID generates the same reference string across runs.
  function mulberry32(seed) {
    return function () {
      let t = (seed = (seed + 0x6D2B79F5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashPid(pid) {
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) | 0;
    return h;
  }
  // Reference pattern: locality with occasional jumps (educational).
  function generateRefString(pid, numPages, length) {
    const rng = mulberry32(hashPid(pid) || 1);
    const refs = [];
    let cur = 0;
    if (numPages <= 0) return refs;
    for (let i = 0; i < length; i++) {
      const r = rng();
      if (r < 0.25) cur = Math.floor(rng() * numPages);              // jump
      else if (r < 0.55) cur = (cur + 1) % numPages;                  // sequential
      // else: stay on current page (locality)
      refs.push(cur);
    }
    return refs;
  }

  class MemoryManager {
    constructor({ memorySize, pageSize, algorithm }) {
      this.memorySize = memorySize;
      this.pageSize = pageSize;
      this.numFrames = Math.max(1, Math.floor(memorySize / pageSize));
      this.algorithm = algorithm;             // FIFO | LRU | OPT | CLOCK | SC
      this.frames = new Array(this.numFrames).fill(null);
      this.pageFaults = 0;
      this.hits = 0;
      this.now = 0;                           // logical reference counter
      this.fifoQueue = [];                    // frame indices, oldest first
      this.clockHand = 0;
      this.lastEvent = null;
      this.processRefs = new Map();           // pid -> {refString, position, numPages, memUsed}
      this.history = [];                      // [{t, pid, page, hit, frame, evicted}]
    }

    registerProcess(p) {
      this.processRefs.set(p.pid, {
        refString: generateRefString(p.pid, p.pages, Math.max(p.burst, p.pages)),
        position: 0,
        numPages: p.pages,
        memUsed: p.memUsed != null ? p.memUsed : p.pages * this.pageSize
      });
    }

    // Get the page about to be referenced for this process at its given step.
    pageForStep(pid, stepIndex) {
      const r = this.processRefs.get(pid);
      if (!r || r.refString.length === 0) return null;
      return r.refString[stepIndex % r.refString.length];
    }

    // Resolve one reference. Returns event object.
    reference(pid, pageIdx) {
      this.now++;
      const procRef = this.processRefs.get(pid);
      if (procRef) procRef.position = Math.min(procRef.position + 1, procRef.refString.length);

      // Hit?
      const frameIdx = this.frames.findIndex(f => f && f.pid === pid && f.page === pageIdx);
      if (frameIdx >= 0) {
        this.hits++;
        const f = this.frames[frameIdx];
        f.lastUsedAt = this.now;
        f.refBit = 1;
        const ev = { type: 'hit', t: this.now, pid, page: pageIdx, frame: frameIdx, evicted: null };
        this.lastEvent = ev;
        this.history.push(ev);
        return ev;
      }

      // Page fault.
      this.pageFaults++;
      let target = this.frames.findIndex(f => f === null);
      let evicted = null;
      if (target < 0) {
        target = this.pickVictim();
        evicted = this.frames[target];
        if (this.algorithm === 'FIFO' || this.algorithm === 'SC') {
          this.fifoQueue = this.fifoQueue.filter(i => i !== target);
        }
      }
      this.frames[target] = {
        pid, page: pageIdx,
        loadedAt: this.now, lastUsedAt: this.now, refBit: 1
      };
      if (this.algorithm === 'FIFO' || this.algorithm === 'SC') this.fifoQueue.push(target);

      const ev = { type: 'fault', t: this.now, pid, page: pageIdx, frame: target,
                   evicted: evicted ? { pid: evicted.pid, page: evicted.page } : null };
      this.lastEvent = ev;
      this.history.push(ev);
      return ev;
    }

    pickVictim() {
      switch (this.algorithm) {
        case 'FIFO':
          return this.fifoQueue[0];
        case 'LRU': {
          let oldest = 0;
          for (let i = 1; i < this.frames.length; i++) {
            if (this.frames[i].lastUsedAt < this.frames[oldest].lastUsedAt) oldest = i;
          }
          return oldest;
        }
        case 'OPT': {
          let pick = 0, farthest = -1;
          for (let i = 0; i < this.frames.length; i++) {
            const f = this.frames[i];
            const d = this.nextUseDistance(f.pid, f.page);
            if (d > farthest) { farthest = d; pick = i; }
          }
          return pick;
        }
        case 'CLOCK': {
          let safety = this.frames.length * 4;
          while (safety-- > 0) {
            const i = this.clockHand;
            if (this.frames[i].refBit === 0) {
              this.clockHand = (i + 1) % this.frames.length;
              return i;
            }
            this.frames[i].refBit = 0;
            this.clockHand = (i + 1) % this.frames.length;
          }
          return this.clockHand;
        }
        case 'SC': {
          // Second chance: walk fifoQueue; clear refBit=1 and rotate.
          let safety = this.fifoQueue.length * 4;
          while (safety-- > 0) {
            const i = this.fifoQueue.shift();
            if (this.frames[i].refBit === 0) {
              // caller will re-insert; but we also need to keep ordering for non-victim case
              // Since we only call pickVictim when evicting, this i is the victim.
              return i;
            }
            this.frames[i].refBit = 0;
            this.fifoQueue.push(i);
          }
          return 0;
        }
        default: return 0;
      }
    }

    nextUseDistance(pid, pageIdx) {
      const r = this.processRefs.get(pid);
      if (!r) return Infinity;
      for (let k = r.position; k < r.refString.length; k++) {
        if (r.refString[k] === pageIdx) return k - r.position;
      }
      return Infinity;
    }

    // Internal fragmentation: assigned page space minus actual use, summed across processes.
    // Counts only pages currently loaded for each process (visible frag).
    internalFragmentation() {
      let total = 0;
      for (const [pid, r] of this.processRefs) {
        const loaded = this.frames.filter(f => f && f.pid === pid).length;
        if (loaded === 0) continue;
        const assigned = loaded * this.pageSize;
        // approximate: process uses (memUsed * loaded / numPages) of its allotted space
        const realUsed = r.numPages > 0 ? (r.memUsed * loaded / r.numPages) : assigned;
        total += Math.max(0, assigned - realUsed);
      }
      return total;
    }

    pageTable() {
      // Per process: which pages are in memory and where.
      const tbl = [];
      for (const [pid, r] of this.processRefs) {
        for (let p = 0; p < r.numPages; p++) {
          const fi = this.frames.findIndex(f => f && f.pid === pid && f.page === p);
          tbl.push({ pid, page: p, frame: fi >= 0 ? fi : null,
                     valid: fi >= 0, ref: fi >= 0 ? this.frames[fi].refBit : 0 });
        }
      }
      return tbl;
    }

    summary() {
      const refs = this.pageFaults + this.hits;
      return {
        faults: this.pageFaults,
        hits: this.hits,
        refs,
        faultRate: refs === 0 ? '0' : (100 * this.pageFaults / refs).toFixed(1),
        framesUsed: this.frames.filter(f => f !== null).length,
        framesTotal: this.numFrames,
        intFrag: this.internalFragmentation().toFixed(1),
        algorithm: this.algorithm
      };
    }
  }

  window.MemoryManager = MemoryManager;
})();
