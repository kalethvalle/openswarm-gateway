import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterAdapter } from '../src/provider.js';
import { ModelRunner, UsageAccumulator } from '../src/runner.js';
import { GatewayError } from '../src/errors.js';
import type { ProviderInput } from '../src/types.js';
import { configuration, FakeProvider, answer, usage } from './helpers.js';

const input: ProviderInput = { model: 'worker', messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, stream: true };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function streamResponse(text: string) {
  const encoded = new TextEncoder().encode(text);
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index === encoded.length) { controller.close(); return; }
    // Split Unicode, CRLF boundaries, and JSON tokens across reads.
    controller.enqueue(encoded.slice(index, index + 3)); index = Math.min(index + 3, encoded.length);
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('provider parses fragmented SSE, comments, Unicode and duplicate terminal usage', async () => {
  let posted: any;
  const body = ': heartbeat\r\n\r\n' + event({ model: 'worker', choices: [{ delta: { content: '¡Hola!' } }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\r\n\r\n';
  const provider = new OpenRouterAdapter('secret', 'http://mock', async (_url, init) => { posted = JSON.parse(String(init?.body)); return streamResponse(body); });
  let text = '';
  const result = await provider.complete(input, new AbortController().signal, async value => { text += value; });
  assert.equal(text, '¡Hola!'); assert.equal(result.message.content, text); assert.deepEqual(result.usage, usage);
  assert.equal(posted.provider.require_parameters, true); assert.deepEqual(posted.transforms, []);
});

test('provider assembles function arguments and opaque reasoning state', async () => {
  const body = event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'up-1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }], reasoning_details: [{ index: 0, type: 'reasoning.encrypted', data: 'abc' }] } }] }) +
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"value"}' } }], reasoning_details: [{ index: 0, data: 'def' }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\r\n\r\n';
  const provider = new OpenRouterAdapter('key', 'http://mock', async () => streamResponse(body));
  const result = await provider.complete(input, new AbortController().signal);
  assert.deepEqual(result.message.tool_calls, [{ id: 'up-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"value"}' } }]);
  assert.deepEqual(result.message.reasoning_details, [{ index: 0, type: 'reasoning.encrypted', data: 'abcdef' }]);
});

test('provider does not silently accept truncated or malformed streams', async () => {
  const broken = [ event({ choices: [{ delta: { content: 'partial' } }] }), 'data: invalid\n\n', 'data: [DONE]\n\n' ];
  for (const body of broken) {
    const provider = new OpenRouterAdapter('key', 'http://mock', async () => streamResponse(body));
    await assert.rejects(provider.complete(input, new AbortController().signal), (e: unknown) => e instanceof GatewayError && e.code === 'invalid_provider_response');
  }
});

test('provider maps HTTP and SSE failures without leaking upstream bodies or keys', async () => {
  const http = new OpenRouterAdapter('secret', 'http://mock', async () => new Response('sensitive upstream body', { status: 429 }));
  await assert.rejects(http.complete(input, new AbortController().signal), (e: unknown) => e instanceof GatewayError && e.status === 429 && e.retryable && !e.message.includes('sensitive'));
  const sse = new OpenRouterAdapter('secret', 'http://mock', async () => streamResponse(event({ error: { code: 503, message: 'sensitive upstream body' } })));
  await assert.rejects(sse.complete(input, new AbortController().signal), (e: unknown) => e instanceof GatewayError && e.retryable && !e.message.includes('sensitive'));
});

test('catalog validates metadata and drops malformed entries', async () => {
  const provider = new OpenRouterAdapter('key', 'http://mock', async () => Response.json({ data: [ { id: 'worker', context_length: 4096, supported_parameters: ['tools'] }, { id: 'bad' } ] }));
  assert.deepEqual(await provider.catalog(new AbortController().signal), [{ id: 'worker', contextLength: 4096, supportedParameters: ['tools'] }]);
});

test('request cancellation propagates to transport', async () => {
  const controller = new AbortController();
  const provider = new OpenRouterAdapter('key', 'http://mock', async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
  }));
  const pending = provider.complete(input, controller.signal);
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortError');
});

test('model timeout falls back within the parent deadline', async () => {
  const provider = new FakeProvider([async (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), answer('fallback')]);
  const runner = new ModelRunner(configuration({ modelTimeoutMs: 20 }), provider, provider.models);
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await runner.complete({ ...input, stream: false }, new AbortController().signal, new UsageAccumulator(), { runId: 'test', role: 'test' });
    assert.equal(result.selectedModel, 'backup'); assert.equal(provider.calls.length, 2);
  } finally { clearInterval(keepAlive); }
});

test('missing usage is not replaced with fabricated token counts', () => {
  const total = new UsageAccumulator(); total.add(usage); total.add(undefined);
  assert.equal(total.value(), undefined);
});

test('network interruptions while reading a response remain retryable', async () => {
  for (const stream of [false, true]) {
    const provider = new OpenRouterAdapter('key', 'http://mock', async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection reset')); } })));
    await assert.rejects(provider.complete({ ...input, stream }, new AbortController().signal), (e: unknown) => e instanceof GatewayError && e.code === 'provider_connection_error' && e.retryable);
  }
});
