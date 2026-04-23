'use strict';
/* ============================================================
   OS Process Scheduler Simulator — simulator.js
   Wired to modulo2-style HTML interface
   ============================================================ */

// ─── PALETTE ──────────────────────────────────────────────────
const COLORS = [
    '#bd93f9','#50fa7b','#8be9fd','#f1fa8c',
    '#ffb86c','#ff79c6','#ff5555','#6272a4',
    '#a4ffff','#ffffa5','#d6acff','#69ff94'
];
function procColor(pid){
    // pid can be string like "P1" or number
    const n = parseInt(String(pid).replace(/\D/g,'')) || 1;
    return COLORS[(n - 1) % COLORS.length];
}

// ─── STATE ────────────────────────────────────────────────────
let processes  = [];      // { pid, arrival, burst, priority, pages }
let simResult  = null;
let stepIdx    = 0;
let animTimer  = null;
let paused     = false;
let pageFaults = 0;
let pageHits   = 0;
let memState   = null;
let pageSeq    = [];

// ─── DOM HELPERS ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── CONTROL REFS ─────────────────────────────────────────────
const algoSel    = $('cpu-algo');
const memAlgoSel = $('mem-algo');
const quantumInp = $('cpu-quantum');
const framesInp  = $('framesInput');
const speedSlider= $('speed-slider');
const clockDisp  = $('clock-display');

// ─── WIRING ───────────────────────────────────────────────────
algoSel.addEventListener('change', () => {
    quantumInp.style.display = algoSel.value === 'rr' ? 'block' : 'none';
});

$('btn-add-process').addEventListener('click', addProcess);
$('btn-preload').addEventListener('click',     loadSampleProcesses);
$('btn-start').addEventListener('click',       onStart);
$('btn-pause').addEventListener('click',       onPause);
$('btn-reset').addEventListener('click',       onReset);
$('btn-compare').addEventListener('click',     openCompare);
$('closeModal').addEventListener('click',      () => $('compareModal').classList.remove('active'));
$('compareModal').addEventListener('click',    e => { if(e.target===$('compareModal')) $('compareModal').classList.remove('active'); });
$('file-upload').addEventListener('change',    loadFromFile);

// Enter key on process inputs
['p-id','p-arrival','p-burst','p-priority','p-pages'].forEach(id => {
    $(id).addEventListener('keydown', e => { if(e.key==='Enter') addProcess(); });
});

// ─── SAMPLE DATA ──────────────────────────────────────────────
function loadSampleProcesses(){
    processes = [
        { pid:'P1', arrival:0, burst:5, priority:2, pages:3 },
        { pid:'P2', arrival:1, burst:3, priority:1, pages:2 },
        { pid:'P3', arrival:2, burst:8, priority:3, pages:4 },
        { pid:'P4', arrival:3, burst:2, priority:1, pages:1 },
        { pid:'P5', arrival:4, burst:4, priority:2, pages:3 },
    ];
    renderProcessList();
    logEvent('info', '📚 Procesos de ejemplo cargados.');
}

// ─── ADD / REMOVE PROCESS ─────────────────────────────────────
function addProcess(){
    const pid      = $('p-id').value.trim()             || `P${processes.length+1}`;
    const arrival  = parseInt($('p-arrival').value);
    const burst    = parseInt($('p-burst').value);
    const priority = parseInt($('p-priority').value)    || 1;
    const pages    = parseInt($('p-pages').value)       || 4;

    if(isNaN(arrival) || isNaN(burst) || burst < 1){
        alert('Ingresa Llegada y Ráfaga válidos.'); return;
    }
    if(processes.find(p => p.pid === pid)){
        alert(`El PID "${pid}" ya existe.`); return;
    }
    processes.push({ pid, arrival, burst, priority, pages });
    renderProcessList();
    logEvent('success', `➕ ${pid} agregado (AT:${arrival} BT:${burst} Pr:${priority} Págs:${pages})`);
    ['p-id','p-arrival','p-burst','p-priority'].forEach(id => $(id).value = '');
    $('p-id').focus();
}

function removeProcess(pid){
    processes = processes.filter(p => p.pid !== pid);
    renderProcessList();
    logEvent('info', `🗑️ ${pid} eliminado.`);
}

