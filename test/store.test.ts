import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/store.js';
import { validateRequest } from '../src/validation.js';
import { base, tools } from './helpers.js';
import type { ChatRequest, Completion, Message } from '../src/types.js';
import { GatewayError } from '../src/errors.js';

const legacyId = `call_${'a'.repeat(32)}`;
const aliasId = legacyId.replace('_', '');

function waiting(store: RunStore, ids = [legacyId], initial = validateRequest({ ...base, tools })) {
  const prepared = store.prepare(initial);
  assert.ok('state' in prepared);
  const message: Message = { role: 'assistant', content: null, tool_calls: ids.map((id, i) => ({
    id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ query: `test-${i}` }) },
  })) };
  prepared.state.pending = ids.map((publicId, i) => ({ publicId, providerId: `provider-${i}` }));
  prepared.state.agentMessages = [{ ...message, tool_calls: message.tool_calls!.map((call, i) => ({ ...call, id: `provider-${i}` })) }];
  prepared.state.expectedMessages = [...initial.messages, message];
  const response: Completion = { id: 'test', created: 1, object: 'chat.completion', model: 'openswarm-auto', choices: [{ index: 0, message, finish_reason: 'tool_calls' }] };
  store.finish(prepared.state, prepared.requestId, response);
  return validateRequest({ ...initial, messages: [...initial.messages, message, ...ids.map(id => ({ role: 'tool', tool_call_id: id, content: 'result' }))] });
}

function sanitized(request: ChatRequest): ChatRequest {
  const next = structuredClone(request);
  for (const message of next.messages) {
    if (message.tool_call_id) message.tool_call_id = message.tool_call_id.replace(/[^a-zA-Z0-9]/g, '');
    for (const call of message.tool_calls ?? []) call.id = call.id.replace(/[^a-zA-Z0-9]/g, '');
  }
  return validateRequest(next);
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof GatewayError && error.code === code;
}

for (const aliasFirst of [false, true]) {
  test(`legacy IDs and OpenClaw aliases share a continuation and replay (alias first: ${aliasFirst})`, t => {
    const store = new RunStore(':memory:', 86_400_000); t.after(() => store.close());
    const original = waiting(store);
    const alias = sanitized(original);
    const next = store.prepare(aliasFirst ? alias : original);
    assert.ok('state' in next);
    assert.equal(next.state.agentMessages!.at(-1)!.tool_call_id, 'provider-0');
    assert.deepEqual(next.state.expectedMessages, original.messages);
    assert.equal(alias.messages.at(-1)!.tool_call_id, aliasId, 'input must not be mutated');
    assert.throws(() => store.prepare(aliasFirst ? original : alias), hasCode('continuation_in_progress'));
    const response: Completion = { id: 'done', created: 1, object: 'chat.completion', model: 'openswarm-auto', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };
    store.finish(next.state, next.requestId, response);
    assert.deepEqual(store.prepare({ ...alias, stream: true }), { replay: response });
    assert.deepEqual(store.prepare(original), { replay: response });
    const changed = structuredClone(alias); changed.messages.at(-1)!.content = 'different';
    assert.throws(() => store.prepare(changed), hasCode('continuation_conflict'));
  });
}

test('legacy aliases preserve history and tool validation', t => {
  const store = new RunStore(':memory:', 86_400_000); t.after(() => store.close());
  const alias = sanitized(waiting(store));
  for (const change of ['text', 'arguments', 'tools']) {
    const next = structuredClone(alias);
    if (change === 'text') next.messages[0]!.content = 'changed';
    if (change === 'arguments') next.messages.at(-2)!.tool_calls![0]!.function.arguments = '{}';
    if (change === 'tools') next.tools![0]!.function.description = 'changed';
    assert.throws(() => store.prepare(next), hasCode('conversation_mismatch'));
  }
  assert.ok('state' in store.prepare(alias));
});

