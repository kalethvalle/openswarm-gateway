import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/registry.js';
import { RunStore } from '../src/store.js';
import { QuotaLedger } from '../src/quota.js';
import { ModelRunner, UsageAccumulator } from '../src/runner.js';
import { Orchestrator } from '../src/orchestrator.js';
import { CollaborationEngine } from '../src/collaboration.js';
import { LayaRouter } from '../src/laya.js';
import { validateRequest } from '../src/validation.js';
import { extractModule, summarizeBenchmark } from '../src/evaluation.js';
import type { BenchmarkResult } from '../src/evaluation.js';
import { GatewayError } from '../src/errors.js';

if (process.env.RUN_LIVE_BENCHMARK !== '1') throw new Error('Set RUN_LIVE_BENCHMARK=1; this consumes free API quota and runs generated modules inside Docker.');
const check = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10000 });
if (check.status !== 0) throw new Error('Docker must be running before consuming model quota. Generated code is never executed on the host.');
const config = loadConfig(process.env.CONFIG_PATH ?? 'config.yaml');
if (config.version !== 2) throw new Error('Benchmark requires v2 configuration.');
const maxRuns = Number(process.env.BENCHMARK_MAX_RUNS ?? 3);
if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) throw new Error('BENCHMARK_MAX_RUNS must be 1..100.');
const dataset = await readFile('evals/coding.json', 'utf8');
const tasks = JSON.parse(dataset) as { id: string; prompt: string; cases: { input: unknown; expected: unknown }[] }[];
const hash = createHash('sha256').update(dataset + JSON.stringify(config)).digest('hex');
await mkdir('data/benchmark', { recursive: true });
const output = 'data/benchmark/results.jsonl';
const prior = await readFile(output, 'utf8').catch(() => '');
const records = prior.split('\n').filter(Boolean).map(line => JSON.parse(line));
const store = new RunStore('data/benchmark/quota-and-runs.sqlite', config.limits.idleTtlMs);
const registry = new ProviderRegistry(config);
try {
  const catalog = await registry.catalog(AbortSignal.timeout(15000));
  const runner = new ModelRunner(config, registry, catalog, () => {}, new QuotaLedger(store.quotaDatabase(), config));
  const laya = new LayaRouter({ ...config.laya, baseUrl: process.env.LAYA_BASE_URL ?? config.laya.baseUrl });
  let completed = 0;
  outer: for (const task of tasks) for (const mode of ['single', 'sequential', 'collaboration']) {
    const key = `${hash}:${mode}:${task.id}`;
    if (records.some(r => r.key === key && r.status === 'complete')) continue;
    if (completed >= maxRuns) break outer;
    completed++;
    const start = Date.now(); const budget = { calls: 0, tokens: 0 }; let content = ''; let passed = false; let status: BenchmarkResult['status'] = 'complete'; let code: string | undefined;
    const request = validateRequest({ model: 'openswarm-auto', messages: [{ role: 'user', content: `Implement this in JavaScript: ${task.prompt} Return only an ES module exporting function solve(input). No dependencies, filesystem or network access. Return code only, no Markdown. Do not run commands.` }] });
    const signal = AbortSignal.timeout(config.limits.requestTimeoutMs);
    try {
      if (mode === 'single') {
        const result = await runner.complete({ model: config.laya.codeModel ?? config.plannerModel, messages: request.messages, max_tokens: config.limits.maxOutputTokens, stream: false }, signal, new UsageAccumulator(budget), { runId: key, role: 'single' });
        if (result.result.finishReason !== 'stop') throw new GatewayError(502, 'incomplete_output', 'Incomplete module');
        content = result.result.message.content ?? '';
      } else {
        const prepared = store.prepare(request); if ('replay' in prepared) throw new Error('Unexpected replay'); prepared.state.budget = budget;
        const engine = mode === 'sequential' ? new Orchestrator(runner, store) : new CollaborationEngine(runner, store, laya);
        const response = await engine.execute(request, prepared, signal, { id: randomUUID(), created: Math.floor(Date.now() / 1000) });
        if (response.choices[0].finish_reason !== 'stop') throw new GatewayError(502, 'incomplete_output', 'Incomplete module');
        content = response.choices[0].message.content ?? '';
      }
      const directory = await mkdtemp(resolve('data/benchmark/task-'));
      await writeFile(resolve(directory, 'solution.mjs'), extractModule(content));
      await writeFile(resolve(directory, 'cases.json'), JSON.stringify(task.cases));
      await writeFile(resolve(directory, 'check.mjs'), `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {solve} from './solution.mjs'; const cases=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8')); for(const c of cases) assert.deepEqual(await solve(structuredClone(c.input)),c.expected);`);
      const verification = spawnSync('docker', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=128m', '--cpus=1', '--pids-limit=64', '--user=1000:1000', '-v', `${directory}:/work:ro`, '-w', '/work', 'node:22-bookworm-slim', 'node', 'check.mjs'], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
      passed = verification.status === 0; if (verification.error || verification.status === 125) { status = 'blocked'; code = 'verification_environment'; }
    } catch (error) { status = error instanceof GatewayError && [429, 503].includes(error.status) ? 'blocked' : 'failed'; code = error instanceof GatewayError ? error.code : 'benchmark_error'; }
    const record = { key, task: task.id, mode, status, passed, calls: budget.calls, tokens: budget.tokens, tokenAccounting: 'actual when reported; reservations for unknown attempts', durationMs: Date.now() - start, code, timestamp: new Date().toISOString(), datasetAndConfigHash: hash };
    records.push(record); await appendFile(output, JSON.stringify(record) + '\n'); console.log(JSON.stringify(record));
    if (status === 'blocked') break outer;
  }
  const summary = summarizeBenchmark(records.filter(r => r.datasetAndConfigHash === hash));
  await writeFile('data/benchmark/summary.json', JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} finally { registry.close(); store.close(); }
