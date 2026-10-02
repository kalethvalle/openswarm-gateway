# OpenSwarm Gateway

Gateway de Chat Completions en TypeScript, Node.js y Fastify. Un planificador interpreta cada petición y genera un equipo secuencial de **uno o dos agentes por defecto** con roles, instrucciones y modelos elegidos de una lista autorizada. Soporta Groq y OpenRouter; cada instancia selecciona un proveedor en `config.yaml`.

Cada agente puede solicitar herramientas al cliente. SQLite conserva el plan y el agente activo para reanudar la ejecución después de recibir los resultados. Los mensajes internos de los agentes no se muestran al usuario; se devuelve la síntesis final o una solicitud de herramientas.

## Arranque local

Requiere Node.js 22.13 o posterior, npm y una cuenta del proveedor seleccionado. El ejemplo usa Groq con GPT-OSS 20B, Qwen 3.8 27B y GPT-OSS 120B, y un clasificador Laya local opcional. Para reproducir la instalación, usa el lockfile incluido. Copia los ejemplos únicamente en una instalación nueva; conserva tu `.env` si ya existe.

```sh
npm ci
cp config.example.yaml config.yaml
cp .env.example .env
```

Edita `.env`: establece `GROQ_API_KEY` y una clave propia en `GATEWAY_API_KEY`. Los clientes usan la clave del Gateway. Edita `config.yaml` para elegir modelos disponibles en tu cuenta. Su disponibilidad y soporte de herramientas se validan al arrancar y al seleccionar el equipo.

```sh
npm run build
npm start
```

El servicio escucha en `http://127.0.0.1:3000`. `npm run dev` activa recarga del código. La configuración YAML se carga al arrancar: reinicia el proceso después de modificarla.

```sh
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openswarm-auto","messages":[{"role":"user","content":"Diseña una API de tareas pequeña."}],"stream":true}'
```

Para usar el ejemplo `curl`, exporta `GATEWAY_API_KEY` en esa terminal. La aplicación carga `.env` por sí misma; tu shell no lo carga automáticamente.

## Configuración de modelos y equipo

`provider: groq` usa `GROQ_API_KEY` y `https://api.groq.com/openai/v1`. `provider: openrouter` usa `OPENROUTER_API_KEY`; omitir `provider` conserva el comportamiento anterior de OpenRouter. Se mantiene `openswarm-auto` como modelo público de OpenClaw y n8n.

La configuración usa `openai/gpt-oss-20b` para respuestas y planificación, `qwen/qwen3.8-27b` para código y `openai/gpt-oss-120b` para revisión. Los tres tienen perfiles explícitos de herramientas, contrastados con el catálogo al arrancar. Los modelos Prompt Guard, de moderación y de audio no son candidatos al enjambre. La disponibilidad y las cuotas dependen de tu cuenta; los IDs de Groq no llevan `:free`. Los metadatos de costo cero de OpenClaw no garantizan gratuidad.

Groq recibe `max_completion_tokens`, sin los campos `provider` y `transforms` exclusivos de OpenRouter. Los mensajes `developer` se transmiten como `system`; se omite el nombre opcional de los resultados de herramientas. Los nombres en otros mensajes se rechazan porque Groq no los admite. El streaming reconoce uso tanto en `usage` como en `x_groq.usage`.

La configuración inicial permite dos agentes, 2048 tokens de salida por agente y 1024 para el planificador. Laya puede seleccionar una plantilla sin consumir una llamada de planificación en Groq. Si Laya no está disponible, tiene baja confianza o necesita un plan dinámico, se usa el planificador remoto.

Al cambiar de proveedor, inicia una conversación nueva en OpenClaw y usa una base distinta (`DATABASE_PATH=data/openswarm-groq.sqlite` para Groq). Las ejecuciones antiguas conservan modelos y estado propios de su proveedor. En Docker, `CONTAINER_DATABASE_PATH` selecciona el archivo dentro del volumen y vale `/app/data/openswarm-groq.sqlite` por defecto. Para volver a OpenRouter, usa `config.openrouter.example.yaml` o tu copia `config.openrouter.backup.yaml`, su clave y la ruta de base de datos anterior.

