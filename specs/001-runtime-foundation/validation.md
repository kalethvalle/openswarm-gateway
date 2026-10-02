# Validación — SPEC-001

Fecha: 2026-10-02. Contratos validados; no implica calidad generativa garantizada.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-001-TOKENS**: test/runtime.test.ts comprueba estimación de entrada grande y presupuesto local sin confundirlo con cuota remota.
- **SPEC-001-QUEUE**: test/runtime.test.ts comprueba rechazo antes de despacho y cancelación intermedia sin turnos fantasma.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
