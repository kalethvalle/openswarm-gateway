---
id: SPEC-005
revision: 1
status: validated
depends_on: [SPEC-003, SPEC-004]
tests: [test/collaboration.test.ts]
---

# Colaboración y contexto

## Requisitos y aceptación

- **SPEC-005-CONSULT**: Responsable y pila persistente de consultas secuenciales: máximo 3 consultas, profundidad 2 y 8 intentos generativos.
- **SPEC-005-CONTEXT**: Resolver referencias del almacén canónico; mantener instrucciones/requisitos originales, separar evidencia de resumen, permitir lectura adicional.
- **SPEC-005-CYCLES**: Rechazar consultas idénticas sin evidencia nueva; no transferir razonamiento opaco ni publicar controles internos.
- **SPEC-005-INTEGRATE**: Devolver aportaciones al solicitante e integrar el resultado antes de publicarlo.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.
