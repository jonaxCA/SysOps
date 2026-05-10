// child-process.js — el código que corre cada proceso hijo forkeado.
//
// Cuando server.js llama a fork(__filename), el SO crea un proceso real
// (con su propio PID que aparece en el Task Manager / `tasklist`). Ese
// proceso ejecuta este archivo. Recibe un mensaje 'run' con su carga de
// trabajo (burst), consume CPU real haciendo cuentas, y reporta cada
// "tick simulado" al padre vía IPC. Al terminar, el proceso muere.

let state = null;
let alive = true;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'run':
      state = {
        pid: msg.pid,
        remaining: msg.burst,
        executed: 0,
        tickMs: msg.tickMs || 200
      };
      runLoop();
      break;
    case 'kill':
      alive = false;
      process.exit(0);
  }
});

// Avisamos al padre que arrancamos correctamente.
process.send && process.send({ type: 'hello', osPid: process.pid });

function runLoop() {
  if (!state || !alive) return;

  const tick = () => {
    if (!alive || !state) return;

    // Trabajo CPU-bound real para que el proceso consuma su slice de núcleo
    // del SO (visible en el monitor de procesos).
    let sink = 0;
    for (let i = 0; i < 200000; i++) sink += Math.sqrt(i + 1);
    state.remaining--;
    state.executed++;

    process.send({
      type: 'tick',
      pid: state.pid,
      remaining: state.remaining,
      executed: state.executed,
      sink            // mantiene al optimizador honesto
    });

    if (state.remaining <= 0) {
      process.send({ type: 'done', pid: state.pid, executed: state.executed });
      // Salimos voluntariamente — el ciclo del proceso forkeado termina.
      setTimeout(() => process.exit(0), 50);
    } else {
      setTimeout(tick, state.tickMs);
    }
  };

  setTimeout(tick, state.tickMs);
}

// Manejo limpio si el padre cierra abruptamente.
process.on('disconnect', () => process.exit(0));
