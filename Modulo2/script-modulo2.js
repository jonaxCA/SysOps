// ==========================================
//   SIMULADOR DE SISTEMAS OPERATIVOS
//   app.js - Lógica completa de CPU y Memoria
// ==========================================

// ---------- ESTADO GLOBAL ----------
let processes = [];                 // Procesos originales
let readyQueue = [];                // Índices de procesos en ready
let waitingQueue = [];              // Índices en waiting (I/O)
let currentProcess = null;          // Índice del proceso en CPU
let clock = 0;                     // Reloj actual (ticks)
let gantt = [];                    // { pid, start, end }
let terminatedProcesses = [];       // Procesos finalizados con métricas

let simulationInterval = null;
let isRunning = false;
let speed = 800;                   // ms entre ticks

let cpuAlgorithm = 'FCFS';
let quantum = 2;                   // Solo para RR

// Memoria
let memoryFrames = [];
let frameCount = 8;
let pageSize = 8;
let memorySize = 64;
let pageFaults = 0;
let replacementAlgorithm = 'FIFO';
let pageTable = new Map();         // clave: `${pid}-${page}`, valor: { frame, valid, lastUsed }

// Elementos DOM
const readyQueueDiv = document.getElementById('ready-queue');
const waitingQueueDiv = document.getElementById('waiting-queue');
const ganttChartDiv = document.getElementById('gantt-chart');
const metricsTbody = document.getElementById('metrics-tbody');
const clockDisplay = document.getElementById('clock-display');
const eventLog = document.getElementById('event-log');
const pageFaultsSpan = document.getElementById('page-faults');
//const memoryGrid = document.getElementById('memory-grid');
//const pageTableBody = document.getElementById('page-table-body');
const promedios = document.getElementById('promedios');
const processListUI = document.getElementById('process-list-ui');

// ---------- INICIALIZACIÓN ----------
document.addEventListener('DOMContentLoaded', () => {
    initMemory();
    updateUI();
    attachEvents();
});

function attachEvents() {
    document.getElementById('btn-start').addEventListener('click', startSimulation);
    document.getElementById('btn-pause').addEventListener('click', pauseSimulation);
    document.getElementById('btn-reset').addEventListener('click', resetSimulation);
    document.getElementById('btn-add-process').addEventListener('click', addProcessFromForm);
    document.getElementById('btn-preload').addEventListener('click', preloadExample);
    document.getElementById('cpu-algo').addEventListener('change', onAlgorithmChange);
    document.getElementById('cpu-quantum').addEventListener('change', e => quantum = parseInt(e.target.value));
    document.getElementById('speed-slider').addEventListener('input', e => speed = parseInt(e.target.value));
    document.getElementById('file-upload').addEventListener('change', loadFromFile);
    document.getElementById('btn-compare').addEventListener('click', compareAlgorithms);
    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('compare-modal').classList.remove('active');
    });
}

function onAlgorithmChange() {
    const algo = document.getElementById('cpu-algo').value;
    cpuAlgorithm = algo;
    document.getElementById('cpu-quantum').style.display = algo === 'RR' ? 'inline-block' : 'none';
}

// ---------- GESTIÓN DE PROCESOS ----------
function addProcessFromForm() {
    const id = document.getElementById('p-id').value.trim();
    const arrival = parseInt(document.getElementById('p-arrival').value);
    const burst = parseInt(document.getElementById('p-burst').value);
    const priority = parseInt(document.getElementById('p-priority').value) || 1;
    const pages = parseInt(document.getElementById('p-pages').value) || 4;

    if (!id || isNaN(arrival) || isNaN(burst)) {
        alert('Complete PID, Arrival y Burst');
        return;
    }

    const newProcess = {
        pid: id,
        arrival,
        burst,
        burstRemaining: burst,
        priority,
        pages,
        state: 'NEW',
        completionTime: null,
        turnaroundTime: null,
        waitingTime: 0,
        lastEnqueueTime: arrival,
        ioWaitRemaining: 0,        // Simulación simple de I/O
    };
    processes.push(newProcess);
    updateProcessListUI();
    clearProcessForm();
    logEvent(`Proceso ${id} añadido (llegada: ${arrival}, ráfaga: ${burst})`);
}

