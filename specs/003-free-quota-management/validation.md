# Validación — SPEC-003

Fecha: 2026-10-02. Contratos validados; no implica calidad generativa garantizada.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-003-ATOMIC**: test/quota.test.ts comprueba reservas atómicas y límites por grupos compartidos.
- **SPEC-003-FALLBACK**: test/quota.test.ts comprueba selección alternativa y separación de cooldown de modelo/cuenta.
- **SPEC-003-RESTART**: test/quota.test.ts comprueba persistencia SQLite y cancelación sin conservar consumo previo al despacho.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
