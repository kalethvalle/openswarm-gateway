---
id: SPEC-002
revision: 3
status: validated
depends_on: [SPEC-001]
tests: [test/registry.test.ts]
---

# Registro multiproveedor

## Requisitos y aceptación

- **SPEC-002-REGISTRY**: Usar alias estables que resuelven proveedor e ID remoto; mantener varios proveedores y catálogo renovable.
- **SPEC-002-FREE**: Excluir candidatos OpenRouter con precio desconocido o no gratuito; Groq exige declaración de cuenta Free; local es opcional.
- **SPEC-002-DEGRADED**: Un proveedor caído no impide usar los demás; capacidades y contexto se comprueban antes del despacho.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.

## Revisión 2

El campo parallel_tool_calls=false puede omitirse en transporte cuando el catálogo no lo anuncia; el Gateway conserva su validación local. true requiere soporte explícito.

## Revisión 3

Un fallback de una etapa especializada debe admitir la especialidad activa, aunque comparta otras especialidades con el modelo original. Cada candidato se vuelve a comprobar contra el catálogo vigente antes de presupuestarlo.
