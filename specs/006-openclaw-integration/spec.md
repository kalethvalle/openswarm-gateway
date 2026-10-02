---
id: SPEC-006
revision: 1
status: in_progress
depends_on: [SPEC-005]
tests: [test/integration-v2.test.ts]
---

# Compatibilidad y migración

## Requisitos y aceptación

- **SPEC-006-TOOLS**: Conservar API, autenticación, IDs, tool_choice, replay y ejecución de herramientas exclusivamente por el cliente.
- **SPEC-006-MIGRATION**: Estados v1 continúan con ejecutor anterior; estados v2 conservan pila y presupuestos al reiniciar.
- **SPEC-006-PORTABLE**: Solo migrar entre rondas completas, convertir historial de herramientas a evidencia sin reemitir llamadas ni transportar estado opaco.
- **SPEC-006-LIVE**: Comprobar OpenClaw con contexto habitual y herramientas; distinguir prueba real de prueba simulada.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.
