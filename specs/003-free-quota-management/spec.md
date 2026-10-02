---
id: SPEC-003
revision: 2
status: validated
depends_on: [SPEC-001, SPEC-002]
tests: [test/quota.test.ts]
---

# Cuotas persistentes

## Requisitos y aceptación

- **SPEC-003-ATOMIC**: Reservar solicitudes/tokens atómicamente en SQLite por cuenta y modelo, conservando intentos desconocidos.
- **SPEC-003-FALLBACK**: Preferir otro candidato elegible antes de esperar; respetar Retry-After y límites compartidos, máximo 5 segundos de espera.
- **SPEC-003-RESTART**: Conservar cuotas y pausas al reiniciar y no contabilizar cancelaciones antes del despacho.

## Alcance

Instalación propia, una instancia, Node.js 22 y SQLite. Compatibilidad Chat Completions de texto/herramientas; sin aislamiento multiusuario ni API Responses.

## Revisión 2

Un 429 de capacidad de modelo no agota toda la cuenta; los errores de cuota compartida sí bloquean el proveedor. Sin metadatos concluyentes se mantiene el límite configurado de cuenta y cooldown del modelo.
