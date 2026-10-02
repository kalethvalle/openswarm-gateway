import test from 'node:test';
import assert from 'node:assert/strict';
import { GroqAdapter } from '../src/groq.js';
import { ModelRunner, UsageAccumulator } from '../src/runner.js';
import { GatewayError } from '../src/errors.js';
import { configuration, FakeProvider, fixture, planned, answer, base, headers } from './helpers.js';
import type { ProviderInput } from '../src/types.js';

test('Groq admits generation models and excludes moderation even with tool metadata', async () => {
  const provider = new GroqAdapter('key', 'http://mock', async () => Response.json({ data: [
    ...['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-safeguard-20b', 'whisper-large-v3'].map(id => ({ id, context_window: 131072, active: true })),
  ] }));
  const models = await provider.catalog(new AbortController().signal);
  assert.deepEqual(models.map(m => m.id), ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
});
test('Groq maps generation parameters and reports SSE usage', async () => {
  let payload: any;
  const provider = new GroqAdapter('key', 'http://mock', async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}\n\ndata: [DONE]\n\n');
  });
  const input: ProviderInput = { model: 'qwen/qwen3.8-27b', messages: [{ role: 'developer', content: 'instruction' }], max_tokens: 100, stream: true };
  const result = await provider.complete(input, new AbortController().signal);
  assert.equal(payload.reasoning_effort, 'none'); assert.equal(payload.max_completion_tokens, 100);
  assert.equal(payload.provider, undefined); assert.equal(payload.messages[0].role, 'system');
  assert.equal(result.usage?.total_tokens, 12);
});
test('429 Retry-After is propagated and subsequent attempts honor model cooldown', async () => {
  const adapter = new GroqAdapter('key', 'http://mock', async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  await assert.rejects(adapter.complete({ model: 'openai/gpt-oss-20b', messages: [], stream: false, max_tokens: 20 }, new AbortController().signal), (error: unknown) => error instanceof GatewayError && error.retryAfterSeconds === 120);
  const error = new GatewayError(429, 'provider_error', 'limited', true); error.retryAfterSeconds = 120;
  const config = configuration(); config.models[1]!.fallbacks = [];
  const provider = new FakeProvider([error]); const runner = new ModelRunner(config, provider, provider.models);
  const invoke = () => runner.complete({ model: 'worker', messages: [], stream: false, max_tokens: 20 }, new AbortController().signal, new UsageAccumulator(), { runId: 'run', role: 'worker' });
  await assert.rejects(invoke());
  await assert.rejects(invoke(), (error: unknown) => error instanceof GatewayError && error.code === 'provider_rate_limited' && error.retryAfterSeconds! > 0);
  assert.equal(provider.calls.length, 1);
});

test('Groq planning requests strict schema while generation keeps the chat contract', async t => {
  const config = configuration(); config.provider = 'groq';
  const provider = new FakeProvider([planned(), answer('done')]);
  for (const model of provider.models) model.supportedParameters.push('response_format');
  const { app } = await fixture([], { config, provider }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base })).statusCode, 200);
  assert.equal(provider.calls[0]!.response_format?.json_schema.strict, true);
  assert.equal(provider.calls[0]!.tools, undefined);
  assert.equal(provider.calls[1]!.response_format, undefined);
});

test('model pacing serializes dispatch slots and a cancelled wait consumes no call', async () => {
  const config = configuration(); config.models[1]!.minIntervalMs = 40;
  const starts: number[] = [];
  const waits: number[] = [];
  const provider = new FakeProvider([async () => { starts.push(Date.now()); return answer('one'); }, async () => { starts.push(Date.now()); return answer('two'); }, answer('three')]);
  const runner = new ModelRunner(config, provider, provider.models, fields => { if (typeof fields.waitMs === 'number') waits.push(fields.waitMs); });
  const input: ProviderInput = { model: 'worker', messages: [], stream: false, max_tokens: 20 };
  const invoke = (signal = new AbortController().signal) => runner.complete(input, signal, new UsageAccumulator(), { runId: 'pace', role: 'worker' });
  await Promise.all([invoke(), invoke()]);
  assert.ok(starts[1]! - starts[0]! >= 30);
  const controller = new AbortController();
  const cancelled = invoke(controller.signal); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(provider.calls.length, 2);
  await invoke();
  assert.ok(waits.at(-1)! <= 40);
  assert.equal(provider.calls.length, 3);
});

test('one bounded HTTP 429 retry preserves a locked model and releases only rejected tokens', async () => {
  const config = configuration({ rateLimitRetries: 1, maxRunTokens: 1200, maxModelCalls: 2 });
  const limited = new GatewayError(429, 'provider_error', 'limited', true);
  limited.upstreamStatus = 429; limited.retryAfterSeconds = 0;
  const provider = new FakeProvider([limited, answer('done')]);
  const runner = new ModelRunner(config, provider, provider.models);
  const budget = { calls: 0, tokens: 0 };
  await runner.complete({ model: 'worker', messages: [], stream: false, max_tokens: 20 }, new AbortController().signal, new UsageAccumulator(budget), { runId: 'retry', role: 'worker', locked: true });
  assert.deepEqual(provider.calls.map(call => call.model), ['worker', 'worker']);
  assert.deepEqual(budget, { calls: 2, tokens: 15 });
});

test('cancelling a rate-limit wait never issues another request', async () => {
  const config = configuration({ rateLimitRetries: 1 });
  const limited = new GatewayError(429, 'provider_error', 'limited', true);
  limited.upstreamStatus = 429; limited.retryAfterSeconds = 1;
  const provider = new FakeProvider([limited]);
  const controller = new AbortController();
  const runner = new ModelRunner(config, provider, provider.models, fields => { if (fields.retry) controller.abort(); });
  const budget = { calls: 0, tokens: 0 };
  await assert.rejects(runner.complete({ model: 'worker', messages: [], stream: false, max_tokens: 20 }, controller.signal, new UsageAccumulator(budget), { runId: 'retry', role: 'worker' }), { name: 'AbortError' });
  assert.equal(provider.calls.length, 1); assert.deepEqual(budget, { calls: 1, tokens: 0 });
});
