import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRunner, UsageAccumulator } from '../src/runner.js';
import { estimateInputTokens } from '../src/tokens.js';
import { FakeProvider, configuration, answer } from './helpers.js';
import type { ProviderInput } from '../src/types.js';

test('SPEC-001-TOKENS: 100KB context budgets tokens rather than bytes', async () => {
  const input: ProviderInput = { model: 'worker', messages: [{ role: 'system', content: 'A short instruction. '.repeat(5000) }], max_tokens: 100, stream: false };
  const estimate = estimateInputTokens(input);
  assert.ok(estimate.bytes > 90000); assert.ok(estimate.tokens < 60000);
  const provider = new FakeProvider([answer('ok')]);
  await new ModelRunner(configuration({ maxRunTokens: 60000 }), provider, provider.models).complete(input, new AbortController().signal, new UsageAccumulator(), { runId: 'budget', role: 'worker' });
  assert.equal(provider.calls.length, 1);
});
test('SPEC-001-QUEUE: rejected budgets never reserve a pacing slot', async () => {
  const config = configuration({ maxRunTokens: 1000 }); config.models[1]!.minIntervalMs = 10000;
  const provider = new FakeProvider([answer('ok')]); const waits: number[] = [];
  const runner = new ModelRunner(config, provider, provider.models, f => { if (f.waitMs) waits.push(Number(f.waitMs)); });
  const input = { model: 'worker', messages: [], max_tokens: 2000, stream: false };
  await assert.rejects(runner.complete(input, new AbortController().signal, new UsageAccumulator(), { runId: 'large', role: 'worker' }), (e: any) => e.status === 400 && e.code === 'run_budget_exceeded');
  await runner.complete({ ...input, max_tokens: 10 }, new AbortController().signal, new UsageAccumulator(), { runId: 'small', role: 'worker' });
  assert.deepEqual(waits, []);
});

test('SPEC-001-QUEUE: cancelling a middle waiter does not leave a pacing gap', async () => {
  const config = configuration(); config.models[1]!.minIntervalMs = 30;
  const provider = new FakeProvider([answer('one'), answer('two'), answer('three')]); const waits: number[] = [];
  const runner = new ModelRunner(config, provider, provider.models, fields => { if (fields.waitMs) waits.push(Number(fields.waitMs)); });
  const invoke = (signal = new AbortController().signal) => runner.complete({ model: 'worker', messages: [], max_tokens: 20, stream: false }, signal, new UsageAccumulator(), { runId: 'queue', role: 'worker' });
  await invoke(); const next = invoke(); const controller = new AbortController(); const cancelled = invoke(controller.signal); const last = invoke(); controller.abort();
  await assert.rejects(cancelled); await Promise.all([next, last]);
  assert.equal(provider.calls.length, 3); assert.ok(waits.every(wait => wait <= 30));
});
