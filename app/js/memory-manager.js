// MemoryManager — physical memory + paging + 5 replacement algorithms.
//
// Soporta el modelo de threads y forks:
//   - El "owner" agrupa procesos que comparten memoria (threads).
//   - Forks distintos = owners distintos = páginas separadas.
//   - registerProcess(p) usa p.owner como clave; threads del mismo owner
//     reusan la cadena de referencias y el mismo conjunto de páginas.
//
// Algoritmos de reemplazo: FIFO, LRU, OPT, CLOCK, SC.

(function () {

  function mulberry32(seed) {
    return function () {
      let t = (seed = (seed + 0x6D2B79F5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  function generateRefString(seedKey, numPages, length) {
    const rng = mulberry32(hashStr(seedKey) || 1);
    const refs = [];
    let cur = 0;
    if (numPages <= 0) return refs;
    for (let i = 0; i < length; i++) {
      const r = rng();
      if (r < 0.25) cur = Math.floor(rng() * numPages);
      else if (r < 0.55) cur = (cur + 1) % numPages;
      refs.push(cur);
    }
    return refs;
  }

  class MemoryManager {
    constructor({ memorySize, pageSize, algorithm }) {
      this.memorySize = memorySize;
      this.pageSize = pageSize;
      this.numFrames = Math.max(1, Math.floor(memorySize / pageSize));
      this.algorithm = algorithm;
      this.frames = new Array(this.numFrames).fill(null);
      this.pageFaults = 0;
      this.hits = 0;
      this.now = 0;
      this.fifoQueue = [];
      this.clockHand = 0;
      this.lastEvent = null;
      this.owners = new Map();        // owner -> {refString, numPages, memUsed}
      this.pidToOwner = new Map();    // pid (executable) -> owner
      this.history = [];
    }

    // Acepta tanto un objeto declarado (con .owner) como uno expandido.
    registerProcess(p) {
      const owner = p.owner || p.pid;
      this.pidToOwner.set(p.pid, owner);
      if (this.owners.has(owner)) return; // ya registrado por otro thread del grupo
      this.owners.set(owner, {
        refString: generateRefString(owner, p.pages, Math.max(p.burst, p.pages, 1)),
        numPages: p.pages,
        memUsed: p.memUsed != null ? p.memUsed : p.pages * this.pageSize,
        position: 0
      });
    }

    // Devuelve la página que el ejecutable referencia en su paso N.
    pageForStep(pid, stepIndex) {
      const owner = this.pidToOwner.get(pid) || pid;
      const r = this.owners.get(owner);
      if (!r || r.refString.length === 0) return null;
      return r.refString[stepIndex % r.refString.length];
    }

    reference(pid, pageIdx) {
      this.now++;
      const owner = this.pidToOwner.get(pid) || pid;
      const r = this.owners.get(owner);
      if (r) r.position = Math.min(r.position + 1, r.refString.length);

      // Hit?
      const frameIdx = this.frames.findIndex(f => f && f.owner === owner && f.page === pageIdx);
      if (frameIdx >= 0) {
        this.hits++;
        const f = this.frames[frameIdx];
        f.lastUsedAt = this.now;
        f.refBit = 1;
        const ev = { type: 'hit', t: this.now, pid, owner, page: pageIdx,
                     frame: frameIdx, evicted: null };
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
        owner, page: pageIdx,
        loadedAt: this.now, lastUsedAt: this.now, refBit: 1
      };
      if (this.algorithm === 'FIFO' || this.algorithm === 'SC') this.fifoQueue.push(target);

      const ev = { type: 'fault', t: this.now, pid, owner, page: pageIdx, frame: target,
                   evicted: evicted ? { owner: evicted.owner, page: evicted.page } : null };
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
            const d = this.nextUseDistance(f.owner, f.page);
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
          let safety = this.fifoQueue.length * 4;
          while (safety-- > 0) {
            const i = this.fifoQueue.shift();
            if (this.frames[i].refBit === 0) return i;
            this.frames[i].refBit = 0;
            this.fifoQueue.push(i);
          }
          return 0;
        }
        default: return 0;
      }
    }

    nextUseDistance(owner, pageIdx) {
      const r = this.owners.get(owner);
      if (!r) return Infinity;
      for (let k = r.position; k < r.refString.length; k++) {
        if (r.refString[k] === pageIdx) return k - r.position;
      }
      return Infinity;
    }

    internalFragmentation() {
      let total = 0;
      for (const [owner, r] of this.owners) {
        const loaded = this.frames.filter(f => f && f.owner === owner).length;
        if (loaded === 0) continue;
        const assigned = loaded * this.pageSize;
        const realUsed = r.numPages > 0 ? (r.memUsed * loaded / r.numPages) : assigned;
        total += Math.max(0, assigned - realUsed);
      }
      return total;
    }

    pageTable() {
      const tbl = [];
      for (const [owner, r] of this.owners) {
        for (let p = 0; p < r.numPages; p++) {
          const fi = this.frames.findIndex(f => f && f.owner === owner && f.page === p);
          tbl.push({ owner, page: p, frame: fi >= 0 ? fi : null,
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
