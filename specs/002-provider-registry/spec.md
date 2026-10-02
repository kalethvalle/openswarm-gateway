---
id: SPEC-002
revision: 1
status: in_progress
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
