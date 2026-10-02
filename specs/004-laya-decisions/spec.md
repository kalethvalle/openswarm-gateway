---
id: SPEC-004
revision: 1
status: in_progress
depends_on: [SPEC-002]
tests: [test/decisions.test.ts]
---

# Decisiones semánticas con Laya

## Requisitos y aceptación

- **SPEC-004-DECIDE**: Decidir especialidad y relevancia con Laya; conservar probabilidades, confianza, abstención, truncamiento y versión.
- **SPEC-004-ABSTAIN**: Con umbral provisional 0.95, no aceptar truncamiento/baja confianza; recurrir a decisión generativa con presupuesto.
- **SPEC-004-BOUNDS**: Acotar decisiones y tamaño de entrada; no usar reglas de texto para decidir intención.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.
