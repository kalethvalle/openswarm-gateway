# Contribuir

Leer [specs/README.md](specs/README.md) y la constitución antes de cambiar comportamiento.

1. Requisito o bug reproducible con ID SPEC-NNN-REQ.
2. Actualizar spec/plan y ADR cuando corresponda.
3. Implementar una tarea y prueba de regresión.
4. Ejecutar `npm ci` y `npm run verify`.
5. Registrar comandos y resultados en validation.md; indicar bloqueos reales.
6. Commit con ID de especificación, sin claves ni conversaciones.

Las pruebas offline no necesitan cuentas. Las pruebas reales son optativas y consumen cuota; no ejecutar en CI de contribuciones. El proyecto usa MIT; las dependencias y modelos mantienen sus licencias.
