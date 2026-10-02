---
id: SPEC-007
revision: 1
status: in_progress
depends_on: [SPEC-006]
tests: [test/evaluation.test.ts]
---

# Evaluación y distribución MIT

## Requisitos y aceptación

- **SPEC-007-EVAL**: Separar 20 casos de desarrollo y 60 de evaluación ES/EN; comparar modelo único, secuencia y colaboración sobre tareas iguales.
- **SPEC-007-EVIDENCE**: Registrar calidad ejecutable, llamadas, tokens, tiempo y fallos; nunca declarar éxito por confianza o tamaño de respuesta.
- **SPEC-007-RELEASE**: CI sin claves, instalación reproducible, licencia MIT y Docker construido/ejecutado antes de declarar validación operativa.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.