function renderProcessList(){
    const ul = $('process-list-ui');
    ul.innerHTML = '';
    if(!processes.length){
        ul.innerHTML = '<li style="color:#666; text-align:center; padding:6px;">Sin procesos</li>';
        return;
    }
    processes.forEach(p => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #333;';
        li.innerHTML = `
            <span>
                <span class="badge" style="background:${procColor(p.pid)};color:#000;">${p.pid}</span>
                AT:${p.arrival} BT:${p.burst} Pr:${p.priority} Págs:${p.pages}
            </span>
            <button onclick="removeProcess('${p.pid}')"
                style="background:var(--state-terminated);border:none;color:#fff;
                       padding:2px 6px;border-radius:3px;cursor:pointer;font-size:0.8em;">✕</button>`;
        ul.appendChild(li);
    });
}

// ─── SIMULATION CONTROL ───────────────────────────────────────
function onStart(){
    if(!processes.length){ alert('Agrega al menos un proceso.'); return; }

    if(paused && simResult){
        // Resume
        paused = false;
        $('btn-start').textContent = '▶ Corriendo…';
        scheduleNextTick();
        return;
    }

    // Fresh run
    onReset(false);
    const algo    = algoSel.value;
    const quantum = parseInt(quantumInp.value) || 2;
    const frames  = parseInt(framesInp.value)  || 4;
    const ps      = cloneProcesses();

    simResult  = runAlgo(algo, ps, quantum);
    stepIdx    = 0;
    memState   = initMemState(frames);
    pageSeq    = buildPageAccessSequence(simResult.timeline);
    paused     = false;

    renderGanttFull(simResult.timeline);
    setStateDiagramMode(algo);
    $('btn-start').textContent = '▶ Corriendo…';

    scheduleNextTick();
}

function scheduleNextTick(){
    clearInterval(animTimer);
    const delay = parseInt(speedSlider.value) || 800;
    animTimer = setInterval(tick, delay);
}

function onPause(){
    if(!simResult) return;
    paused = !paused;
    if(paused){
        clearInterval(animTimer);
        animTimer = null;
        $('btn-pause').textContent = '▶ Reanudar';
        $('btn-start').textContent = '▶ Iniciar';
        logEvent('info', '⏸ Simulación pausada.');
    } else {
        $('btn-pause').textContent = '⏸ Pausar';
        onStart();
    }
}

function onReset(doLog = true){
    clearInterval(animTimer);
    animTimer  = null;
    simResult  = null;
    stepIdx    = 0;
    paused     = false;
    pageFaults = 0;
    pageHits   = 0;
    memState   = null;
    pageSeq    = [];

    // UI reset
    $('btn-start').textContent = '▶ Iniciar';
    $('btn-pause').textContent = '⏸ Pausar';
    $('clock-display').textContent = 'Tick: 0';

    // CPU
    const core = $('cpuCore');
    core.className = 'cpu-core';
    core.style.borderColor = '';
    core.style.boxShadow   = '';
    $('cpuProcessLabel').textContent = '—';
    $('cpuTimer').textContent = '';

    // Queues
    $('readyQueue').innerHTML  = '';
    $('waitingQueue').innerHTML = '';
    $('readyCount').textContent   = '(0)';
    $('waitingCount').textContent = '(0)';

    // Gantt
    $('ganttChart').innerHTML = '';
    $('ganttAxis').innerHTML  = '';

    // Metrics
    $('metricsBody').innerHTML = '<tr><td colspan="7" style="color:#666;text-align:center;padding:12px;">Inicia la simulación primero</td></tr>';
    $('promedios').innerHTML   = '<tr><td colspan="3" style="color:#666;text-align:center;">—</td></tr>';

    // Memory
    $('pageFaultCount').textContent  = '0';
    $('pageFaultBig').textContent    = '0';
    $('pageHitCount').textContent    = '0';
    $('faultRateDisplay').textContent= '0%';
    $('pageTableBody').innerHTML     = '<tr><td colspan="5" style="color:#666;text-align:center;">Sin datos</td></tr>';
    $('frameInfo').textContent       = '';
    $('memCompareChart').innerHTML   = '<div style="color:#555;font-size:0.8em;margin:auto;">Ejecuta la simulación</div>';

    resetStateDiagram();
    renderMemoryGrid(parseInt(framesInp.value)||4, []);
    $('event-log').innerHTML = '';
    if(doLog) logEvent('info', '↺ Simulador reiniciado.');
}

