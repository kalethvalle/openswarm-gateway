# Validación — SPEC-007

Fecha: 2026-10-02. En progreso; hay comprobaciones reales pendientes o bloqueadas.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-007-EVAL**: test/evaluation.test.ts comprueba conjuntos separados y agregación. Evaluación real 20+60 casos terminada; piloto de código de una tarea por modo, benchmark de 20 tareas por modo pendiente.
- **SPEC-007-EVIDENCE**: Resultados privados en data/: precisión aceptada de Laya 13/15, cobertura 15/60; tres ejecuciones de sum aprobadas. El piloto no demuestra mejora de calidad o eficiencia.
- **SPEC-007-RELEASE**: Licencia MIT y CI sin claves definidos. npm run verify aprobado. Imágenes construidas y ejecutadas con inferencia real y checkpoint en caché; instalación desde caché vacía y ejecución de CI remota no comprobadas.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
