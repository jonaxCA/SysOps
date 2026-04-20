/**
 * ============================================================================
 * SIMULADOR DE SISTEMAS OPERATIVOS — MOTOR LÓGICO (app.js)
 * Versión final corregida y completa.
 *
 * ============================================================================
 */

'use strict';

// ============================================================================
// 1. CLASE PROCESO
// ============================================================================

class Process {
    /**
     * @param {string} id          - Identificador del proceso (PID)
     * @param {number} arrivalTime - Tiempo de llegada al sistema
     * @param {number} burstTime   - Tiempo total de CPU requerido
     * @param {number} priority    - Prioridad (menor número = mayor prioridad)
     * @param {number} numPages    - Número de páginas lógicas del proceso
     */
    constructor(id, arrivalTime, burstTime, priority, numPages) {
        this.id            = id;
        this.arrivalTime   = arrivalTime;
        this.burstTime     = burstTime;
        this.remainingTime = burstTime;
        this.priority      = priority;
        this.numPages      = numPages;

        // Estados posibles: NEW | READY | RUNNING | WAITING | TERMINATED
        this.state = 'NEW';

        // Color único para Gantt y bloques visuales
        this.color = `hsl(${Math.floor(Math.random() * 360)}, 65%, 60%)`;

        // Métricas (calculadas al terminar)
        this.waitingTime    = 0;
        this.turnaroundTime = 0;
        this.completionTime = 0;
        this.ioWaitTime     = 0; // Ticks acumulados en estado WAITING

        /**
         * Cadena de referencias de página pre-generada.
         * Cada posición representa qué página lógica se accede en ese tick de CPU.
         * Es CRÍTICO pre-generarla para que el algoritmo Óptimo pueda consultar
         * los accesos futuros con anticipación.
         */
        this.pageReferenceString = Array.from(
            { length: burstTime },
            () => Math.floor(Math.random() * numPages)
        );
    }

    /**
     * Devuelve una copia del proceso en estado inicial (NEW) pero con la
     * MISMA cadena de referencias de página. Imprescindible para que la
     * comparación de algoritmos sea justa (misma carga de trabajo).
     */
    clone() {
        const c = new Process(
            this.id, this.arrivalTime, this.burstTime,
            this.priority, this.numPages
        );
        c.pageReferenceString = [...this.pageReferenceString];
        c.color               = this.color;
        return c;
    }
}


// ============================================================================
// 2. MÓDULO DE MEMORIA — JERARQUÍA DE CLASES (Herencia)
// ============================================================================

/**
 * Clase base abstracta para algoritmos de reemplazo de páginas.
 * Implementa el flujo común (hit / fault / carga) y delega la política
 * de reemplazo a cada subclase mediante replacePage().
 */
class PageReplacement {
    constructor(numFrames) {
        this.numFrames  = numFrames;
        this.frames     = [];       // Contenido actual de los marcos físicos
        this.pageFaults = 0;
    }

    /** @abstract Debe implementarse en cada subclase */
    replacePage(pageKey, futureReferences) {
        throw new Error(`replacePage() no implementado en ${this.constructor.name}`);
    }

    /**
     * Punto de entrada principal: registra un acceso a página.
     * @param {string} processId       - PID del proceso que accede
     * @param {number} pageNum         - Número de página lógica
     * @param {string[]} futureRefs    - Referencias futuras (para Óptimo)
     * @returns {{ hit, replaced, page }}
     */
    accessPage(processId, pageNum, futureRefs = []) {
        const pageKey = `${processId}-P${pageNum}`;

        // ¿Page Hit?
        if (this.frames.includes(pageKey)) {
            this.onPageHit(pageKey);
            return { hit: true, replaced: null, page: pageKey };
        }

        // Page Fault
        this.pageFaults++;
        let replaced = null;

        if (this.frames.length < this.numFrames) {
            // Aún hay marcos libres
            this.frames.push(pageKey);
            this.onPageLoad(pageKey);
        } else {
            // Marcos llenos: delegar política de reemplazo
            replaced = this.replacePage(pageKey, futureRefs);
        }

        return { hit: false, replaced, page: pageKey };
    }

    /** Hook para subclases: llamado cuando hay un hit */
    onPageHit(pageKey) {}
    /** Hook para subclases: llamado cuando se carga en marco libre */
    onPageLoad(pageKey) {}
}

