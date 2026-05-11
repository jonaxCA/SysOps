# Simulador SO — Multicore

Carpeta `app/` = simulador unificado. Las carpetas `Modulo1/`, `Modulo2/`, `Modulo3/` quedan como referencia legacy.

## Cómo correrlo

Abrir `app/index.html` directamente en el navegador (no requiere servidor — los workers se cargan vía Blob URL).

## Estado por fase

- **Fase 1 (lista):** Web Workers reales (1 thread por core), input de N cores, asignación con afinidad opcional, FCFS multi-core, Gantt paralelo por core, métricas básicas (TAT, WT, RT, CPU%, context switches).
- **Fase 2 (pendiente):** HRRN, RR, SRTF, Priority preemptive, Multilevel Queue, Multilevel Feedback Queue.
- **Fase 3 (pendiente):** métricas extendidas y por-core.
- **Fase 4 (pendiente):** memoria + 5 algoritmos de paginación + fragmentación interna.
- **Fase 5 (pendiente):** escenarios predefinidos y comparación.
- **Fase 6 (opcional):** backend Node con `fork()` real.
- **Fase 7 (pendiente):** reporte técnico + manual.

## Prueba de aceptación Fase 1

1. Abrir `app/index.html`.
2. Click en **Cargar demo (8 procesos)**.
3. Cores = 4, Algoritmo = FCFS.
4. **Start** → ver 4 PIDs ejecutándose simultáneamente en cajas de core distintas y el Gantt mostrando 4 filas paralelas.
