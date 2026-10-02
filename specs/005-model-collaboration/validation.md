# Validación — SPEC-005

Fecha: 2026-10-02. Contratos validados; no implica calidad generativa garantizada.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-005-CONSULT**: test/collaboration.test.ts comprueba profundidad, presupuestos y consultas anidadas entre tres modelos simulados.
- **SPEC-005-CONTEXT**: test/collaboration.test.ts comprueba conservación de instrucciones, referencias y rechazo explícito de paquetes demasiado grandes.
- **SPEC-005-CYCLES**: test/collaboration.test.ts comprueba consultas idénticas y fuentes desconocidas; test/integration-v2.test.ts comprueba eliminación de estado opaco al cambiar de modelo.
- **SPEC-005-INTEGRATE**: test/collaboration.test.ts comprueba retorno al responsable y privacidad de borradores/controles.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
