# Validación — SPEC-002

Fecha: 2026-10-02. Contratos validados; no implica calidad generativa garantizada.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-002-REGISTRY**: test/registry.test.ts comprueba mapeo de alias, proveedor e ID remoto.
- **SPEC-002-FREE**: test/registry.test.ts y test/provider.test.ts comprueban exclusión de precios desconocidos/no gratuitos y contrato de catálogo.
- **SPEC-002-DEGRADED**: test/registry.test.ts comprueba proveedor caído, catálogo renovado, especialidad activa en fallbacks y capacidades; parallel_tool_calls=false se omite cuando no se anuncia.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.
