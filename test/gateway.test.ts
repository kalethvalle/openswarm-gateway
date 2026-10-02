import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { GatewayError } from '../src/errors.js';
import { fixture, planned, answer, base, headers, tools, toolAnswer, continueWith, configuration, FakeProvider, plan } from './helpers.js';

test('JSON completion runs a dynamic team, hides artifacts, aggregates usage', async t => {
  const { app, provider } = await fixture([planned(3), answer('private design'), answer('private review'), answer('Final answer')]);
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, 'Final answer');
  assert.equal(response.json().usage.total_tokens, 60);
  assert.equal(provider.calls.length, 4);
  assert.match(JSON.stringify(provider.calls[3]?.messages), /private design/);
  assert.doesNotMatch(response.body, /private design|private review/);
});

test('auth, health and model discovery', async t => {
  const { app } = await fixture([]); t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await app.inject('/readyz')).statusCode, 200);
  assert.equal((await app.inject('/v1/models')).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/models', headers })).json().data[0].id, 'openswarm-auto');
});

test('unsupported requests fail before calling any model', async t => {
  const { app, provider } = await fixture([]); t.after(() => app.close());
  const invalid = [ { ...base, model: 'arbitrary' }, { ...base, n: 2 }, { ...base, response_format: { type: 'json_object' } },
    { ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'example' } }] }] },
    { ...base, tools, tool_choice: { type: 'function', function: { name: 'missing' } } },
    { ...base, max_tokens: 1, max_completion_tokens: 2 }, { ...base, stream_options: { include_usage: true } } ];
  for (const payload of invalid) assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload })).statusCode, 400);
  assert.equal(provider.calls.length, 0);
});

test('planner repairs one invalid plan without invoking unauthorized models', async t => {
  const invalid = plan(); invalid.steps[0]!.model = 'unauthorized';
  const { app, provider } = await fixture([answer(JSON.stringify(invalid)), planned(), answer('fixed')]); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(provider.calls.map(c => c.model), ['planner', 'planner', 'worker']);
});

test('planner stops after one failed repair', async t => {
  const { app, provider } = await fixture([answer('invalid'), answer('invalid')]); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.json().error.code, 'invalid_plan'); assert.equal(provider.calls.length, 2);
});

test('tools pause any stage; private state stays with its model and results reach later agents', async t => {
  const { app, provider } = await fixture([planned(2), toolAnswer(2), answer('working artifact'), toolAnswer(), answer('done')]); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(first.choices[0].message.reasoning_details, undefined);
  assert.notEqual(first.choices[0].message.tool_calls[0].id, 'upstream-0');
  for (const call of first.choices[0].message.tool_calls) assert.match(call.id, /^call[0-9a-f]{32}$/);
  const secondRequest = continueWith(original, first);
  const second = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: secondRequest })).json();
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  assert.match(JSON.stringify(provider.calls[2]?.messages), /opaque-state/);
  assert.doesNotMatch(JSON.stringify(provider.calls[3]?.messages), /opaque-state/);
  assert.match(JSON.stringify(provider.calls[3]?.messages), /tool-result/);
  assert.equal(provider.calls[2]?.messages.at(-1)?.tool_call_id, 'upstream-1');
  const finalRequest = continueWith(secondRequest, second);
  const final = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: finalRequest });
  assert.equal(final.json().choices[0].message.content, 'done');
  const replay = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: finalRequest });
  assert.deepEqual(replay.json(), final.json());
  assert.equal(provider.calls.filter(c => c.model === 'planner').length, 1);
  assert.equal(provider.calls.length, 5);
  const changed = structuredClone(finalRequest); changed.messages.at(-1)!.content = 'different';
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: changed })).statusCode, 409);
});

test('tool continuations survive process restart with SQLite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'openswarm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = await fixture([planned(), toolAnswer()], { path });
  const original = { ...base, tools };
  const response = (await first.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  await first.app.close();
  const second = await fixture([answer('resumed')], { path }); t.after(() => second.app.close());
  const resumed = await second.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, response) });
  assert.equal(resumed.json().choices[0].message.content, 'resumed');
  assert.equal(second.provider.calls.length, 1);
});