// ----------------------------------------------------------------------------
// 2a. FIFO — First In, First Out
// ----------------------------------------------------------------------------
class FIFO extends PageReplacement {
    constructor(numFrames) {
        super(numFrames);
        this.queue = []; // Cola de llegada (FIFO puro)
    }

    onPageLoad(pageKey) {
        this.queue.push(pageKey);
    }

    replacePage(pageKey) {
        // Sacar el más antiguo y sustituirlo
        const replaced = this.queue.shift();
        this.frames[this.frames.indexOf(replaced)] = pageKey;
        this.queue.push(pageKey);
        return replaced;
    }
}

// ----------------------------------------------------------------------------
// 2b. LRU — Least Recently Used
// ----------------------------------------------------------------------------
class LRU extends PageReplacement {
    constructor(numFrames) {
        super(numFrames);
        this.usageHistory = []; // Frente = menos usado recientemente
    }

    onPageHit(pageKey) {
        // Al acceder, mover al final (más recientemente usado)
        this.usageHistory = this.usageHistory.filter(p => p !== pageKey);
        this.usageHistory.push(pageKey);
    }

    onPageLoad(pageKey) {
        this.usageHistory.push(pageKey);
    }

    replacePage(pageKey) {
        // El frente es el menos recientemente usado
        const replaced = this.usageHistory.shift();
        this.frames[this.frames.indexOf(replaced)] = pageKey;
        this.usageHistory.push(pageKey);
        return replaced;
    }
}

// ----------------------------------------------------------------------------
// 2c. ÓPTIMO (Algoritmo de Bélady)
// Reemplaza la página que no se usará durante más tiempo en el futuro.
// ----------------------------------------------------------------------------
class Optimal extends PageReplacement {
    replacePage(pageKey, futureRefs) {
        let maxDistance  = -1;
        let replaceIndex = 0; // Fallback: primer marco

        for (let i = 0; i < this.frames.length; i++) {
            const nextUse = futureRefs.indexOf(this.frames[i]);

            if (nextUse === -1) {
                // Esta página nunca se usará más: candidato ideal
                replaceIndex = i;
                break;
            }

            if (nextUse > maxDistance) {
                maxDistance  = nextUse;
                replaceIndex = i;
            }
        }

        const replaced = this.frames[replaceIndex];
        this.frames[replaceIndex] = pageKey;
        return replaced;
    }
}

// ----------------------------------------------------------------------------
// 2d. CLOCK (Reloj Circular)
// Usa un bit de referencia y una aguja que avanza circularmente.
// ----------------------------------------------------------------------------
class Clock extends PageReplacement {
    constructor(numFrames) {
        super(numFrames);
        this.referenceBits = new Array(numFrames).fill(0);
        this.pointer       = 0; // Aguja del reloj
    }

    onPageHit(pageKey) {
        const idx = this.frames.indexOf(pageKey);
        if (idx !== -1) this.referenceBits[idx] = 1;
    }

    onPageLoad(pageKey) {
        // El frame recién cargado recibe segunda oportunidad
        const idx = this.frames.indexOf(pageKey);
        if (idx !== -1) this.referenceBits[idx] = 1;
    }

    replacePage(pageKey) {
        // Girar hasta encontrar un marco con bit = 0
        while (true) {
            if (this.referenceBits[this.pointer] === 0) {
                const replaced = this.frames[this.pointer];
                this.frames[this.pointer]        = pageKey;
                this.referenceBits[this.pointer] = 1;
                this.pointer = (this.pointer + 1) % this.numFrames;
                return replaced;
            }
            // Bit = 1: dar segunda oportunidad (limpiar bit) y avanzar
            this.referenceBits[this.pointer] = 0;
            this.pointer = (this.pointer + 1) % this.numFrames;
        }
    }
}

// ----------------------------------------------------------------------------
// 2e. SEGUNDA OPORTUNIDAD (Second Chance / NRU variante FIFO)
// Similar a Clock pero usa una cola explícita en vez de puntero circular.
// Una página con bit=1 "vuelve al final" antes de ser víctima.
// ----------------------------------------------------------------------------
class SecondChance extends PageReplacement {
    constructor(numFrames) {
        super(numFrames);
        this.queue        = {};   // Map pageKey → posición en cola
        this.queueOrder   = [];   // Array para mantener el orden FIFO
        this.referenceBits = {};  // Map pageKey → bit de referencia
    }