function clearProcessForm() {
    document.getElementById('p-id').value = '';
    document.getElementById('p-arrival').value = '';
    document.getElementById('p-burst').value = '';
    document.getElementById('p-priority').value = '';
    document.getElementById('p-pages').value = '4';
}

function updateProcessListUI() {
    processListUI.innerHTML = processes.map(p =>
        `<li>${p.pid} | Arr:${p.arrival} | Burst:${p.burst} | Prio:${p.priority}</li>`
    ).join('');
}

function preloadExample() {
    processes = [
        { pid: 'P1', arrival: 0, burst: 5, burstRemaining: 5, priority: 2, pages: 4, state: 'NEW', waitingTime: 0, lastEnqueueTime: 0, ioWaitRemaining: 0 },
        { pid: 'P2', arrival: 1, burst: 3, burstRemaining: 3, priority: 1, pages: 3, state: 'NEW', waitingTime: 0, lastEnqueueTime: 1, ioWaitRemaining: 0 },
        { pid: 'P3', arrival: 2, burst: 8, burstRemaining: 8, priority: 3, pages: 5, state: 'NEW', waitingTime: 0, lastEnqueueTime: 2, ioWaitRemaining: 0 },
        { pid: 'P4', arrival: 3, burst: 2, burstRemaining: 2, priority: 1, pages: 2, state: 'NEW', waitingTime: 0, lastEnqueueTime: 3, ioWaitRemaining: 0 },
    ];
    cpuAlgorithm = 'RR';
    document.getElementById('cpu-algo').value = 'RR';
    document.getElementById('cpu-quantum').style.display = 'inline-block';
    quantum = 2;
    updateProcessListUI();
    resetSimulation();
    logEvent('Ejemplo precargado: 4 procesos, Round Robin (q=2)');
}

// ---------- CARGA DESDE ARCHIVO ----------
function loadFromFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        const lines = ev.target.result.split('\n');
        processes = [];
        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('Memoria=')) memorySize = parseInt(line.split('=')[1]);
            else if (line.startsWith('PageSize=')) pageSize = parseInt(line.split('=')[1]);
            else if (line.startsWith('Frames=')) {
                frameCount = parseInt(line.split('=')[1]);
                initMemory();
            } else if (line.includes(',')) {
                const parts = line.split(',').map(s => s.trim());
                if (parts.length >= 5) {
                    processes.push({
                        pid: parts[0],
                        arrival: parseInt(parts[1]),
                        burst: parseInt(parts[2]),
                        burstRemaining: parseInt(parts[2]),
                        priority: parseInt(parts[3]),
                        pages: parseInt(parts[4]),
                        state: 'NEW',
                        waitingTime: 0,
                        lastEnqueueTime: parseInt(parts[1]),
                        ioWaitRemaining: 0
                    });
                }
            }
        });
        updateProcessListUI();
        resetSimulation();
        logEvent(`Configuración cargada desde ${file.name}`);
    };
    reader.readAsText(file);
}

// ---------- SIMULACIÓN ----------
function startSimulation() {
    if (isRunning) return;
    if (processes.length === 0) {
        alert('Añade al menos un proceso');
        return;
    }
    isRunning = true;
    simulationInterval = setInterval(tick, speed);
}

function pauseSimulation() {
    isRunning = false;
    clearInterval(simulationInterval);
}

function resetSimulation() {
    pauseSimulation();
    clock = 0;
    readyQueue = [];
    waitingQueue = [];
    currentProcess = null;
    gantt = [];
    terminatedProcesses = [];
    pageFaults = 0;
    pageFaultsSpan.textContent = '0';
    
    processes.forEach(p => {
        p.state = 'NEW';
        p.burstRemaining = p.burst;
        p.completionTime = null;
        p.turnaroundTime = null;
        p.waitingTime = 0;
        p.lastEnqueueTime = p.arrival;
        p.ioWaitRemaining = 0;
    });

    //processes =[];
    
    initMemory();
    updateUI();
    clearEventLog();
    logEvent('Simulación reiniciada');
}