`models[].minIntervalMs` separa el comienzo de las llamadas a un mismo modelo dentro del proceso. Este perfil de pruebas usa **60000 ms** para evitar ráfagas con el contexto de OpenClaw y las cuotas de tokens de Groq. Aumenta la latencia; `Waiting for model slot` muestra la espera. No hay límite diario global ni coordinación entre instancias, y otras aplicaciones pueden consumir la misma cuota. El valor predeterminado del esquema es 0 (sin intervalo); ajústalo según tus límites reales.

`plannerModel` debe aparecer en `models`. Cada modelo declara `id`, `specialties` y `fallbacks`, una lista ordenada de otros modelos declarados. Las especialidades orientan al planificador; no fijan roles. El planificador no puede introducir modelos, URLs ni herramientas fuera de la configuración y la petición.

Al arrancar se consulta el catálogo del proveedor y se comprueba que todos los IDs tengan un perfil compatible. La ausencia de un modelo o el fallo del catálogo impiden el arranque. Las capacidades se mantienen durante la vida del proceso; reinicia para actualizarlas. La disponibilidad en el catálogo no garantiza acceso con una cuenta concreta ni disponibilidad de un proveedor en cada momento.

Para cada tarea, el planificador devuelve JSON con `intent` y `steps`. Cada paso tiene `role`, `objective`, `instructions`, `model` y `output` (`handoff` o `final`). Solo el último puede ser final. Una tarea simple usa un agente; un equipo mayor termina con una síntesis. Con los perfiles Groq compatibles, la planificación usa un JSON Schema estricto del lado del proveedor. Después se valida el plan y su secuencia en el Gateway. Un plan inválido tiene un intento de reparación y luego produce `invalid_plan`. El formato estructurado es interno; no habilita `response_format` en el contrato público.

Si la petición incluye herramientas o parámetros opcionales, se excluyen los modelos que no anuncian soporte. El planificador puede usar un modelo sin herramientas, porque su trabajo no las ejecuta. Es necesario configurar al menos un modelo con herramientas para las peticiones que las usan.

Las etapas reciben la conversación original y los productos anteriores, incluidos los resultados de herramientas. Los metadatos de razonamiento del proveedor se conservan únicamente en la conversación del agente que los originó.

| Límite | Valor inicial |
| --- | --- |
| Agentes por ejecución | 2 |
| Rondas de herramientas por ejecución | 4 |
| Intentos de modelo por ejecución, incluidos fallbacks | 8 |
| Presupuesto de tokens por ejecución | 60000 |
| Tiempo por intento de modelo | 120 segundos |
| Tiempo por petición HTTP | 300 segundos |
| Caducidad por inactividad | 24 horas |
| Salida máxima por llamada de agente | 2048 tokens |
| Salida del planificador | 1024 tokens |
| Cuerpo HTTP | 2 MiB |

Todos están en `limits` del YAML. El máximo de seis agentes es un límite del MVP. Los límites de salida del cliente se acotan al máximo del servidor. El plazo de cada petición HTTP comienza de nuevo después de que el cliente ejecuta las herramientas. Los contadores de rondas, llamadas y tokens pertenecen a la ejecución completa y se conservan en SQLite durante las continuaciones. Los tokens se reservan antes de llamar al proveedor usando una estimación conservadora; se ajustan al recibir uso real. Si un intento falla o no informa uso, la reserva se mantiene. Un HTTP 429 previo a generación libera su reserva de tokens, pero sigue contando como intento. Alcanzar el presupuesto devuelve `run_budget_exceeded`. Son límites por ejecución, no cuotas diarias compartidas ni un medidor exacto de facturación.

El control de contexto utiliza una estimación conservadora basada en bytes UTF-8 y margen para el protocolo, no un tokenizador exacto para cada modelo. Puede rechazar entradas que cabrían con un tokenizador específico; nunca descarta mensajes ni resume silenciosamente. Si se agota el contexto, devuelve `context_length_exceeded`. Una etapa interna truncada produce `incomplete_handoff`.

## Laya local: rutas económicas para OpenClaw

Laya selecciona una ruta entre opciones fijas; no genera código. La integración es experimental: la confianza del checkpoint no está calibrada para estas tareas. `minConfidence: 0.95` es un umbral operativo, no una garantía del 95 % de aciertos.