test('unknown, ambiguous, mixed, duplicate, partial and stale aliases stay rejected', t => {
  const store = new RunStore(':memory:', 86_400_000); t.after(() => store.close());
  const original = waiting(store);
  const alias = sanitized(original);
  const unknown = structuredClone(alias);
  unknown.messages.at(-2)!.tool_calls![0]!.id = `call-${'a'.repeat(32)}`;
  unknown.messages.at(-1)!.tool_call_id = `call-${'a'.repeat(32)}`;
  assert.throws(() => store.prepare(unknown), hasCode('unknown_tool_call'));
  const other = waiting(store, [`call_${'b'.repeat(32)}`]);
  const mixed = structuredClone(alias);
  mixed.messages.at(-2)!.tool_calls!.push(...sanitized(other).messages.at(-2)!.tool_calls!);
  mixed.messages.push(sanitized(other).messages.at(-1)!);
  assert.throws(() => store.prepare(validateRequest(mixed)), hasCode('unknown_tool_call'));
  const duplicate = structuredClone(original);
  duplicate.messages.at(-2)!.tool_calls!.push(...alias.messages.at(-2)!.tool_calls!);
  duplicate.messages.push(alias.messages.at(-1)!);
  assert.throws(() => store.prepare(validateRequest(duplicate)), hasCode('missing_tool_results'));
  const parallel = sanitized(waiting(store, [`call_${'c'.repeat(32)}`, `call_${'d'.repeat(32)}`]));
  const partial = structuredClone(parallel);
  partial.messages.splice(-1, 1); partial.messages.at(-2)!.tool_calls!.pop();
  assert.throws(() => store.prepare(validateRequest(partial)), hasCode('missing_tool_results'));
  assert.ok('state' in store.prepare(parallel));
  waiting(store, [aliasId]); // An exact ID and a legacy alias must never select one arbitrarily.
  assert.throws(() => store.prepare(alias), hasCode('unknown_tool_call'));
  store.cleanup(Date.now() + 2 * 86_400_000);
  assert.throws(() => store.prepare(original), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'unknown_tool_call');
    assert.doesNotMatch(error.message, /expired|auth|api.?key/i);
    return true;
  });
});

test('previous legacy rounds are normalized when resuming new IDs', t => {
  const store = new RunStore(':memory:', 86_400_000); t.after(() => store.close());
  const original = waiting(store);
  const next = store.prepare(sanitized(original)); assert.ok('state' in next);
  const newId = `call${'e'.repeat(32)}`;
  const message: Message = { role: 'assistant', content: null, tool_calls: [{ id: newId, type: 'function', function: { name: 'lookup', arguments: '{"query":"next"}' } }] };
  next.state.pending = [{ publicId: newId, providerId: 'provider-next' }];
  next.state.expectedMessages.push(message);
  store.finish(next.state, next.requestId, { id: 'next', created: 1, object: 'chat.completion', model: 'openswarm-auto', choices: [{ index: 0, message, finish_reason: 'tool_calls' }] });
  const request = validateRequest({ ...original, messages: [...original.messages, message, { role: 'tool', tool_call_id: newId, content: 'next result' }] });
  const resumed = store.prepare(sanitized(request)); assert.ok('state' in resumed);
  assert.deepEqual(resumed.state.expectedMessages, request.messages);
  assert.equal(resumed.state.agentMessages!.at(-1)!.tool_call_id, 'provider-next');
});

test('legacy aliases resume from disk and interrupted alias retries stay blocked after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openswarm-legacy-'));
  const path = join(directory, 'state.sqlite');
  let store = new RunStore(path, 86_400_000);
  try {
    const original = waiting(store);
    store.close(); store = new RunStore(path, 86_400_000);
    const resumed = store.prepare(sanitized(original));
    assert.ok('state' in resumed);
    assert.equal(resumed.state.agentMessages!.at(-1)!.tool_call_id, 'provider-0');
    store.close(); store = new RunStore(path, 86_400_000);
    assert.throws(() => store.prepare(original), hasCode('execution_interrupted'));
    assert.throws(() => store.prepare(sanitized(original)), hasCode('execution_interrupted'));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('startup marks in-flight continuations interrupted and never retries them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openswarm-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new RunStore(path, 86_400_000);
  try {
    const initial = validateRequest({ ...base, tools });
    const prepared = store.prepare(initial);
    assert.ok('state' in prepared);
    const message = { role: 'assistant' as const, content: null, tool_calls: [{ id: 'public-call', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } }] };
    prepared.state.pending = [{ publicId: 'public-call', providerId: 'provider-call' }];
    prepared.state.agentMessages = [{ ...message, tool_calls: [{ ...message.tool_calls[0]!, id: 'provider-call' }] }];
    prepared.state.expectedMessages = [...initial.messages, message];
    const response: Completion = { id: 'test', created: 1, object: 'chat.completion', model: 'openswarm-auto', choices: [{ index: 0, message, finish_reason: 'tool_calls' }] };
    store.finish(prepared.state, prepared.requestId, response);
    const next = validateRequest({ ...initial, messages: [...initial.messages, message, { role: 'tool', tool_call_id: 'public-call', content: 'result' }] });
    store.prepare(next);
    store.close(); store = new RunStore(path, 86_400_000);
    assert.throws(() => store.prepare(next), /interrupted/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