function tick() {
    // 1. Mover procesos nuevos a ready si arrival <= clock
    processes.forEach((p, idx) => {
        if (p.state === 'NEW' && p.arrival <= clock) {
            p.state = 'READY';
            readyQueue.push(idx);
            logEvent(`${p.pid} ha llegado y pasa a READY`);
        }
    });

    // 2. Procesar I/O (simulación simple: reducir contador y mover a ready)
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const idx = waitingQueue[i];
        const p = processes[idx];
        if (p.ioWaitRemaining > 0) {
            p.ioWaitRemaining--;
            if (p.ioWaitRemaining === 0) {
                waitingQueue.splice(i, 1);
                p.state = 'READY';
                readyQueue.push(idx);
                logEvent(`${p.pid} termina I/O y pasa a READY`);
            }
        }
    }

    // 3. Si la CPU está libre, planificar siguiente proceso
    if (currentProcess === null && readyQueue.length > 0) {
        scheduleNext();
    }

    // 4. Ejecutar instrucción del proceso actual
    if (currentProcess !== null) {
        const p = processes[currentProcess];
        p.burstRemaining--;
        
        // Simular page fault simple (10% probabilidad)
        if (Math.random() < 0.1) {
            pageFaults++;
            pageFaultsSpan.textContent = pageFaults;
            logEvent(`Page Fault en ${p.pid}`, 'fault');
            // Simular reemplazo FIFO
            handlePageFault(p.pid, Math.floor(Math.random() * p.pages));
        }

        // Actualizar Gantt
        updateGantt(p.pid);

        // Si terminó
        if (p.burstRemaining === 0) {
            p.state = 'TERMINATED';
            p.completionTime = clock + 1;
            p.turnaroundTime = p.completionTime - p.arrival;
            p.waitingTime = p.turnaroundTime - p.burst;
            terminatedProcesses.push(p);
            logEvent(`${p.pid} ha TERMINADO. TAT: ${p.turnaroundTime}, WT: ${p.waitingTime}`);
            currentProcess = null;
            updateMetricsTable();
            
            // Simular posible I/O (solo decorativo)
        } else {
            if(cpuAlgorithm === 'RR' || cpuAlgorithm === 'SRTF' || cpuAlgorithm === 'PRIORITY'){
                const preempt = Preemptive();
                if (preempt) {
                    // Volver a poner en ready
                    p.state = 'READY';
                    readyQueue.push(currentProcess);
                    logEvent(`${p.pid} expropiado, vuelve a READY`);
                    currentProcess = null;
                    // Planificar de inmediato
                    if (readyQueue.length > 0) scheduleNext();
                } else {
                    // Simular I/O con baja probabilidad
                    if (Math.random() < 0.05) {
                        p.state = 'WAITING';
                        p.ioWaitRemaining = 2 + Math.floor(Math.random() * 3);
                        waitingQueue.push(currentProcess);
                        logEvent(`${p.pid} pasa a WAITING por I/O (${p.ioWaitRemaining} ticks)`);
                        currentProcess = null;
                        if (readyQueue.length > 0) scheduleNext();
                    }
                }
            }
            // (Round Robin o SRTF/Priority preemptive)
        }
    }

    // 5. Si no hay proceso actual pero hay ready, planificar (por si se liberó CPU)
    if (currentProcess === null && readyQueue.length > 0) {
        scheduleNext();
    }

    clock++;
    updateUI();
}

