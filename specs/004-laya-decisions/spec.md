---
id: SPEC-004
revision: 2
status: validated
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

## Revisión 2

En desarrollo, exigir simultáneamente especialidad y delivery aceptó 0/20 casos. El contrato inicial usa una única clasificación de especialidad: general selecciona respuesta directa; las demás habilitan colaboración. No cambia el umbral. Evaluación y producción comparten decisionInput.
