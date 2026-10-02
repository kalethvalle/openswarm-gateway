---
id: SPEC-001
revision: 1
status: validated
depends_on: []
tests: [test/runtime.test.ts]
---

# Runtime y presupuestos

## Requisitos y aceptación

- **SPEC-001-TOKENS**: Estimar tokens por tokenización con margen; ajustar solo con uso real y distinguir presupuesto local de cuota remota.
- **SPEC-001-QUEUE**: Reservar capacidad al despachar; rechazos y cancelaciones no dejan turnos fantasma.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.