    onPageHit(pageKey) {
        this.referenceBits[pageKey] = 1; // Marcar como referenciada
    }

    onPageLoad(pageKey) {
        this.queueOrder.push(pageKey);
        this.referenceBits[pageKey] = 1;
    }

    replacePage(pageKey) {
        // Girar la cola hasta encontrar una página con bit = 0
        while (true) {
            const candidate = this.queueOrder.shift();

            if (this.referenceBits[candidate] === 0) {
                // Sin segunda oportunidad: reemplazar
                const idx = this.frames.indexOf(candidate);
                this.frames[idx] = pageKey;
                this.queueOrder.push(pageKey);
                this.referenceBits[pageKey] = 1;
                delete this.referenceBits[candidate];
                return candidate;
            }

            // Tiene segunda oportunidad: limpiar bit y enviar al final
            this.referenceBits[candidate] = 0;
            this.queueOrder.push(candidate);
        }
    }
}


// ============================================================================
// 3. PLANIFICADOR DE CPU (Scheduler)
// ============================================================================

class Scheduler {
    /**
     * @param {string} algorithm - 'FCFS' | 'SJF' | 'RR' | 'PRIORITY'
     * @param {number} quantum   - Quantum de Round Robin (ignorado en otros)
     */
    constructor(algorithm = 'FCFS', quantum = 2) {
        this.algorithm         = algorithm;
        this.quantum           = parseInt(quantum) || 2;
        this.currentQuantumTick = 0;

        this.processList        = [];
        this.readyQueue         = [];
        this.waitQueue          = []; // Procesos en estado WAITING (I/O)
        this.currentProcess     = null;

        this.time               = 0;
        this.completedProcesses = [];
    }

    addProcess(p) { this.processList.push(p); }

    /**
     * Envía el proceso actual (o cualquier otro) al estado WAITING.
     * Llamado desde la UI al pulsar el botón "Simular I/O".
     */
    interruptForIO(process) {
        if (!process) return;
        process.state      = 'WAITING';
        process.ioWaitTime = 0;

        if (this.currentProcess === process) {
            this.currentProcess     = null;
            this.currentQuantumTick = 0;
        } else {
            // Si estaba en readyQueue, sacarlo de ahí
            const idx = this.readyQueue.indexOf(process);
            if (idx !== -1) this.readyQueue.splice(idx, 1);
        }

        this.waitQueue.push(process);
    }