// ─── TICK ─────────────────────────────────────────────────────
function tick(){
    // Respect speed slider live changes
    const delay = parseInt(speedSlider.value) || 800;

    if(stepIdx >= simResult.timeline.length){
        clearInterval(animTimer);
        animTimer = null;
        $('btn-start').textContent = '▶ Iniciar';
        finalizeMetrics(simResult.results);
        finalizeMemory(pageSeq, parseInt(framesInp.value)||4);
        setStateDiagramMode('done');
        resetCPUCore();
        $('readyQueue').innerHTML  = '';
        $('waitingQueue').innerHTML = '';
        $('readyCount').textContent   = '(0)';
        $('waitingCount').textContent = '(0)';
        logEvent('success', '✅ Simulación completada.');
        return;
    }

    const block = simResult.timeline[stepIdx];
    const dur   = block.end - block.start;

    // Clock
    $('clock-display').textContent = `Tick: ${block.start}`;

    // CPU Core
    const core = $('cpuCore');
    core.className = 'cpu-core active';
    core.style.borderColor = procColor(block.pid);
    core.style.boxShadow   = `0 0 20px ${procColor(block.pid)}55`;
    $('cpuProcessLabel').textContent = block.pid;
    $('cpuTimer').textContent = `${dur} ut`;

    // Ready queue: arrived, not running, not yet finished
    const finished = simResult.results.filter(r => r.ct <= block.start).map(r => r.pid);
    const readyPs  = processes.filter(p =>
        p.arrival <= block.start &&
        p.pid !== block.pid &&
        !finished.includes(p.pid)
    );
    renderQueue('readyQueue',  readyPs);
    $('readyCount').textContent   = `(${readyPs.length})`;
    $('waitingCount').textContent = '(0)';

    // Activate arrow
    activateArrows();

    // Memory
    const blockAccesses = pageSeq.filter(a => a.time >= block.start && a.time < block.end);
    blockAccesses.forEach(a => processPageAccess(a, memState, parseInt(framesInp.value)||4));

    stepIdx++;
}

// ─── QUEUE RENDER ─────────────────────────────────────────────
function renderQueue(queueId, procs){
    const q = $(queueId);
    q.innerHTML = '';
    if(!procs.length){
        q.innerHTML = '<span style="color:#555;font-size:0.85em;margin:auto;">Vacía</span>';
        return;
    }
    procs.forEach(p => {
        const div = document.createElement('div');
        div.className = 'process-block';
        div.style.background = procColor(p.pid);
        div.innerHTML = `${p.pid}<span class="sub">AT:${p.arrival} BT:${p.burst}</span>`;
        q.appendChild(div);
    });
}

function resetCPUCore(){
    const core = $('cpuCore');
    core.className = 'cpu-core';
    core.style.borderColor = '';
    core.style.boxShadow   = '';
    $('cpuProcessLabel').textContent = '—';
    $('cpuTimer').textContent = '';
}

// ─── STATE DIAGRAM ────────────────────────────────────────────
function resetStateDiagram(){
    ['arrow-ready','arrow-run','arrow-term'].forEach(id => {
        const el = $(id); if(el){ el.style.color=''; el.style.textShadow=''; }
    });
    $('pathRR')?.classList.remove('active');
    $('pathIO')?.classList.remove('active');
}

function setStateDiagramMode(algo){
    resetStateDiagram();
    ['arrow-ready','arrow-run','arrow-term'].forEach(id => activateArrow(id));
    if(['rr','srtf','priority_p'].includes(algo)) $('pathRR')?.classList.add('active');
}

function activateArrows(){
    ['arrow-ready','arrow-run'].forEach(id => activateArrow(id));
}

function activateArrow(id){
    const el = $(id); if(!el) return;
    el.style.color      = 'var(--accent)';
    el.style.textShadow = '0 0 10px var(--accent)';
}

