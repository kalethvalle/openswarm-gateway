import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { decisionInput } from '../src/decisions.js';
import { LayaRouter } from '../src/laya.js';
const split = process.argv.includes('--development') ? 'development' : 'heldout';
const source = await readFile(`evals/routing-${split}.json`, 'utf8');
const cases = JSON.parse(source) as { id: string; specialty: string; direct: boolean; language: string; prompt: string }[];
const config = loadConfig(process.env.CONFIG_PATH ?? 'config.yaml');
let metadata: Record<string, unknown> = {};
const router = new LayaRouter({ ...config.laya, enabled: true, mode: 'route', baseUrl: process.env.LAYA_BASE_URL ?? config.laya.baseUrl }, fields => { metadata = fields; });
const results = [];
for (const item of cases) {
  metadata = {}; const started = Date.now();
  const { text, questions } = decisionInput('initial', item.prompt, [{ id: 'a0', kind: 'source', role: 'user', content: item.prompt }]);
  const decision = await router.decide(text, questions, item.id, AbortSignal.timeout(15000));
  results.push({ id: item.id, expected: item.specialty, language: item.language, decision: decision ?? null, accepted: Boolean(decision), correct: decision?.specialty === item.specialty && (decision.specialty === 'general') === item.direct, durationMs: Date.now() - started, metadata });
}
const accepted = results.filter(r => r.accepted);
const report = { split, datasetHash: createHash('sha256').update(source).digest('hex'), threshold: config.laya.minConfidence, timestamp: new Date().toISOString(), total: results.length, accepted: accepted.length, correctAccepted: accepted.filter(r => r.correct).length, precisionAccepted: accepted.length ? accepted.filter(r => r.correct).length / accepted.length : null, coverage: accepted.length / results.length, results };
await mkdir('data', { recursive: true }); await writeFile(`data/routing-${split}-result.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: undefined }));
if (!results.some(r => Object.hasOwn(r.metadata, 'accepted'))) process.exitCode = 1;
