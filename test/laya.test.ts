import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayaRouter } from '../src/laya.js';
import { UsageAccumulator } from '../src/runner.js';
import { configSchema } from '../src/config.js';
import { validateRequest } from '../src/validation.js';
import { fixture, configuration, base, headers, answer, planned, tools, toolAnswer, continueWith } from './helpers.js';

function settings(mode: 'route' | 'observe' = 'route') {
  return configSchema.parse({ ...configuration(), laya: { enabled: true, mode, generalModel: 'worker', codeModel: 'worker', reviewModel: 'backup' } });
}
function classified(choice = 'code', probability = 0.98, extra = {}) {
  return { answers: { route: { choice, answer_confidence: probability } }, ...extra };
}
test('local classification replaces planning, logs no prompt and returns normal completion', async t => {
  const config = settings(); const logs: any[] = []; let payload: any;
  const laya = new LayaRouter(config.laya, fields => logs.push(fields), async (_url, init) => {
    payload = JSON.parse(String(init?.body)); return Response.json(classified());
  });
  const { app, provider } = await fixture([answer('implemented')], { config, laya }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 200); assert.equal(response.json().choices[0].message.content, 'implemented');
  assert.equal(provider.calls.length, 1); assert.equal(payload.model, 'multilingual');
  assert.equal(logs[0].reason, 'template_selected'); assert.doesNotMatch(JSON.stringify(logs), /Solve this task/);
});
test('observation, low confidence, malformed and truncated output, and unavailable Laya use planner', async t => {
  for (const scenario of ['observe', 'low', 'truncated', 'bad', 'offline', 'plan']) {
    const config = settings(scenario === 'observe' ? 'observe' : 'route');
    const laya = new LayaRouter(config.laya, () => {}, async () => {
      if (scenario === 'offline') throw new Error('offline');
      return Response.json(scenario === 'bad' ? {} : classified(scenario === 'plan' ? 'plan' : 'code', scenario === 'low' ? 0.5 : 0.98, scenario === 'truncated' ? { usage: { truncated: true } } : {}));
    });
    const { app, provider } = await fixture([planned(), answer('done')], { config, laya }); t.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
    assert.equal(response.statusCode, 200, scenario); assert.equal(provider.calls[0]!.model, 'planner');
  }
});
test('Laya cannot introduce a model or accept overlong input; cancellation propagates', async () => {
  const config = settings();
  const laya = new LayaRouter(config.laya, () => {}, async () => Response.json(classified('arbitrary-model')));
  assert.equal(await laya.select(validateRequest(base), 'run', new AbortController().signal), undefined);
  const large = new LayaRouter({ ...config.laya, maxInputChars: 1 }, () => {}, async () => { throw new Error('must not fetch'); });
  assert.equal(await large.select(validateRequest(base), 'run', new AbortController().signal), undefined);
  const controller = new AbortController(); controller.abort();
  const cancelled = new LayaRouter(config.laya, () => {}, async () => { throw controller.signal.reason; });
  await assert.rejects(cancelled.select(validateRequest(base), 'run', controller.signal), { name: 'AbortError' });
});
test('classification happens once across tool continuations and replay; run budget survives', async t => {
  const config = settings(); config.limits.maxModelCalls = 1;
  let classifications = 0;
  const laya = new LayaRouter(config.laya, () => {}, async () => { classifications++; return Response.json(classified()); });
  const { app, provider } = await fixture([toolAnswer()], { config, laya }); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const next = continueWith(original, first);
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next });
  assert.equal(response.json().error.code, 'run_budget_exceeded');
  assert.equal(classifications, 1); assert.equal(provider.calls.length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next })).statusCode, 409);
});
test('review template selects two stages and respects maxAgents', async t => {
  for (const maxAgents of [1, 2]) {
    const config = settings(); config.limits.maxAgents = maxAgents;
    const laya = new LayaRouter(config.laya, () => {}, async () => Response.json(classified('code_review')));
    const { app, provider } = await fixture(maxAgents === 2 ? [answer('draft'), answer('reviewed')] : [planned(), answer('done')], { config, laya }); t.after(() => app.close());
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base })).statusCode, 200);
    assert.deepEqual(provider.calls.map(call => call.model), maxAgents === 2 ? ['worker', 'backup'] : ['planner', 'worker']);
  }
});
test('conservative token budget rejects before any inference', async t => {
  const config = configuration({ maxRunTokens: 1 });
  const { app, provider } = await fixture([], { config }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.json().error.code, 'run_budget_exceeded'); assert.equal(provider.calls.length, 0);
});

test('a paused Laya route preserves its call budget across a SQLite restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'laya-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = settings(); config.limits.maxModelCalls = 1;
  const path = join(directory, 'state.sqlite');
  const laya = new LayaRouter(config.laya, () => {}, async () => Response.json(classified()));
  const first = await fixture([toolAnswer()], { path, config, laya });
  const original = { ...base, tools };
  const response = await first.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original });
  assert.equal(response.statusCode, 200);
  await first.app.close();
  const second = await fixture([], { path, config, laya }); t.after(() => second.app.close());
  const resumed = await second.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, response.json()) });
  assert.equal(resumed.json().error.code, 'run_budget_exceeded');
  assert.equal(second.provider.calls.length, 0);
});

test('failed and unmetered attempts retain reservations; metered attempts settle only their own', () => {
  const budget = { calls: 0, tokens: 0 }; let checkpoints = 0;
  const accumulator = new UsageAccumulator(budget, () => { checkpoints++; });
  const limits = configuration({ maxRunTokens: 100, maxModelCalls: 5 }).limits;
  accumulator.reserve(30, limits); accumulator.unknown();
  accumulator.reserve(30, limits); accumulator.add();
  accumulator.reserve(30, limits); accumulator.add({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
  assert.deepEqual(budget, { calls: 3, tokens: 70 });
  assert.equal(checkpoints, 4); assert.equal(accumulator.value(), undefined);
  assert.throws(() => accumulator.reserve(31, limits), /budget/);
  assert.deepEqual(budget, { calls: 3, tokens: 70 });
});

test('Laya cancels an oversized response and falls back without buffering the stream', async () => {
  let cancelled = false;
  const laya = new LayaRouter(settings().laya, () => {}, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; },
  })));
  assert.equal(await laya.select(validateRequest(base), 'large', new AbortController().signal), undefined);
  assert.equal(cancelled, true);
});
