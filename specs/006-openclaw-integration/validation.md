# Validación — SPEC-006

Fecha: 2026-10-02. En progreso; hay comprobaciones reales pendientes o bloqueadas.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-006-TOOLS**: test/integration-v2.test.ts comprueba replay, IDs, namespace y continuaciones. SDK real completó echo. OpenClaw aislado ejecutó exec pero no terminó la continuación.
- **SPEC-006-MIGRATION**: test/integration-v2.test.ts comprueba reinicio SQLite v1/v2 y especialista pausado en herramienta externa.
- **SPEC-006-PORTABLE**: test/integration-v2.test.ts comprueba cambio después de ronda completa conservando evidencia y eliminando estado opaco.
- **SPEC-006-LIVE**: Pendiente de aprobación: la prueba habitual superó la cuota de entrada configurada de Groq y OpenRouter agotó su cuota. La prueba aislada creó archivos pero la siguiente ronda tampoco cupo. No equivalen a éxito integral.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