// ─── GANTT ────────────────────────────────────────────────────
function renderGanttFull(timeline){
    const chart = $('ganttChart');
    const axis  = $('ganttAxis');
    chart.innerHTML = '';
    axis.innerHTML  = '';
    if(!timeline.length) return;

    const totalTime = timeline[timeline.length-1].end;
    const minWidth  = Math.max(500, totalTime * 28);
    chart.style.width = minWidth + 'px';
    axis.style.width  = minWidth + 'px';

    timeline.forEach(block => {
        const pct = ((block.end - block.start) / totalTime) * 100;
        const div = document.createElement('div');
        div.className = 'gantt-block';
        div.style.cssText = `width:${pct}%;background:${procColor(block.pid)};min-height:40px;position:relative;flex-shrink:0;`;
        div.textContent = block.pid;
        div.title = `${block.pid}: t=${block.start}→${block.end}`;

        const tick = document.createElement('span');
        tick.className   = 'tick-label';
        tick.textContent = block.end;
        div.appendChild(tick);
        chart.appendChild(div);
    });

    // Start label
    const startTick = document.createElement('span');
    startTick.className   = 'gantt-tick';
    startTick.style.left  = '0';
    startTick.textContent = timeline[0].start;
    axis.appendChild(startTick);
}

// ─── METRICS ──────────────────────────────────────────────────
function finalizeMetrics(results){
    $('metricsBody').innerHTML = results.map(r => `
        <tr>
            <td><span class="badge" style="background:${procColor(r.pid)};color:#000;">${r.pid}</span></td>
            <td>${r.at}</td>
            <td>${r.bt}</td>
            <td>${r.ct}</td>
            <td>${r.tat}</td>
            <td>${r.wt}</td>
            <td>${r.rt}</td>
        </tr>`).join('');

    const avg = arr => (arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(2);
    const avgTAT = avg(results.map(r=>r.tat));
    const avgWT  = avg(results.map(r=>r.wt));
    const avgRT  = avg(results.map(r=>r.rt));

    $('promedios').innerHTML = `
        <tr>
            <td style="color:var(--accent);font-weight:bold;">${avgTAT}</td>
            <td style="color:var(--accent);font-weight:bold;">${avgWT}</td>
            <td style="color:var(--accent);font-weight:bold;">${avgRT}</td>
        </tr>`;
}

// ─── LOGGING ──────────────────────────────────────────────────
function logEvent(type, msg){
    const log = $('event-log');
    if(!log) return;
    const li = document.createElement('li');
    li.textContent = msg;
    li.className   = type === 'fault' ? 'fault' : type === 'success' ? 'success' : '';
    log.prepend(li);
    while(log.children.length > 50) log.removeChild(log.lastChild);
}

// ═══════════════════════════════════════════════════════════════
//  SCHEDULING ALGORITHMS
// ═══════════════════════════════════════════════════════════════
function cloneProcesses(){
    return processes.map(p => ({ ...p, remaining: p.burst, startTime: -1, finishTime: -1 }));
}

function runAlgo(algo, ps, q){
    switch(algo){
        case 'fcfs':       return scheduleFCFS(ps);
        case 'sjf':        return scheduleSJF(ps);
        case 'srtf':       return scheduleSRTF(ps);
        case 'rr':         return scheduleRR(ps, q);
        case 'priority':   return schedulePriority(ps, false);
        case 'priority_p': return schedulePriority(ps, true);
        default:           return scheduleFCFS(ps);
    }
}

function buildResult(origProcs, ps, timeline){
    const pidMap = {};
    ps.forEach(p => pidMap[p.pid] = p);
    const results = origProcs.map(op => {
        const p   = pidMap[op.pid];
        const ct  = p.finishTime || p.ft || 0;
        const at  = p.arrival;
        const bt  = p.burst;
        const tat = ct - at;
        const wt  = Math.max(0, tat - bt);
        const st  = p.startTime >= 0 ? p.startTime : (p.st >= 0 ? p.st : ct);
        const rt  = Math.max(0, st - at);
        return { pid: p.pid, at, bt, ct, tat, wt, rt };
    });
    return { timeline, results };
}

function scheduleFCFS(procs){
    const ps = [...procs].sort((a,b)=>a.arrival-b.arrival||String(a.pid).localeCompare(String(b.pid)));
    const timeline = [];
    let t = 0;
    ps.forEach(p => {
        t = Math.max(t, p.arrival);
        p.startTime = t;
        timeline.push({ pid:p.pid, start:t, end:t+p.burst });
        t += p.burst;
        p.finishTime = t;
    });
    return buildResult(procs, ps, timeline);
}

function scheduleSJF(procs){
    const ps = procs.map(p=>({...p}));
    const timeline = [];
    let t = 0, done = 0;
    const completed = new Array(ps.length).fill(false);
    while(done < ps.length){
        const avail = ps.filter((p,i)=>!completed[i]&&p.arrival<=t);
        if(!avail.length){ t++; continue; }
        avail.sort((a,b)=>a.burst-b.burst||a.arrival-b.arrival);
        const p = avail[0];
        if(p.startTime<0) p.startTime=t;
        timeline.push({pid:p.pid,start:t,end:t+p.burst});
        t+=p.burst; p.finishTime=t;
        completed[ps.indexOf(p)]=true; done++;
    }
    return buildResult(procs,ps,timeline);
}

function scheduleSRTF(procs){
    const ps = procs.map(p=>({...p,rem:p.burst,st:-1,ft:-1}));
    const timeline = [];
    let t=0,done=0,last=null;
    const maxT = procs.reduce((s,p)=>s+p.burst,0)+Math.max(...procs.map(p=>p.arrival))+1;
    while(done<ps.length&&t<=maxT){
        const avail=ps.filter(p=>p.arrival<=t&&p.rem>0);
        if(!avail.length){t++;continue;}
        avail.sort((a,b)=>a.rem-b.rem||a.arrival-b.arrival);
        const p=avail[0];
        if(p.st<0)p.st=t;
        if(last!==p.pid)timeline.push({pid:p.pid,start:t,end:t+1});
        else timeline[timeline.length-1].end=t+1;
        last=p.pid;p.rem--;t++;
        if(p.rem===0){p.ft=t;done++;}
    }
    const merged=[];
    timeline.forEach(b=>{
        if(merged.length&&merged[merged.length-1].pid===b.pid&&merged[merged.length-1].end===b.start)
            merged[merged.length-1].end=b.end;
        else merged.push({...b});
    });
    ps.forEach(p=>{p.startTime=p.st;p.finishTime=p.ft;});
    return buildResult(procs,ps,merged);
}

function scheduleRR(procs,quantum){
    const ps=procs.map(p=>({...p,rem:p.burst,st:-1,ft:-1}));
    const timeline=[];
    const queue=[];
    let t=0,done=0;
    const sorted=[...ps].sort((a,b)=>a.arrival-b.arrival);
    let idx=0;
    while(done<ps.length){
        while(idx<sorted.length&&sorted[idx].arrival<=t){queue.push(sorted[idx]);idx++;}
        if(!queue.length){t=sorted[idx]?.arrival||t+1;continue;}
        const p=queue.shift();
        if(p.st<0)p.st=t;
        const slice=Math.min(quantum,p.rem);
        timeline.push({pid:p.pid,start:t,end:t+slice});
        t+=slice;p.rem-=slice;
        while(idx<sorted.length&&sorted[idx].arrival<=t){queue.push(sorted[idx]);idx++;}
        if(p.rem>0)queue.push(p);
        else{p.ft=t;done++;}
    }
    ps.forEach(p=>{p.startTime=p.st;p.finishTime=p.ft;});
    return buildResult(procs,ps,timeline);
}

function schedulePriority(procs,preemptive){
    if(!preemptive){
        const ps=procs.map(p=>({...p}));
        const timeline=[];
        let t=0,done=0;
        const completed=new Array(ps.length).fill(false);
        while(done<ps.length){
            const avail=ps.filter((p,i)=>!completed[i]&&p.arrival<=t);
            if(!avail.length){t++;continue;}
            avail.sort((a,b)=>a.priority-b.priority||a.arrival-b.arrival);
            const p=avail[0];
            if(p.startTime<0)p.startTime=t;
            timeline.push({pid:p.pid,start:t,end:t+p.burst});
            t+=p.burst;p.finishTime=t;
            completed[ps.indexOf(p)]=true;done++;
        }
        return buildResult(procs,ps,timeline);
    } else {
        const ps=procs.map(p=>({...p,rem:p.burst,st:-1,ft:-1}));
        const timeline=[];
        let t=0,done=0,last=null;
        const maxT=procs.reduce((s,p)=>s+p.burst,0)+Math.max(...procs.map(p=>p.arrival))+1;
        while(done<ps.length&&t<=maxT){
            const avail=ps.filter(p=>p.arrival<=t&&p.rem>0);
            if(!avail.length){t++;continue;}
            avail.sort((a,b)=>a.priority-b.priority||a.arrival-b.arrival);
            const p=avail[0];
            if(p.st<0)p.st=t;
            if(last!==p.pid)timeline.push({pid:p.pid,start:t,end:t+1});
            else timeline[timeline.length-1].end=t+1;
            last=p.pid;p.rem--;t++;
            if(p.rem===0){p.ft=t;done++;}
        }
        const merged=[];
        timeline.forEach(b=>{
            if(merged.length&&merged[merged.length-1].pid===b.pid&&merged[merged.length-1].end===b.start)
                merged[merged.length-1].end=b.end;
            else merged.push({...b});
        });
        ps.forEach(p=>{p.startTime=p.st;p.finishTime=p.ft;});
        return buildResult(procs,ps,merged);
    }
}

// ═══════════════════════════════════════════════════════════════
//  MEMORY MODULE
// ═══════════════════════════════════════════════════════════════
function initMemState(totalFrames){
    return { frames:new Array(totalFrames).fill(null), order:[], recent:[], faults:0, hits:0 };
}

function renderMemoryGrid(totalFrames, frames){
    const grid = $('memoryGrid');
    if(!grid) return;
    grid.innerHTML = '';
    $('frameInfo').textContent = `(${frames.filter(Boolean).length}/${totalFrames} usados)`;
    for(let i=0;i<totalFrames;i++){
        const f=frames[i];
        const div=document.createElement('div');
        div.className='frame'+(f?' occupied':'');
        div.style.borderColor=f?procColor(f.pid):'';
        div.innerHTML=`<span class="frame-number">${i}</span>${
            f?`<span style="color:${procColor(f.pid)};font-size:1em;">${f.pid}</span><span style="font-size:0.7em;color:#888;">pg${f.page}</span>`
             :'<span style="color:#444;">libre</span>'}`;
        grid.appendChild(div);
    }
}

function processPageAccess(access, ms, totalFrames){
    const {pid,page} = access;
    const algo = memAlgoSel.value;
    const key  = `${pid}-${page}`;
    const inMem = ms.frames.some(f=>f&&f.pid===pid&&f.page===page);

    if(inMem){
        ms.hits++; pageHits++;
        if(algo==='lru'){
            const i=ms.recent.indexOf(key);
            if(i!==-1) ms.recent.splice(i,1);
            ms.recent.push(key);
        }
        $('pageHitCount').textContent = pageHits;
        updateFaultRate();
        renderMemoryGrid(totalFrames, ms.frames);
        updatePageTable(ms.frames);
        return;
    }

    ms.faults++; pageFaults++;
    $('pageFaultCount').textContent = pageFaults;
    $('pageFaultBig').textContent   = pageFaults;
    updateFaultRate();
    logEvent('fault', `⚠️ Page Fault: ${pid} página ${page}`);

    const freeIdx = ms.frames.indexOf(null);
    if(freeIdx !== -1){
        ms.frames[freeIdx]={pid,page};
        ms.order.push({idx:freeIdx,key});
        ms.recent.push(key);
    } else {
        let vi=-1;
        if(algo==='fifo'){
            const oldest=ms.order.shift();
            vi=oldest.idx;
            logEvent('fault',`🔄 FIFO reemplaza marco ${vi} (era ${oldest.key})`);
        } else if(algo==='lru'){
            const lk=ms.recent.shift();
            vi=ms.frames.findIndex(f=>f&&`${f.pid}-${f.page}`===lk);
            if(vi<0)vi=0;
            logEvent('fault',`🔄 LRU reemplaza marco ${vi} (era ${lk})`);
        } else {
            vi=Math.floor(Math.random()*totalFrames);
            logEvent('fault',`🔄 Óptimo reemplaza marco ${vi}`);
        }
        ms.order=ms.order.filter(o=>o.idx!==vi);
        const ok=ms.frames[vi]?`${ms.frames[vi].pid}-${ms.frames[vi].page}`:null;
        if(ok) ms.recent=ms.recent.filter(k=>k!==ok);
        ms.frames[vi]={pid,page};
        ms.order.push({idx:vi,key});
        ms.recent.push(key);
        const frameEls=$('memoryGrid').children;
        if(frameEls[vi]) frameEls[vi].classList.add('frame-replace-anim');
    }
    renderMemoryGrid(totalFrames,ms.frames);
    updatePageTable(ms.frames);
}

function updateFaultRate(){
    const total=pageFaults+pageHits;
    $('faultRateDisplay').textContent=(total>0?Math.round((pageFaults/total)*100):0)+'%';
}

function updatePageTable(frames){
    $('pageTableBody').innerHTML=frames.map((f,i)=>f
        ?`<tr class="in-memory">
            <td><span class="badge" style="background:${procColor(f.pid)};color:#000;">${f.pid}</span></td>
            <td>${f.page}</td><td class="frame-id">${i}</td>
            <td class="valid-bit">✓</td><td>${Math.floor(Math.random()*5)+1}</td></tr>`
        :`<tr><td>—</td><td>—</td><td class="frame-id">${i}</td>
            <td class="invalid-bit">✗</td><td>0</td></tr>`
    ).join('');
}

function buildPageAccessSequence(timeline){
    const counters={};
    return timeline.flatMap(block=>{
        const proc=processes.find(p=>p.pid===block.pid);
        if(!proc) return [];
        if(!counters[block.pid]) counters[block.pid]=0;
        const seq=[];
        for(let t=block.start;t<block.end;t++){
            seq.push({pid:block.pid,page:counters[block.pid]%proc.pages,time:t});
            counters[block.pid]++;
        }
        return seq;
    });
}

function finalizeMemory(pageSeq, totalFrames){
    const algos=['fifo','lru','optimal'];
    const counts={};
    algos.forEach(a=>{
        const ms=initMemState(totalFrames);
        let pf=0;
        pageSeq.forEach(acc=>{
            const key=`${acc.pid}-${acc.page}`;
            const inMem=ms.frames.some(f=>f&&f.pid===acc.pid&&f.page===acc.page);
            if(inMem){
                if(a==='lru'){const i=ms.recent.indexOf(key);if(i>=0)ms.recent.splice(i,1);ms.recent.push(key);}
            } else {
                pf++;
                const fi=ms.frames.indexOf(null);
                let vi=fi>=0?fi:(a==='fifo'?ms.order.shift()?.idx??0:a==='lru'?(()=>{const lk=ms.recent.shift();return ms.frames.findIndex(f=>f&&`${f.pid}-${f.page}`===lk)||0;})():Math.floor(Math.random()*totalFrames));
                if(fi<0){ms.order=ms.order.filter(o=>o.idx!==vi);const ok=ms.frames[vi]?`${ms.frames[vi].pid}-${ms.frames[vi].page}`:null;if(ok)ms.recent=ms.recent.filter(k=>k!==ok);}
                ms.frames[vi]={pid:acc.pid,page:acc.page};
                ms.order.push({idx:vi,key});ms.recent.push(key);
            }
        });
        counts[a]=pf;
    });
    const maxF=Math.max(1,...Object.values(counts));
    const chart=$('memCompareChart');
    chart.innerHTML='';
    chart.style.cssText='display:flex;align-items:flex-end;justify-content:space-around;height:100px;border-left:2px solid #555;border-bottom:2px solid #555;padding:10px 0;';
    const labels={fifo:'FIFO',lru:'LRU',optimal:'Óptimo'};
    const colors=['var(--state-waiting)','var(--accent)','var(--state-running)'];
    algos.forEach((a,i)=>{
        const h=Math.max(5,(counts[a]/maxF)*90);
        const w=document.createElement('div');
        w.className='bar-wrapper';
        w.innerHTML=`<div class="bar" style="height:${h}%;background:${colors[i]};"><span class="bar-value" style="color:${colors[i]};">${counts[a]}</span></div><span class="bar-label">${labels[a]}</span>`;
        chart.appendChild(w);
    });
}

// ─── COMPARE MODAL ────────────────────────────────────────────
function openCompare(){
    if(!processes.length){ alert('Agrega procesos primero.'); return; }
    const quantum=parseInt(quantumInp.value)||2;
    $('compareQuantumLabel').textContent=quantum;

    const algos=[
        {key:'fcfs',label:'FCFS'},
        {key:'sjf',label:'SJF'},
        {key:'srtf',label:'SRTF'},
        {key:'rr',label:'Round Robin'},
        {key:'priority',label:'Priority'},
        {key:'priority_p',label:'Priority (P)'},
    ];
    const data=algos.map(a=>{
        const ps=cloneProcesses();
        const res=runAlgo(a.key,ps,quantum);
        const avg=arr=>arr.reduce((s,v)=>s+v,0)/arr.length;
        const avgTAT=avg(res.results.map(r=>r.tat));
        const avgWT =avg(res.results.map(r=>r.wt));
        const avgRT =avg(res.results.map(r=>r.rt));
        const lastEnd=Math.max(...res.results.map(r=>r.ct));
        const firstAT=Math.min(...res.results.map(r=>r.at));
        return {label:a.label,avgTAT:avgTAT.toFixed(2),avgWT:avgWT.toFixed(2),avgRT:avgRT.toFixed(2),
                throughput:(res.results.length/(lastEnd-firstAT||1)).toFixed(3)};
    });

    $('compareTableBody').innerHTML=data.map((d,i)=>`
        <tr>
            <td><strong style="color:${COLORS[i]}">${d.label}</strong></td>
            <td>${d.avgTAT}</td><td>${d.avgWT}</td>
            <td>${d.avgRT}</td><td>${d.throughput}</td>
        </tr>`).join('');

    const chart=$('compareChart');
    chart.innerHTML='';
    const maxWT=Math.max(1,...data.map(d=>parseFloat(d.avgWT)));
    data.forEach((d,i)=>{
        const h=Math.max(5,(parseFloat(d.avgWT)/maxWT)*90);
        const w=document.createElement('div');
        w.className='bar-container';
        w.innerHTML=`<div class="bar" style="height:${h}%;background:${COLORS[i]};"><span class="bar-value" style="color:${COLORS[i]};">${d.avgWT}</span></div><span class="bar-label" style="color:${COLORS[i]};">${d.label}</span>`;
        chart.appendChild(w);
    });

    $('compareModal').classList.add('active');
}

// ─── FILE UPLOAD ──────────────────────────────────────────────
function loadFromFile(e){
    const file=e.target.files[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
        const lines=ev.target.result.split('\n');
        let added=0;
        lines.forEach(line=>{
            line=line.trim();
            if(!line||line.startsWith('#')) return;
            // Hardware params
            if(line.startsWith('Frames=')){
                framesInp.value=parseInt(line.split('=')[1])||4; return;
            }
            // Process line: PID,Arrival,Burst,Priority,Pages
            const parts=line.split(',');
            if(parts.length>=3){
                const pid      =parts[0].trim()||`P${processes.length+1}`;
                const arrival  =parseInt(parts[1])||0;
                const burst    =parseInt(parts[2])||1;
                const priority =parseInt(parts[3])||1;
                const pages    =parseInt(parts[4])||4;
                if(!processes.find(p=>p.pid===pid)){
                    processes.push({pid,arrival,burst,priority,pages});
                    added++;
                }
            }
        });
        renderProcessList();
        logEvent('success',`📂 Archivo cargado: ${added} procesos añadidos.`);
    };
    reader.readAsText(file);
    e.target.value='';
}

// ─── INIT ─────────────────────────────────────────────────────
renderMemoryGrid(parseInt(framesInp.value)||4, []);
framesInp.addEventListener('change',()=>renderMemoryGrid(parseInt(framesInp.value)||4,[]));

// Speed slider: restart interval if running
speedSlider.addEventListener('change',()=>{
    if(animTimer&&!paused){ clearInterval(animTimer); scheduleNextTick(); }
});