test('OpenClaw can reserialize tool JSON without changing its arguments', async t => {
  const call = toolAnswer();
  call.message.tool_calls![0]!.function.arguments = '{\n  "limit": 1, "query": "test"\n}';
  const { app, provider } = await fixture([planned(), call, answer('resumed')]); t.after(() => app.close());
  const original = { ...base, tools: [{ ...tools[0]!, function: { ...tools[0]!.function, parameters: { ...tools[0]!.function.parameters, properties: { query: { type: 'string' }, limit: { type: 'integer' } } } } }] };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const next = continueWith(original, first);
  const assistant = next.messages.find((m: any) => m.tool_calls);
  assistant.content = '';
  assistant.tool_calls[0].function.arguments = '{"query":"test","limit":1}';
  const changed = structuredClone(next);
  changed.messages.find((m: any) => m.tool_calls).tool_calls[0].function.arguments = '{"query":"modified","limit":1}';
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: changed })).statusCode, 409);
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next });
  assert.equal(response.json().choices[0].message.content, 'resumed');
  assistant.content = null;
  assistant.tool_calls[0].function.arguments = '{ "query" : "test", "limit": 1 }';
  const replay = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next });
  assert.deepEqual(replay.json(), response.json());
  assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[2]!.messages.find(m => m.tool_calls)?.tool_calls?.[0]?.function.arguments, call.message.tool_calls![0]!.function.arguments);
});

test('missing results, changed tools, and unknown calls are rejected', async t => {
  const { app, provider } = await fixture([planned(), toolAnswer(2), answer('done')]); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const next = continueWith(original, first);
  const missing = { ...next, messages: next.messages.slice(0, -1) };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: missing })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...next, tools: undefined } })).statusCode, 409);
  const unknown = { ...base, tools, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'unknown', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'unknown', content: 'x' }] };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: unknown })).json().error.code, 'unknown_tool_call');
  assert.equal(provider.calls.length, 2);
});

test('simultaneous continuations invoke the model once', async t => {
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const { app, provider } = await fixture([planned(), toolAnswer(), async () => { started(); await waiting; return answer('once'); }]); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const next = continueWith(original, first);
  const pending = app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next }).then(r => r);
  await running;
  const duplicate = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next });
  assert.equal(duplicate.statusCode, 409); release();
  assert.equal((await pending).statusCode, 200); assert.equal(provider.calls.length, 3);
});

test('fallback happens only before publication; usage is omitted after an unmeasured failure', async t => {
  const { app, provider } = await fixture([planned(), new GatewayError(429, 'provider_error', 'limited', true), answer('fallback')]); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 200); assert.equal(response.json().usage, undefined);
  assert.deepEqual(provider.calls.map(c => c.model), ['planner', 'worker', 'backup']);
});

test('stream errors after text never retry or emit a success terminator', async t => {
  const { app, provider } = await fixture([planned(), async (_input, _signal, text) => { await text!('partial'); throw new GatewayError(502, 'provider_error', 'failed', true); }]); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, stream: true } });
  assert.equal(response.statusCode, 200); assert.match(response.body, /partial/); assert.match(response.body, /"error"/);
  assert.doesNotMatch(response.body, /\[DONE\]/); assert.equal(provider.calls.length, 2);
});

test('no fallback after tool calls have been delivered', async t => {
  const { app, provider } = await fixture([planned(), toolAnswer(), new GatewayError(502, 'provider_error', 'failed', true)]); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, first) })).statusCode, 502);
  assert.equal(provider.calls.length, 3);
});

test('SSE and tool deltas are consumable by the official OpenAI SDK', async t => {
  const { app, provider } = await fixture([planned(2), answer('hidden'), answer('hello'), planned(), toolAnswer(), answer('tool done')]); t.after(() => app.close());
  const client = new OpenAI({ apiKey: 'test-key', baseURL: 'http://gateway/v1', maxRetries: 0, fetch: async (url, init) => {
    const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), payload: init?.body as string });
    return new Response(response.body, { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, String(v)])) });
  } });
  const stream = await client.chat.completions.create({ model: 'openswarm-auto', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true } });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), 'hello');
  assert.equal(chunks.at(-1)?.usage?.total_tokens, 45);
  assert.deepEqual(chunks.at(-1)?.choices, []);
  const toolStream = await client.chat.completions.create({ model: 'openswarm-auto', messages: [{ role: 'user', content: 'use tool' }], tools, stream: true });
  const toolChunks = []; for await (const chunk of toolStream) toolChunks.push(chunk);
  const call = toolChunks.flatMap(c => c.choices[0]?.delta.tool_calls ?? [])[0]!;
  assert.match(call.id!, /^call[0-9a-f]{32}$/);
  assert.equal(call.function?.name, 'lookup'); assert.equal(call.function?.arguments, '{"query":"test"}');
  const completed = await client.chat.completions.create({ model: 'openswarm-auto', tools, messages: [
    { role: 'user', content: 'use tool' }, { role: 'assistant', content: null, tool_calls: [{ id: call.id!, type: 'function', function: { name: call.function!.name!, arguments: call.function!.arguments! } }] },
    { role: 'tool', tool_call_id: call.id!, content: 'result' },
  ] });
  assert.equal(completed.choices[0]?.message.content, 'tool done'); assert.equal(provider.calls.length, 6);
});