    /**
     * Avanza la simulación un tick.
     * Devuelve array de objetos log para que la UI los muestre.
     */
    tick(memoryManager) {
        const logs = [];

        // ── FASE 1: Llegadas ──────────────────────────────────────────────
        this.processList
            .filter(p => p.arrivalTime === this.time && p.state === 'NEW')
            .forEach(p => {
                p.state = 'READY';
                this.readyQueue.push(p);
                logs.push({ type: 'info', msg: `Proceso ${p.id} llega → READY` });
            });

        // ── FASE 2: Retorno de I/O (WAITING → READY) ─────────────────────
        for (let i = this.waitQueue.length - 1; i >= 0; i--) {
            const p = this.waitQueue[i];
            p.ioWaitTime = (p.ioWaitTime || 0) + 1;

            // Regresa con 25% de probabilidad por tick, o después de 4 ticks forzado
            const returns = Math.random() > 0.75 || p.ioWaitTime >= 4;
            if (returns) {
                p.state      = 'READY';
                p.ioWaitTime = 0;
                this.readyQueue.push(p);
                this.waitQueue.splice(i, 1);
                logs.push({
                    type: 'success',
                    msg: `Proceso ${p.id} terminó I/O → READY`,
                    event: 'io-return'
                });
            }
        }

        // ── FASE 3: Ejecución en CPU ──────────────────────────────────────
        if (this.currentProcess) {
            this.currentProcess.remainingTime--;
            this.currentQuantumTick++;

            // Índice dentro de la cadena de referencias de la ráfaga actual
            const burstDone   = this.currentProcess.burstTime - this.currentProcess.remainingTime - 1;
            const requestedPage = this.currentProcess.pageReferenceString[burstDone];

            // Construir referencias futuras para el algoritmo Óptimo:
            // concatenar las páginas pendientes de todos los procesos activos
            const futureRefs = [];
            [this.currentProcess, ...this.readyQueue, ...this.waitQueue].forEach(p => {
                const start = p.burstTime - p.remainingTime;
                p.pageReferenceString
                    .slice(start)
                    .forEach(n => futureRefs.push(`${p.id}-P${n}`));
            });

            const memResult = memoryManager.accessPage(
                this.currentProcess.id,
                requestedPage,
                futureRefs
            );

            if (memResult.hit) {
                logs.push({ type: 'success', msg: `[MEM] Hit → ${memResult.page}` });
            } else {
                let msg = `[MEM] Page Fault → ${memResult.page}`;
                if (memResult.replaced) msg += ` (sale: ${memResult.replaced})`;
                logs.push({ type: 'fault', msg, event: 'fault' });
            }

            // ¿Terminó la ráfaga?
            if (this.currentProcess.remainingTime === 0) {
                const p             = this.currentProcess;
                p.state             = 'TERMINATED';
                p.completionTime    = this.time + 1;
                p.turnaroundTime    = p.completionTime - p.arrivalTime;
                p.waitingTime       = p.turnaroundTime - p.burstTime;

                this.completedProcesses.push(p);
                logs.push({
                    type: 'warning',
                    msg:  `Proceso ${p.id} TERMINADO — TAT: ${p.turnaroundTime}, WT: ${p.waitingTime}`
                });
                this.currentProcess = null;
            }
            // ¿Agotó el quantum? (sólo Round Robin)
            else if (this.algorithm === 'RR' && this.currentQuantumTick >= this.quantum) {
                this.currentProcess.state = 'READY';
                this.readyQueue.push(this.currentProcess);
                logs.push({
                    type:  'info',
                    msg:   `Proceso ${this.currentProcess.id} agota Quantum → READY`,
                    event: 'rr-preempt'
                });
                this.currentProcess = null;
            }
        }

        // ── FASE 4: Selección del siguiente proceso ───────────────────────
        if (!this.currentProcess && this.readyQueue.length > 0) {
            // Ordenar la cola según el algoritmo de planificación
            if (this.algorithm === 'SJF') {
                // Shortest Job First: menor tiempo restante primero
                this.readyQueue.sort((a, b) => a.remainingTime - b.remainingTime);
            } else if (this.algorithm === 'PRIORITY') {
                // Menor número = mayor prioridad
                this.readyQueue.sort((a, b) => a.priority - b.priority);
            }
            // FCFS y RR no reordenan la cola

            this.currentProcess     = this.readyQueue.shift();
            this.currentProcess.state = 'RUNNING';
            this.currentQuantumTick = 0;
            logs.push({ type: 'success', msg: `CPU → ejecuta ${this.currentProcess.id}` });
        }

        this.time++;
        return logs;
    }

    /**
     * La simulación termina cuando TODOS los procesos completaron su ejecución.
     * Procesos aún en waitQueue NO están terminados.
     */
    isFinished() {
        return (
            this.processList.length > 0 &&
            this.completedProcesses.length === this.processList.length
        );
    }
}


// ============================================================================
// 4. CONTROLADOR GLOBAL — OS_Simulator
// ============================================================================

