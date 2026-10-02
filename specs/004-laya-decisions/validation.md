# Validación — SPEC-004

Fecha: 2026-10-02. Contratos validados; no implica calidad generativa garantizada.

## Evidencia

`npm run verify`: 84 pruebas aprobadas, tipos, compilación y trazabilidad correctos.

- **SPEC-004-DECIDE**: test/decisions.test.ts comprueba decisiones tipadas. Evaluación real: 15/60 aceptadas, 13 correctas, cobertura 25%; ver informe global.
- **SPEC-004-ABSTAIN**: test/decisions.test.ts comprueba abstención/indisponibilidad y fallback generativo. Umbral provisional, sin garantía de precisión.
- **SPEC-004-BOUNDS**: test/decisions.test.ts comprueba límites de entrada y respuestas inválidas. No hay reglas de palabras para intención.

Ver [informe completo](../../docs/v0.2-validation.md) para comandos, métricas y limitaciones. Los proveedores de las pruebas offline son simulados.

La evaluación separada contiene dos errores aceptados y 45 abstenciones. No se ha calibrado el umbral ni medido aún la calidad de selección de fuentes/retornos. La validación cubre el contrato, no una precisión objetivo.
