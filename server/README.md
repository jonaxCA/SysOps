# Backend Fork (Fase 6)

Cumple el requisito explícito del enunciado: **uso de multiprocesamiento mediante `fork`**. Cada proceso del simulador se materializa en un proceso real del SO con su propio PID (visible en `tasklist` / Task Manager / `ps`).

## Cómo correrlo

```bash
cd server
npm install
npm start
```

Salida esperada:
```
[fork-backend] listo en http://localhost:8765
[fork-backend] PID del servidor: 12345
```

Después abre `app/index.html` y, en el panel **Fork Backend (Node)**, click en **Conectar** y **Ejecutar en backend**.

## Demostrar fork() en vivo

Mientras corre una simulación, en otra terminal:

- Windows: `tasklist | findstr node`
- Linux/Mac: `ps -ef | grep node`

Verás N+1 procesos `node` (1 servidor + N hijos forkeados, uno por cada proceso del simulador en ejecución). Cuando un proceso termina, su PID desaparece.

## Arquitectura

```
Browser (GUI)
    │  WebSocket ws://localhost:8765
    ▼
server.js  ──────────► fork() ──┬─► child-process.js (PID 1001)
   │ (kernel virtual)            ├─► child-process.js (PID 1002)
   │                             ├─► child-process.js (PID 1003)
   │                             └─► ...
   │ IPC ◄────── tick/done ──────┘
   ▼
WS events (fork, tick, done, exit) → GUI
```

## Limitaciones

- Solo algoritmos **no-preemptivos** (FCFS, SJF, HRRN, Priority). Preemption real con `fork()` requiere `SIGSTOP`/`SIGCONT` (no portable a Windows). El simulador en vivo del navegador (Web Workers) sí tiene preempción para los 9 algoritmos.
- No hay módulo de memoria en este backend — se enfoca exclusivamente en demostrar fork() multi-core.