function Preemptive() {
    if (currentProcess === null) return false;
    const p = processes[currentProcess];
    if (cpuAlgorithm === 'RR') {
        // Tiempo en CPU consecutivo: se expropia si supera quantum
        if (gantt.length > 0) {
            const lastBlock = gantt[gantt.length - 1];
            if (lastBlock.pid === p.pid) {
                const duration = clock - lastBlock.start;
                return duration >= quantum;
            }
        }
        return false;
    }
    if (cpuAlgorithm === 'SRTF' || cpuAlgorithm === 'PRIORITY') {
        // Buscar si hay un proceso en ready con mejor burstRemaining/prioridad
        if (readyQueue.length === 0) return false;
        const bestIdx = siguenteProceso(); // no modifica cola
        if (bestIdx === null) return false;
        const best = processes[bestIdx];
        if (cpuAlgorithm === 'SRTF') return best.burstRemaining < p.burstRemaining;
        if (cpuAlgorithm === 'PRIORITY') return best.priority < p.priority;
    }
    return false;
}

function scheduleNext() {
    if (readyQueue.length === 0) return;
    const nextIdx = siguenteProceso();
    if (nextIdx !== null) {
        // Remover de readyQueue
        const pos = readyQueue.indexOf(nextIdx);
        if (pos > -1) readyQueue.splice(pos, 1);
        
        currentProcess = nextIdx;
        processes[currentProcess].state = 'RUNNING';
        logEvent(`${processes[currentProcess].pid} pasa a RUNNING`);
        // Registrar inicio en Gantt si no viene de continuación
        if (gantt.length === 0 || gantt[gantt.length-1].pid !== processes[currentProcess].pid) {
            gantt.push({ pid: processes[currentProcess].pid, start: clock, end: null });
        }
    }
}

function siguenteProceso() {
    if (readyQueue.length === 0) return null;
    const siguente = [...readyQueue];
    switch (cpuAlgorithm) {
        case 'FCFS':
            siguente.sort((a, b) => processes[a].arrival - processes[b].arrival);
            break;
        case 'SJF':
            siguente.sort((a, b) => processes[a].burstRemaining - processes[b].burstRemaining);
            break;
        case 'HRRN': {
            siguente.forEach(idx => {
                const p = processes[idx];
                const waiting = clock - p.lastEnqueueTime;
                p.rr = (waiting + p.burstRemaining) / p.burstRemaining;
            });
            siguente.sort((a, b) => processes[b].rr - processes[a].rr);
            break;
        }
        case 'RR':
            // Se asume orden de llegada (FIFO)
            break;
        case 'PRIORITY':
            siguente.sort((a, b) => processes[a].priority - processes[b].priority);
            break;
        case 'SRTF':
            siguente.sort((a, b) => processes[a].burstRemaining - processes[b].burstRemaining);
            break;
        default: break;
    }
    return siguente[0];
}

// ---------- INTERFAZ DE USUARIO ----------
function updateUI() {
    clockDisplay.textContent = `Tick: ${clock}`;
    renderQueues();
    renderGanttChart();
    //renderMemoryGrid();
    //renderPageTable();
    tablaPromedios();
}

function renderQueues() {
    readyQueueDiv.innerHTML = readyQueue.map(idx => {
        const p = processes[idx];
        return `<div class="process-block">${p.pid}<span class="sub">Rest:${p.burstRemaining}</span></div>`;
    }).join('');
    
    waitingQueueDiv.innerHTML = waitingQueue.map(idx => {
        const p = processes[idx];
        return `<div class="process-block waiting">${p.pid}<span class="sub">IO:${p.ioWaitRemaining}</span></div>`;
    }).join('');
}

function renderGanttChart() {
    ganttChartDiv.innerHTML = '';
    gantt.forEach(block => {
        const div = document.createElement('div');
        div.className = 'gantt-block';
        const width = ((block.end || clock) - block.start) * 25; // px por tick
        div.style.width = width + 'px';
        div.style.backgroundColor = getColorForPid(block.pid);
        div.textContent = block.pid;
        ganttChartDiv.appendChild(div);
    });
}

function updateGantt(pid) {
    if (gantt.length > 0) {
        const last = gantt[gantt.length - 1];
        if (last.pid === pid) {
            last.end = clock + 1;
            return;
        }
    }
    gantt.push({ pid, start: clock, end: clock + 1 });
}

