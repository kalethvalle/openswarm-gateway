import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../src/registry.js';
import { configSchema } from '../src/config.js';
import { FakeProvider, answer } from './helpers.js';
import { v2config } from './v2-helpers.js';
import { GatewayError } from '../src/errors.js';

test('SPEC-002-DEGRADED: fallback must retain the active specialty and tolerate a refreshed catalog', async () => {
  const { ModelRunner, UsageAccumulator } = await import('../src/runner.js');
  for (const catalogChanges of [false, true]) {
    const config = v2config();
    config.models[2]!.specialties = ['general'];
    const provider = new FakeProvider([async () => {
      if (catalogChanges) provider.models = [];
      throw new GatewayError(503, 'provider_error', 'unavailable', true);
    }]);
    const adapter = Object.assign(provider, { availableModels: () => provider.models });
    const runner = new ModelRunner(config, adapter, provider.models);
    await assert.rejects(runner.complete({ model: 'worker', messages: [], stream: false, max_tokens: 20 }, new AbortController().signal, new UsageAccumulator(), { runId: 'specialty', role: catalogChanges ? 'general' : 'coding' }), (error: any) => error instanceof GatewayError && error.status === 503);
    assert.deepEqual(provider.calls.map(c => c.model), ['worker']);
  }
});

test('SPEC-002-REGISTRY: aliases resolve remote IDs and preserve model metadata', async t => {
  const config = v2config(); config.models[1]!.remoteId = 'remote-worker';
  const adapter = new FakeProvider([answer('ok')]); adapter.models[1]!.id = 'remote-worker';
  const registry = new ProviderRegistry(config, () => {}, { free: adapter }); t.after(() => registry.close());
  assert.ok((await registry.catalog(new AbortController().signal)).some(m => m.id === 'worker' && m.remoteId === 'remote-worker'));
  await registry.complete({ model: 'worker', messages: [], stream: false, max_tokens: 10 }, new AbortController().signal);
  assert.equal(adapter.calls[0]!.model, 'remote-worker');
});
test('SPEC-002-FREE: reject paid/unknown OpenRouter models and undeclared Groq account', async t => {
  const config = v2config(); config.providers.free!.type = 'openrouter';
  config.models.forEach(m => { m.remoteId = m.id + ':free'; });
  const adapter = new FakeProvider([]); adapter.models.forEach(m => { m.id += ':free'; });
  adapter.models[0]!.free = true; adapter.models[1]!.free = false;
  const registry = new ProviderRegistry(config, () => {}, { free: adapter }); t.after(() => registry.close());
  assert.deepEqual((await registry.catalog(new AbortController().signal)).map(m => m.id), ['planner']);
  config.models[0]!.remoteId = 'paid'; assert.throws(() => configSchema.parse(config));
  const groq = v2config(); groq.providers.free!.freeAccount = false; assert.throws(() => configSchema.parse(groq));
});
test('SPEC-002-DEGRADED: catalog outage isolates a provider and refresh recovers', async t => {
  const config = v2config(); config.providers.second = { ...config.providers.free! };
  config.models[2]!.provider = 'second';
  const primary = new FakeProvider([]); const secondary = new FakeProvider([]);
  let down = true; secondary.catalog = async () => { if (down) throw new Error('down'); return secondary.models; };
  const registry = new ProviderRegistry(config, () => {}, { free: primary, second: secondary }); t.after(() => registry.close());
  assert.deepEqual((await registry.catalog(new AbortController().signal)).map(m => m.id), ['planner', 'worker']);
  down = false; assert.equal((await registry.catalog(new AbortController().signal)).length, 3);
});

test('SPEC-002-REGISTRY: local serial-tool enforcement does not exclude OpenRouter catalogs', async () => {
  const { ModelRunner, UsageAccumulator } = await import('../src/runner.js');
  const config = v2config();
  const adapter = new FakeProvider([answer('ok')]); adapter.models.forEach(m => { m.supportedParameters = m.supportedParameters.filter(p => p !== 'parallel_tool_calls'); });
  const runner = new ModelRunner(config, adapter, adapter.models);
  const input = { model: 'worker', messages: [], stream: false, max_tokens: 20, parallel_tool_calls: false };
  assert.equal(runner.supports('worker', input), true);
  assert.equal(runner.supports('worker', { ...input, parallel_tool_calls: true }), false);
  await runner.complete(input, new AbortController().signal, new UsageAccumulator(), { runId: 'serial', role: 'general' });
  assert.equal(adapter.calls[0]!.parallel_tool_calls, undefined);
});
