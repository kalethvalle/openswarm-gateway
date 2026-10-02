# Spec-Driven Development

Flujo: especificar → diseñar → implementar → comprobar → registrar.
Cada directorio tiene spec.md, plan.md, tasks.md y validation.md. Los requisitos usan IDs estables y los títulos de prueba los referencian.

Estados: draft, ready, in_progress, validated, superseded. Un documento validated requiere evidencia de todos sus criterios; una prueba bloqueada no cuenta como aprobada.

Las revisiones son enteros incrementales del contrato. Git conserva el historial. La versión de aplicación, configuración y estado son independientes de la revisión de una especificación.

## Cambios y bugs

1. Localizar el requisito. Si cambia el comportamiento esperado, revisar spec.md y aumentar revision antes del código.
2. Registrar decisiones transversales en docs/adr.
3. Añadir reproducción y prueba de regresión. Un bug no se resuelve alterando el requisito para aceptar el fallo.
4. Implementar, ejecutar npm run verify y actualizar validation.md.
5. Commit referido a SPEC-NNN. No incluir claves, conversaciones ni resultados reales privados.

Para nuevas capacidades copiar templates, asignar ID y declarar dependencias. Ejecutar npm run spec:check.