const OS_Simulator = {
    scheduler:     null,
    memoryManager: null,
    interval:      null,
    speed:         800,

    /**
     * Buffer de procesos añadidos ANTES de que el usuario pulse "Iniciar".
     * Se transfieren al scheduler en init() para no perderlos.
     */
    _pendingProcesses: [],

    /**
     * Configuración de hardware leída del archivo.
     * La UI puede consultarla tras loadFromFile() para actualizar sus campos.
     */
    hardwareConfig: { memSize: 64, pageSize: 8, numFrames: 8 },

    // ── Inicialización ────────────────────────────────────────────────────

    /**
     * Crea el scheduler y el gestor de memoria con la configuración elegida.
     * Transfiere automáticamente los procesos del buffer.
     *
     * @param {string} cpuAlgo   - Algoritmo CPU: 'FCFS'|'SJF'|'RR'|'PRIORITY'
     * @param {number} quantum   - Quantum (Round Robin)
     * @param {string} memAlgo   - Algoritmo memoria: 'FIFO'|'LRU'|'OPTIMAL'|'CLOCK'|'SECOND_CHANCE'
     * @param {number} numFrames - Número de marcos físicos
     */
    init(cpuAlgo, quantum, memAlgo, numFrames) {
        this.scheduler     = new Scheduler(cpuAlgo, quantum);
        this.memoryManager = this._buildMemManager(memAlgo, numFrames);

        // Volcar buffer de procesos al nuevo scheduler
        this._pendingProcesses.forEach(p => this.scheduler.addProcess(p));
        this._pendingProcesses = [];
    },

    /** Fábrica interna de algoritmos de memoria */
    _buildMemManager(algo, frames) {
        switch (algo) {
            case 'LRU':          return new LRU(frames);
            case 'OPTIMAL':      return new Optimal(frames);
            case 'CLOCK':        return new Clock(frames);
            case 'SECOND_CHANCE': return new SecondChance(frames);
            default:             return new FIFO(frames);
        }
    },

    // ── Gestión de procesos ───────────────────────────────────────────────

    /**
     * Añade un proceso.
     * Si el scheduler aún no existe, el proceso se guarda en el buffer
     * y se transferirá en el momento en que se llame a init().
     */
    addProcess(pid, arrivalTime, burstTime, priority, numPages) {
        const p = new Process(pid, arrivalTime, burstTime, priority, numPages);

        if (this.scheduler) {
            this.scheduler.addProcess(p);
        } else {
            this._pendingProcesses.push(p);
        }

        return p; // Devuelto para que la UI pueda añadir feedback visual
    },

    // ── Carga desde archivo ───────────────────────────────────────────────

    /**
     * Parsea un archivo .txt con dos bloques opcionales:
     *
     *   Bloque 1 — Configuración de hardware (una clave por línea):
     *     Memoria=64
     *     PageSize=8
     *     Frames=8
     *
     *   Bloque 2 — Procesos (una línea por proceso):
     *     PID,Arrival,Burst,Priority,Pages
     *
     *   Las líneas que comiencen con # se ignoran (comentarios).
     *   El orden de los bloques es indiferente.
     *
     * @param {File}     file      - Objeto File del input
     * @param {Function} callback  - cb(processesAdded, hardwareConfig)
     */
    loadFromFile(file, callback) {
        const reader = new FileReader();

        reader.onload = (e) => {
            const lines           = e.target.result.split(/\r?\n/);
            let   processesAdded  = 0;
            const parsedHW        = {};

            lines.forEach(rawLine => {
                const line = rawLine.trim();

                // Ignorar vacías y comentarios
                if (!line || line.startsWith('#')) return;

                // ── Línea de configuración: Clave=Valor ──
                if (line.includes('=') && !line.includes(',')) {
                    const eqIdx  = line.indexOf('=');
                    const key    = line.slice(0, eqIdx).trim().toLowerCase();
                    const val    = parseInt(line.slice(eqIdx + 1).trim());

                    if (!isNaN(val)) {
                        if      (key === 'memoria'  || key === 'memory')     parsedHW.memSize  = val;
                        else if (key === 'pagesize' || key === 'tamañopagina' || key === 'tamanopagina') parsedHW.pageSize = val;
                        else if (key === 'frames'   || key === 'marcos')     parsedHW.numFrames = val;
                    }
                    return;
                }

                // ── Línea de proceso: PID,Arrival,Burst,Priority,Pages ──
                const parts = line.split(',');
                if (parts.length >= 5) {
                    const pid   = parts[0].trim();
                    const arr   = parseInt(parts[1]);
                    const burst = parseInt(parts[2]);
                    const prio  = parseInt(parts[3]);
                    const pages = parseInt(parts[4]);

                    if (pid && [arr, burst, prio, pages].every(n => !isNaN(n))) {
                        this.addProcess(pid, arr, burst, prio, pages);
                        processesAdded++;
                    }
                }
            });

            // Actualizar hardwareConfig con lo que se encontró
            if (Object.keys(parsedHW).length > 0) {
                this.hardwareConfig = { ...this.hardwareConfig, ...parsedHW };

                // Si se especificaron memoria y tamaño de página pero no frames,
                // calcular frames automáticamente
                if (!parsedHW.numFrames && parsedHW.memSize && parsedHW.pageSize) {
                    this.hardwareConfig.numFrames = Math.max(
                        1,
                        Math.floor(parsedHW.memSize / parsedHW.pageSize)
                    );
                }
            }

            if (callback) callback(processesAdded, this.hardwareConfig);
        };

        reader.onerror = () => {
            if (callback) callback(0, {});
        };

        reader.readAsText(file);
    },

    // ── Comparación real de algoritmos ────────────────────────────────────

    /**
     * Ejecuta los 5 algoritmos de reemplazo de páginas en modo silencioso
     * (sin actualizar UI) usando clones del proceso actual para garantizar
     * que todos parten de la misma carga de trabajo.
     *
     * Devuelve un objeto { FIFO, LRU, OPTIMAL, CLOCK, SECOND_CHANCE }
     * con el número real de page faults de cada algoritmo.
     *
     * @param {number} numFrames - Marcos físicos a usar en la comparación
     * @returns {Object|null}
     */
    runComparison(numFrames) {
        if (!this.scheduler || this.scheduler.processList.length === 0) return null;

        const ALGOS   = ['FIFO', 'LRU', 'OPTIMAL', 'CLOCK', 'SECOND_CHANCE'];
        const results = {};
        const TICK_LIMIT = 15000; // Salvaguarda contra bucles infinitos

        ALGOS.forEach(algo => {
            // Clonar lista de procesos (misma cadena de referencias → comparación justa)
            const clones = this.scheduler.processList.map(p => p.clone());

            // Crear scheduler temporal con el mismo algoritmo CPU
            const tempScheduler = new Scheduler(
                this.scheduler.algorithm,
                this.scheduler.quantum
            );
            clones.forEach(p => tempScheduler.addProcess(p));

            const tempMem = this._buildMemManager(algo, numFrames);

            // Simular hasta que todos terminen
            let ticks = 0;
            while (!tempScheduler.isFinished() && ticks < TICK_LIMIT) {
                tempScheduler.tick(tempMem);
                ticks++;
            }

            results[algo] = tempMem.pageFaults;
        });

        return results;
    },

    // ── Control de simulación ─────────────────────────────────────────────

    /**
     * Arranca (o reanuda) el bucle principal.
     * uiUpdateCallback recibe un snapshot del estado en cada tick.
     */
    start(uiUpdateCallback) {
        if (this.interval) return; // Ya corriendo, no duplicar

        this.interval = setInterval(() => {
            // ¿Terminaron todos los procesos?
            if (this.scheduler.isFinished()) {
                this.pause();
                uiUpdateCallback({
                    status: 'finished',
                    logs: [{ type: 'warning', msg: '✓ Simulación completada.' }]
                });
                return;
            }

            const logs = this.scheduler.tick(this.memoryManager);

            uiUpdateCallback({
                status:     'running',
                time:       this.scheduler.time,
                cpuProcess: this.scheduler.currentProcess,
                readyQueue: [...this.scheduler.readyQueue],
                waitQueue:  [...this.scheduler.waitQueue],
                frames:     [...this.memoryManager.frames],
                pageFaults: this.memoryManager.pageFaults,
                metrics:    [...this.scheduler.completedProcesses],
                logs
            });

        }, this.speed);
    },

    /** Pausa el bucle de simulación (mantiene el estado). */
    pause() {
        clearInterval(this.interval);
        this.interval = null;
    },

    /**
     * Reinicio completo: destruye scheduler, memoria y buffer.
     * La UI es responsable de limpiar su propio estado visual.
     */
    reset() {
        this.pause();
        this.scheduler         = null;
        this.memoryManager     = null;
        this._pendingProcesses = [];
        this.hardwareConfig    = { memSize: 64, pageSize: 8, numFrames: 8 };
    },

    /**
     * Cambia la velocidad de simulación.
     * SOLO pausa el intervalo; la UI debe reinvocar start(callback)
     * para reanudar con la nueva velocidad.
     */
    setSpeed(ms) {
        this.speed = Math.max(50, parseInt(ms) || 800);
        this.pause();
        // La UI se encarga de volver a llamar start(updateUI) si estaba corriendo
    }
};

// Exponer en window para que index.html lo consuma
window.OS_Simulator = OS_Simulator;