function getColorForPid(pid) {
    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c'];
    let hash = 0;
    for (let i = 0; i < pid.length; i++) hash = pid.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

function updateMetricsTable() {
    metricsTbody.innerHTML = terminatedProcesses.map(p => `
        <tr>
            <td>${p.pid}</td><td>${p.arrival}</td><td>${p.burst}</td><td>${p.completionTime}</td>
            <td>${p.turnaroundTime}</td><td>${p.waitingTime}</td>
        </tr>
    `).join('');
}

function logEvent(msg, type = 'info') {
    const li = document.createElement('li');
    li.textContent = `[${clock}] ${msg}`;
    li.className = type;
    eventLog.prepend(li);
    if (eventLog.children.length > 20) eventLog.removeChild(eventLog.lastChild);
}

function clearEventLog() {
    eventLog.innerHTML = '';
}

// ---------- MEMORIA (BÁSICA) ----------
function initMemory() {
    memoryFrames = new Array(frameCount).fill(null);
    pageTable.clear();
    //renderMemoryGrid();
}

function handlePageFault(pid, page) {
    const key = `${pid}-${page}`;
    if (!pageTable.has(key)) {
        // Buscar frame libre o reemplazar (FIFO simple)
        let frame = memoryFrames.indexOf(null);
        if (frame === -1) {
            frame = Math.floor(Math.random() * frameCount); // simplificado
        }
        memoryFrames[frame] = { pid, page };
        pageTable.set(key, { frame, valid: true, lastUsed: clock });
    }
}

/*function renderMemoryGrid() {
    memoryGrid.innerHTML = '';
    memoryFrames.forEach((content, i) => {
        const div = document.createElement('div');
        div.className = 'frame' + (content ? ' occupied' : '');
        div.innerHTML = `<span class="frame-number">${i}</span>${content ? `${content.pid}-p${content.page}` : 'Libre'}`;
        memoryGrid.appendChild(div);
    });
}*/

/*function renderPageTable() {
    pageTableBody.innerHTML = '';
    for (let [key, entry] of pageTable.entries()) {
        const [pid, page] = key.split('-');
        const row = document.createElement('tr');
        row.className = 'in-memory';
        row.innerHTML = `<td>${pid}</td><td>${page}</td><td>${entry.frame}</td><td>Válido</td>`;
        pageTableBody.appendChild(row);
    }
}*/

function tablaPromedios(){
    if(processes.length>0 && (processes.length == terminatedProcesses.length)){
        promedios.innerHTML='';
        let promW=0;
        let promT=0;
        for (let i=0;i<terminatedProcesses.length;i++){
            promW=promW+terminatedProcesses[i].waitingTime;
            promT=promT+terminatedProcesses[i].turnaroundTime;
        }
        promW=promW/terminatedProcesses.length;
        promT=promT/terminatedProcesses.length;
        const row = document.createElement('tr');
        row.className = 'in-memory';
        row.innerHTML = `<td>${promT}</td><td>${promW}</td>`;
        promedios.appendChild(row);
        pauseSimulation();
    }
}


// ---------- COMPARACIÓN DE ALGORITMOS ----------
// en proceso.....
function compareAlgorithms() {
    const modal = document.getElementById('compare-modal');
    const chartDiv = document.getElementById('compare-chart');
    modal.classList.add('active');
    
    const algos = ['FCFS', 'SJF', 'HRRN'];
    const faults = algos.map(() => Math.floor(Math.random() * 20 + 5)); // Simulado
    const maxFaults = Math.max(...faults);
    
    chartDiv.innerHTML = algos.map((algo, i) => `
        <div class="bar-container">
            <div class="bar" style="height: ${(faults[i]/maxFaults)*200}px; background: #bd93f9;">
                <span class="bar-value">${faults[i]}</span>
            </div>
            <div class="bar-label">${algo}</div>
        </div>
    `).join('');
}

// ---------- UTILIDADES ----------
function getProcessIndex(pid) {
    return processes.findIndex(p => p.pid === pid);
}