test('unsupported capabilities are filtered before model selection', async t => {
  const provider = new FakeProvider([planned(), answer('ok')]);
  provider.models.forEach(m => { m.supportedParameters = ['max_tokens']; });
  const { app } = await fixture([], { provider }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools } });
  assert.equal(response.json().error.code, 'unsupported_parameters'); assert.equal(provider.calls.length, 0);
});

test('tool round and conservative context limits are enforced', async t => {
  const { app } = await fixture([planned(), toolAnswer(), toolAnswer()], { config: configuration({ maxToolRounds: 1 }) }); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const next = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, first) });
  assert.equal(next.json().error.code, 'tool_round_limit');
  const provider = new FakeProvider([]); provider.models.forEach(m => { m.contextLength = 100; });
  const small = await fixture([], { provider }); t.after(() => small.app.close());
  const tooLarge = await small.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(tooLarge.json().error.code, 'context_length_exceeded'); assert.equal(provider.calls.length, 0);
});

test('expired tool continuations are not restarted', async t => {
  const { app, store, provider } = await fixture([planned(), toolAnswer()]); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  store.cleanup(Date.now() + 2 * 86_400_000);
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, first) });
  assert.equal(response.json().error.code, 'unknown_tool_call'); assert.equal(provider.calls.length, 2);
});

test('deadline cancels in-flight providers', async t => {
  let cancelled = false;
  const { app } = await fixture([async (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
  })], { config: configuration({ requestTimeoutMs: 30 }) }); t.after(() => app.close());
  const keepAlive = setInterval(() => {}, 100); t.after(() => clearInterval(keepAlive));
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 504); assert.equal(cancelled, true);
});

test('invalid tool schemas fail before inference and invalid arguments are not delivered', async t => {
  const invalidArgs = toolAnswer(); invalidArgs.message.tool_calls![0]!.function.arguments = '{"query":5}';
  const { app, provider } = await fixture([planned(), invalidArgs]); t.after(() => app.close());
  const invalidSchema = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'not-a-json-schema-type' } } }];
  const schemaResponse = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools: invalidSchema } });
  assert.equal(schemaResponse.json().error.code, 'invalid_tool_schema'); assert.equal(provider.calls.length, 0);
  const argsResponse = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools } });
  assert.equal(argsResponse.json().error.code, 'invalid_tool_arguments'); assert.doesNotMatch(argsResponse.body, /call_?[0-9a-f]{32}/);
});

test('tool constraints reject forbidden, forced-missing, and disallowed parallel calls', async t => {
  const { app } = await fixture([planned(), toolAnswer(), planned(), answer('ignores required tool'), planned(), toolAnswer(2)]); t.after(() => app.close());
  for (const options of [{ tool_choice: 'none' }, { tool_choice: 'required' }, { parallel_tool_calls: false }]) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools, ...options } });
    assert.equal(response.statusCode, 502);
  }
});

test('tool IDs are not emitted when persistence fails', async t => {
  const { app, store } = await fixture([planned(), toolAnswer()]); t.after(() => app.close());
  store.finish = () => { throw new Error('disk failure'); };
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools, stream: true } });
  assert.equal(response.statusCode, 500); assert.doesNotMatch(response.body, /call_?[0-9a-f]{32}|upstream-/);
});

test('real HTTP streams before model completion and disconnect aborts the upstream', async t => {
  let aborted!: () => void;
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const { app } = await fixture([planned(), async (_input, signal, onText) => {
    await onText!('visible-before-completion');
    return new Promise((_resolve, reject) => {
      const stop = () => { aborted(); reject(signal.reason); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }]); t.after(() => app.close());
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/chat/completions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...base, stream: true }), signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let received = '';
  while (!received.includes('visible-before-completion')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false);
    received += new TextDecoder().decode(chunk.value);
  }
  controller.abort(); await reader.cancel().catch(() => {});
  await Promise.race([cancelled, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 2000); timer.unref(); })]);
});
