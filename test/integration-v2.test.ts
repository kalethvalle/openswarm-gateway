import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, answer, planned, base, headers, tools, toolAnswer, continueWith } from './helpers.js';
import { v2config, localDecisions } from './v2-helpers.js';
import { GatewayError } from '../src/errors.js';
import { CONSULT } from '../src/collaboration.js';

test('SPEC-006-MIGRATION SPEC-006-TOOLS: a paused specialist resumes after restart and returns to its owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'specialist-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = v2config(); const path = join(directory, 'state.sqlite');
  const consult = answer('', { finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
    id: 'private-consult', type: 'function', function: { name: CONSULT, arguments: JSON.stringify({ specialty: 'review', question: 'Check source correctness', refs: ['a0'] }) },
  }] } });
  const first = await fixture([consult, toolAnswer()], { path, config, laya: localDecisions(config) });
  const original = { ...base, tools };
  const response = (await first.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'lookup');
  await first.app.close();
  const second = await fixture([answer('review with evidence'), answer('integrated after restart')], { path, config, laya: localDecisions(config) });
  t.after(() => second.app.close());
  const final = await second.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, response, 'verified source') });
  assert.equal(final.statusCode, 200);
  assert.equal(final.json().choices[0].message.content, 'integrated after restart');
  assert.deepEqual(second.provider.calls.map(c => c.model), ['backup', 'worker']);
  assert.match(JSON.stringify(second.provider.calls[0]!.messages), /verified source/);
  assert.match(JSON.stringify(second.provider.calls[1]!.messages), /review with evidence/);
  assert.doesNotMatch(final.body, /private-consult|__openswarm/);
});

test('SPEC-006-TOOLS: v2 tool continuations replay and keep client constraints', async t => {
  const config = v2config(); const original = { ...base, tools };
  const { app, provider } = await fixture([toolAnswer(), answer('done')], { config, laya: localDecisions(config) }); t.after(() => app.close());
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  const next = continueWith(original, first); const final = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next })).json();
  assert.equal(final.choices[0].message.content, 'done');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: next })).json(), final);
  assert.equal(provider.calls.length, 2);
  const reserved = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, tools: [{ type: 'function', function: { name: '__openswarm_consult' } }] } });
  assert.equal(reserved.statusCode, 400);
});
test('SPEC-006-MIGRATION: v1 and v2 tool rounds survive a SQLite restart under v2 config', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v2-resume-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const legacy of [false, true]) {
    const config = v2config(); const path = join(directory, String(legacy) + '.sqlite');
    const first = legacy ? await fixture([planned(), toolAnswer()], { path }) : await fixture([toolAnswer()], { path, config, laya: localDecisions(config) });
    const original = { ...base, tools };
    const response = (await first.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json(); await first.app.close();
    const second = await fixture([answer('resumed')], { path, config, laya: localDecisions(config) }); t.after(() => second.app.close());
    assert.equal((await second.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, response) })).json().choices[0].message.content, 'resumed');
  }
});
test('SPEC-006-PORTABLE: fallback after complete client round uses evidence without opaque state', async t => {
  const config = v2config(); const limited = new GatewayError(429, 'provider_error', 'limited', true); limited.upstreamStatus = 429;
  const { app, provider } = await fixture([toolAnswer(), limited, answer('continued')], { config, laya: localDecisions(config) }); t.after(() => app.close());
  const original = { ...base, tools };
  const first = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: original })).json();
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continueWith(original, first) });
  assert.equal(response.statusCode, 200); assert.equal(provider.calls[2]!.model, 'backup');
  assert.doesNotMatch(JSON.stringify(provider.calls[2]!.messages), /opaque-state/);
  assert.equal(provider.calls[2]!.messages.some(m => m.role === 'tool' || m.tool_calls), false);
  assert.match(JSON.stringify(provider.calls[2]!.messages), /tool-result/);
});
test('SPEC-006-LIVE: simulated API accepts full text parts and OpenClaw tool reserialization', async t => {
  const config = v2config();
  const { app } = await fixture([answer('Hola')], { config, laya: localDecisions(config, 'general') }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'openswarm-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }] } });
  assert.equal(response.statusCode, 200); // Real CLI evidence is recorded separately, never inferred from this contract test.
});