| Ruta | Ejecución en Groq |
| --- | --- |
| `answer` | GPT-OSS 20B |
| `code` | Qwen 3.8 27B |
| `review` | GPT-OSS 120B |
| `code_review` | Qwen → revisión GPT-OSS 120B |
| `plan` o fallo/baja confianza | Planificador GPT-OSS 20B → hasta dos agentes |

El modo `route` aplica las plantillas; `observe` registra la decisión y conserva siempre el planificador remoto. `enabled: false` desactiva Laya. Un resultado desconocido, truncado o que incumpla el contrato tampoco selecciona una plantilla. Solo se envían al clasificador los últimos cuatro mensajes de usuario/asistente; entradas mayores que `maxInputChars` pasan al planificador. El agente generador recibe el contexto original completo. Las instrucciones de las plantillas se definen en el Gateway y no proceden del clasificador.

Primera instalación (Python 3.11 y `uv`):

```sh
uv venv --python 3.11 .venv-laya
uv pip install --python .venv-laya/bin/python -r requirements-laya.txt
npm run dev:laya
```

El primer arranque descarga el checkpoint multilingüe revisado. Necesita red, memoria y espacio locales; espera a que termine la carga. El servicio queda en `127.0.0.1:8001`. En otra terminal inicia `npm run dev`. OpenClaw conserva su proveedor `openswarm/openswarm-auto` y su clave actual.

```sh
curl http://127.0.0.1:8001/health
curl http://127.0.0.1:3000/readyz
```

Un log `Routing decision` con `reason: template_selected` indica que se omitió la planificación remota. `low_confidence`, `timeout`, `unavailable` o `planner_required` explican el retorno al planificador. `Model completed` muestra las llamadas reales. No se promete ahorro si casi todas las tareas necesitan fallback.

El código se escribe y comprueba mediante las herramientas que OpenClaw autorice. El Gateway conserva los IDs y las continuaciones; no ejecuta shell ni pruebas por su cuenta. Las plantillas solicitan como máximo un intento de reparación, pero ese límite es una instrucción al modelo; los límites estrictos son rondas, llamadas y tokens.

### Evaluar el clasificador sin consumir Groq

```sh
npm run eval:laya
```

Ejecuta diez ejemplos en español y guarda `data/laya-eval.json` con ruta esperada, predicha, confianza y duración. En la primera evaluación acertó 8/10 etiquetas; con umbral 0.85 aceptó una ruta equivocada. Al elevarlo a 0.95, aplicó 3/10 plantillas y derivó las otras siete al planificador, sin rutas equivocadas entre las aceptadas **en esta misma muestra**. El umbral se ajustó con esos casos: hace falta un conjunto independiente antes de medir precisión real o ahorro general. Esto mide clasificación, no calidad del código generado.

### Prueba aislada con OpenClaw instalado

```sh
RUN_LIVE_SMOKE=1 npm run smoke:openclaw
```

Reutiliza el proveedor `openswarm` de tu OpenClaw y genera una configuración de prueba con solo `read`, `write` y `exec`. Usa una referencia de entorno para la clave. La tarea permite crear dos archivos y ejecutar `node:test` en una carpeta nueva dentro de `data/openclaw-laya-smoke`; guarda el resultado en `data/openclaw-smoke-result.json`. Desactiva el guardado automático de memoria en esa configuración de prueba. No cambia tu configuración principal. Consume cuota; incluso con pocas herramientas, el contexto de OpenClaw puede alcanzar el límite de tokens por minuto de Groq. Evita ejecutar varias pruebas reales en paralelo.

### Docker con los dos servicios

Detén primero los procesos locales que ocupen los puertos 3000 y 8001:

```sh
docker compose -f compose.yaml -f compose.laya.yaml config --quiet
docker compose -f compose.yaml -f compose.laya.yaml up -d --build
docker compose -f compose.yaml -f compose.laya.yaml logs -f gateway laya
```

El Gateway usa `http://laya:8001` dentro de Docker. OpenClaw en el Mac sigue usando `http://127.0.0.1:3000/v1`. El volumen `laya-models` conserva la descarga; `swarm-data` conserva SQLite. Docker usa CPU; reserva recursos suficientes para PyTorch y el checkpoint. El inicio depende de que Laya termine su carga. Para detener ambos sin borrar los volúmenes:

