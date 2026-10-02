> Informe histórico del prototipo v0.1. Los límites y resultados aquí descritos no validan v0.2; consulta v0.2-validation.md.

# Validación de Laya + Groq + OpenClaw

Pruebas realizadas el 1 de octubre de 2026 (America/Bogota).

## Resultado comprobado

- 54 pruebas automatizadas del Gateway aprobadas; comprobación de tipos y compilación correctas.
- Laya 0.3.23 instalado en `.venv-laya`, checkpoint multilingüe cargado localmente en CPU. Servicio en `127.0.0.1:8001`.
- Gateway activo en `127.0.0.1:3000`; conserva el modelo público `openswarm-auto` y las claves existentes.
- Prueba real de texto SSE y herramienta `echo` aprobada con Groq mientras Laya todavía estaba cargando: se comprobó el retorno al planificador.
- Configuración Compose de ambos servicios validada. Las imágenes Docker no se construyeron ni ejecutaron en esta sesión.

## Evaluación pequeña del clasificador

`npm run eval:laya` ejecuta diez ejemplos en español sin consultar Groq. Resultado: 8/10 etiquetas correctas.

Con umbral 0.85 se aceptaron cuatro rutas, una equivocada. Con 0.95 se aceptaron tres, todas correctas en esos mismos casos; las otras siete pasan al planificador. El umbral se ajustó usando esta muestra. **No es una evaluación independiente ni una probabilidad calibrada de acierto**, y no mide calidad de código.

Datos: `data/laya-eval-baseline.json` y `data/laya-eval.json`.

## Prueba real con OpenClaw instalado

La tarea pidió crear `validarTitulo`, cinco pruebas con `node:test`, ejecutarlas y revisar el código. Se usó una configuración aislada con el proveedor existente y las herramientas de archivos/exec.

La ejecución principal `52e466e5-49f2-43b0-85c2-df47aa17cda8` terminó en el Gateway con estado `complete` y `finish_reason: stop`:

1. Laya devolvió baja confianza y se usó el planificador GPT-OSS 20B.
2. Qwen recibió dos HTTP 429. Sus intentos se contaron y sus reservas de tokens se liberaron.
3. GPT-OSS 20B actuó como suplente, pidió `exec`, creó los archivos y ejecutó las cinco pruebas: **5 aprobadas, 0 fallidas**.
4. El mismo modelo continuó con el resultado de la herramienta.
5. GPT-OSS 120B entregó la revisión final.

Contadores del Gateway: seis intentos, una ronda de herramientas y 19.543 tokens de uso informado para esa ejecución. No incluyen otros ensayos ni las tareas automáticas del cliente.

Evidencia:

- `data/openclaw-gateway-run.json`: respuesta final y contadores persistidos.
- `data/openclaw-laya-smoke/run-gnP9ZL/tasks.mjs`: función creada por OpenClaw.
- `data/openclaw-laya-smoke/run-gnP9ZL/tasks.test.mjs`: pruebas ejecutadas por su herramienta.

Después del resultado principal, el CLI inició un *memory flush* automático. Se detuvo esa tarea adicional para evitar más consumo. Por ello no se declara exitoso el proceso CLI completo de ese ensayo. El script reproducible ahora desactiva `compaction.memoryFlush` solo en su configuración aislada; ese último ajuste no se volvió a probar con un ciclo completo del CLI.

## Ruta local aplicada con Groq real

La petición `31117c4d-6e6e-498d-bfc3-4dda0a19d797` seleccionó `code_review` con confianza 0.9744, sin llamar al planificador. Qwen devolvió primero un HTTP 429 y respondió tras el reintento; después intervino GPT-OSS 120B. El endpoint respondió HTTP 200 en unos 72 segundos. La salida final terminó con `finish_reason: length` al alcanzar el límite explícito de 1024 tokens de esta prueba: **se validó el enrutamiento, pero la respuesta quedó truncada**. Evidencia: `data/laya-code-review-result.json`.

## Fallos encontrados y controles incorporados

- OpenClaw vuelve a serializar argumentos JSON: ahora se aceptan espacios y orden de claves equivalentes, manteniendo el rechazo de valores alterados.
- Las llamadas con varios miles de tokens alcanzaron cuotas por minuto. El perfil de prueba separa llamadas al mismo modelo por 60 segundos y permite un reintento acotado de HTTP 429.
- Groq también devolvió errores de generación de herramientas y `json_validate_failed`. El planificador usa JSON Schema estricto, pero los ensayos muestran que aún deben manejarse errores del proveedor.
- Las reservas y los contadores se guardan en SQLite durante las continuaciones. Límites: dos agentes, cuatro rondas, ocho intentos y 60.000 tokens por ejecución.

Las esperas aumentan la latencia. El intervalo es por proceso/modelo y no coordina otras aplicaciones ni garantiza cuota diaria. Un cliente puede iniciar una ejecución nueva al reintentar una petición inicial; los presupuestos no son una cuota global de cuenta.

## Repetir las pruebas

```sh
npm run dev:laya
# En otra terminal:
npm run dev
# En otra terminal:
npm run eval:laya
RUN_LIVE_SMOKE=1 npm run smoke:openclaw
```

La prueba con OpenClaw consume cuota y usa una carpeta nueva en `data/openclaw-laya-smoke`. Su resultado se guarda en `data/openclaw-smoke-result.json`; revisa también el código de salida del comando. Evita ejecutar varias pruebas reales simultáneamente.
