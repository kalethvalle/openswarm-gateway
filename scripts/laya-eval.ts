import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { LayaRouter } from '../src/laya.js';
import { validateRequest } from '../src/validation.js';

// A small Spanish smoke set, not a calibrated benchmark. No Groq calls.
const cases = [
  ['greeting', 'answer', 'Hola, responde con un saludo breve.'],
  ['explanation', 'answer', 'Explica en dos frases qué es una API REST. No escribas código.'],
  ['summary', 'answer', 'Resume esta frase: una tarea puede estar pendiente o completada.'],
  ['function', 'code', 'Genera una función TypeScript que reciba un título y devuelva true solo si es texto no vacío.'],
  ['bugfix', 'code', 'Corrige este código JavaScript: function suma(a,b) { return a-b; }. Debe sumar dos números.'],
  ['review', 'review', 'Revisa este código y señala errores, sin implementarlo: function divide(a,b) { return a/b; }'],
  ['audit', 'review', 'Audita este código sin modificarlo: app.get("/user", (req,res) => res.send(db.query("SELECT * FROM users WHERE id=" + req.query.id)));'],
  ['code-review', 'code_review', 'Implementa una función TypeScript para validar títulos de tareas y luego solicita una revisión independiente del código.'],
  ['architecture', 'plan', 'Diseña e implementa una plataforma distribuida con autenticación, pagos, colas de trabajos y múltiples servicios. Necesito un plan por componentes.'],
  ['ambiguous', 'plan', 'Arregla lo que está fallando en mi sistema; no sé dónde está el problema.'],
] as const;
const config = loadConfig(process.env.CONFIG_PATH ?? 'config.yaml');
const results: Record<string, unknown>[] = [];
for (const [id, expected, prompt] of cases) {
  let decision: Record<string, unknown> = {};
  const router = new LayaRouter({ ...config.laya, enabled: true, mode: 'route', baseUrl: process.env.LAYA_BASE_URL ?? config.laya.baseUrl }, fields => { decision = fields; });
  const plan = await router.select(validateRequest({ model: 'openswarm-auto', messages: [{ role: 'user', content: prompt }] }), `eval-${id}`, AbortSignal.timeout(30_000));
  const result = { id, expected, predicted: decision.route ?? null, confidence: decision.answerConfidence ?? null, reason: decision.reason, durationMs: decision.durationMs, selectedTemplate: Boolean(plan), correct: decision.route === expected };
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = { timestamp: new Date().toISOString(), minConfidence: config.laya.minConfidence, cases: results.length, correct: results.filter(r => r.correct).length, accepted: results.filter(r => r.selectedTemplate).length, wrongAccepted: results.filter(r => r.selectedTemplate && !r.correct).length, results };
await mkdir('data', { recursive: true });
await writeFile('data/laya-eval.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));
if (results.some(r => r.predicted === null)) process.exitCode = 1;