```sh
docker compose -f compose.yaml -f compose.laya.yaml down
```

Con `docker compose up --build` sin el override, no se inicia Laya: si está habilitado, se usará el planificador al fallar su conexión. Para esa modalidad puedes desactivarlo explícitamente en el YAML.

Referencias: [Laya](https://github.com/NandhaKishorM/laya), [API HTTP](https://nandhakishorm.github.io/laya/http-api/).

## Contrato HTTP

| Endpoint | Uso |
| --- | --- |
| `POST /v1/chat/completions` | Chat, SSE y herramientas de función |
| `GET /v1/models` | Descubrimiento de `openswarm-auto` |
| `GET /healthz` | Proceso activo |
| `GET /readyz` | Inicialización terminada y SQLite disponible |

`/v1/*` requiere `Authorization: Bearer <GATEWAY_API_KEY>`. Hay una clave compartida y una única instancia; no hay aislamiento multiusuario. `readyz` no ejecuta una inferencia ni comprueba continuamente el acceso a cada modelo.

Parámetros admitidos:

- `model: "openswarm-auto"`, `messages`, `stream` y `n: 1`.
- Roles `system`, `developer`, `user`, `assistant` y `tool`. Se acepta texto como cadena o una lista de partes `{type:"text", text:"..."}`, que se normaliza a una cadena.
- `tools` de tipo `function`, `tool_choice` (`auto`, `none`, `required` o una función concreta), y `parallel_tool_calls`.
- `temperature`, `top_p`, `stop`, `max_tokens` o `max_completion_tokens` (no ambos).
- `stream_options.include_usage` cuando `stream=true`.

Los parámetros de generación se aplican a los agentes, no al planificador. `parallel_tool_calls` controla varias herramientas dentro de una respuesta; los agentes siguen siendo secuenciales. `tool_choice: required` o una función concreta obliga a devolver herramientas en esa petición HTTP. Para permitir una respuesta final después, envía `auto` u omite `tool_choice` en la continuación.

Los argumentos se validan como objetos JSON contra el esquema de la función antes de entregarlos. Se admite JSON Schema draft-07 con referencias locales. Los formatos se consideran anotaciones, no validaciones; no se cargan referencias remotas ni se modifican los argumentos. Los esquemas inválidos se rechazan antes de llamar a modelos. `strict` se transmite al proveedor cuando se especifica.

Se rechazan explícitamente campos no implementados: modalidades de imagen/audio, `response_format`, múltiples respuestas, herramientas personalizadas, logprobs, almacenamiento OpenAI y extensiones de proveedores. No se implementan Responses API ni endpoints nativos de Ollama. La compatibilidad corresponde al contrato anterior, no a toda la superficie de OpenAI ni a todas las funciones de cada cliente.

### Herramientas y continuaciones

1. El cliente envía la conversación y los esquemas de herramientas.
2. Cualquier agente puede devolver `tool_calls`; el Gateway persiste el estado antes de emitir sus IDs públicos y termina con `finish_reason: "tool_calls"`.
3. El cliente ejecuta las herramientas y agrega a `messages` el mensaje del asistente y un mensaje `tool` por cada llamada.
4. El cliente reenvía la conversación completa y los mismos esquemas. El Gateway encuentra la ejecución mediante `tool_call_id`, reanuda el mismo agente y continúa el equipo.

Los IDs públicos nuevos usan `call` seguido de 32 caracteres hexadecimales, compatibles con la normalización de OpenClaw. Para llamadas antiguas guardadas como `call_<hex>`, también se admite la variante sin `_`, comprobándola contra SQLite. Esa equivalencia se aplica al historial y a los reintentos; los resultados de ejecuciones distintas, las coincidencias ambiguas y los cambios de contenido siguen rechazándose. No hace falta migrar la base de datos ni cambiar las claves. `unknown_tool_call` (HTTP 400) indica que no se pudo relacionar la continuación con las llamadas guardadas; revisa los IDs, la persistencia y el TTL.

No se necesita un ID de sesión adicional. Conserva todos los mensajes de la conversación y las definiciones de herramientas durante las continuaciones. Todos los resultados de una ronda deben llegar juntos; el MVP no admite compactar o modificar la conversación durante una pausa. Después de una respuesta final, una nueva pregunta genera otro plan.

Los argumentos de las llamadas del asistente se comparan como JSON: cambios de espacios u orden de claves se aceptan; cambios de valores siguen rechazándose. Para un mensaje con herramientas, texto vacío y `null` son equivalentes. Se conserva el mensaje original del proveedor para reanudarlo.

Las continuaciones idénticas completadas reproducen la respuesta almacenada sin nuevas inferencias, incluso si cambia el modo JSON/SSE. Una continuación concurrente o modificada devuelve `409`. La igualdad incluye el orden de los mensajes y los parámetros de generación; omitir un valor explícito puede contar como una petición distinta. Las peticiones iniciales no se deduplican.

IDs desconocidos o caducados devuelven un error. Un reinicio conserva ejecuciones esperando herramientas; las que estaban procesando se marcan interrumpidas y no se repiten automáticamente. Para una ejecución interrumpida, inicia una nueva tarea con el contexto relevante y sin presentar resultados pendientes como una continuación recuperable.

El Gateway no ejecuta shell, archivos, HTTP ni herramientas del cliente. La autorización de esas acciones pertenece al cliente. La persistencia evita duplicar inferencias en una continuación; no garantiza ejecución única de efectos externos si el cliente vuelve a ejecutar una herramienta.

### Streaming, fallos y uso

Se transmiten deltas de texto de la etapa final. El trabajo previo es interno y puede retrasar el primer token; se envía un comentario SSE cada 15 segundos. Las llamadas a herramientas se acumulan, validan y guardan antes de emitir sus deltas: sus argumentos no aparecen token a token mientras el modelo los genera.

Al recibir `429`, se respeta `Retry-After` mediante una pausa por modelo en este proceso (30 segundos si no llega una cabecera válida). Durante esa pausa se omite el modelo; se puede usar un suplente configurado. El estado de esas pausas se reinicia con el proceso. Antes de iniciar SSE se propaga `Retry-After` al cliente. `limits.rateLimitRetries: 1` permite un único reintento al mismo modelo ante un HTTP 429 previo a generación, esperando `Retry-After` (30 segundos si falta) y respetando el intervalo por modelo. No espera cabeceras mayores a 60 segundos. La espera admite cancelación y el reintento consume el presupuesto de llamadas; el esquema permite desactivarlo con 0. Esto también se aplica al modelo fijado durante una continuación, sin cambiarlo.

Los suplentes se prueban en orden ante errores temporales de red, `429`, tiempos agotados y errores del proveedor. No se cambia de modelo después de publicar texto, ni al reanudar un agente que ya entregó herramientas. Los errores de configuración, autorización del proveedor y respuestas inválidas no disparan suplencias automáticas.

Antes de comenzar SSE, los errores usan estado HTTP y `{error:{message,type,code,param}}`. Después de iniciar SSE, se emite un evento `data` con ese error y se cierra sin `[DONE]`. La desconexión del cliente cancela el transporte hacia el proveedor seleccionado; el proveedor puede seguir facturando según su soporte de cancelación.

`usage` suma la planificación y las llamadas de agentes realizadas durante esa petición HTTP. Si alguna llamada o intento carece de medición, se omite el total. En SSE se entrega un chunk con `choices: []` solo cuando se pidió `include_usage` y existe un total completo. El campo `model` público siempre es `openswarm-auto`; los modelos efectivos aparecen en los logs.

## Clientes

Para OpenClaw, OpenCode, extensiones de VS Code o n8n que permitan un proveedor de Chat Completions compatible:

| Ajuste | Valor |
| --- | --- |
| URL base | `http://127.0.0.1:3000/v1` |
| API key | Tu `GATEWAY_API_KEY` |
| Modelo | `openswarm-auto` |
| Protocolo | Chat Completions |
| Tiempo de espera sugerido | Más de 300 segundos |

Si la interfaz pide una URL completa de endpoint, usa `/v1/chat/completions`. Los nombres de los ajustes dependen del cliente. No uses las modalidades Responses/Anthropic. Si el cliente compacta conversaciones en mitad de un ciclo de herramientas, la continuación será rechazada.

Ejemplo con el SDK de OpenAI:

```ts
import OpenAI from 'openai';
const client = new OpenAI({
  apiKey: process.env.GATEWAY_API_KEY,
  baseURL: 'http://127.0.0.1:3000/v1',
  timeout: 310_000,
  maxRetries: 0,
});
const response = await client.chat.completions.create({
  model: 'openswarm-auto',
  messages: [{ role: 'user', content: 'Explica esta arquitectura.' }],
});
console.log(response.choices[0]?.message.content);
```

## Docker y operación

Después de crear `.env` y `config.yaml`:

```sh
docker compose up --build
```

Compose publica el puerto solo en localhost y guarda SQLite en el volumen `swarm-data`. Ejecuta una sola réplica por base de datos. La imagen compila el módulo nativo de SQLite y ejecuta el servicio con el usuario `node`.

La base contiene conversaciones, resultados y estado opaco de proveedores; sus permisos y copias de seguridad corresponden al operador. El proceso limpia ejecuciones inactivas cada minuto. Las solicitudes activas quedan excluidas de la limpieza y están acotadas por sus plazos. El cierre por SIGINT/SIGTERM cancela solicitudes activas.

Los logs registran ejecución, rol, modelo real, suplencias, duración, uso y códigos de error. Cuando el proveedor devuelve un error HTTP JSON, `upstreamStatus` y `upstreamCode` conservan su clasificación sin registrar el mensaje bruto ni la generación fallida. No registran por defecto prompts, resultados completos ni claves. No hay selección automática por costo/latencia, métricas exportadas ni panel administrativo. Laya es un clasificador local; la generación sigue usando el proveedor configurado.

## Desarrollo y verificación

Los resultados y las limitaciones de las pruebas reales están en [docs/laya-validation.md](docs/laya-validation.md).

```sh
npm run typecheck
npm test
npm run build
```

Las pruebas usan SQLite real, proveedores simulados y el SDK oficial de OpenAI con transporte hacia Fastify. Cubren planes, contexto, JSON/SSE, herramientas, reinicios, duplicados, concurrencia, límites, fallbacks, cancelación y errores del transporte OpenRouter. No requieren claves ni consumen inferencias.

La prueba real es optativa y consume cuota o créditos del proveedor seleccionado. Con el Gateway ya iniciado y `.env` configurado:

```sh
RUN_LIVE_SMOKE=1 npm run smoke
```

Comprueba descubrimiento, texto SSE y un ciclo de la herramienta `echo`, ejecutada en el script. `GATEWAY_BASE_URL` permite apuntarla a otra instancia. OpenCode, VS Code y n8n no se han probado directamente. La prueba de OpenClaw instalada se ejecuta por separado mediante `smoke:openclaw`; consulta su resultado guardado para distinguir un ciclo completo de uno interrumpido por cuota.

Además, se comprobó de forma aislada el adaptador Chat Completions y el normalizador de IDs de OpenClaw 2026.8.2 contra el Gateway con proveedores simulados: llamada a herramienta, continuación SSE y reintento, tanto con IDs nuevos como con IDs antiguos sin `_`. Esto no sustituye una prueba completa de la aplicación y sus herramientas con modelos reales.

## Organización

- `src/app.ts`: HTTP, autenticación y SSE.
- `src/planner.ts`, `src/orchestrator.ts`: generación del equipo y avance del pipeline.
- `src/runner.ts`, `src/provider.ts`, `src/groq.ts`: selección de suplentes, capacidades y transporte de Groq/OpenRouter.
- `src/store.ts`: migración SQLite, checkpoints, pausas y respuestas repetibles.
- `src/validation.ts`, `src/tool-validation.ts`: contrato de entrada y argumentos de herramientas.

Referencias: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [herramientas OpenRouter](https://openrouter.ai/docs/guides/features/tool-calling), [SSE OpenRouter](https://openrouter.ai/docs/api/reference/streaming) y [catálogo de modelos](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Groq: [compatibilidad](https://console.groq.com/docs/openai), [API y catálogo](https://console.groq.com/docs/api-reference), [herramientas](https://console.groq.com/docs/tool-use/overview) y [límites](https://console.groq.com/docs/rate-limits).
