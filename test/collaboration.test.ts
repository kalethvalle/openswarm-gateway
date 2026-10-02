import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, answer, base, headers } from './helpers.js';
import { v2config, localDecisions } from './v2-helpers.js';
import { CONSULT, CONTEXT } from '../src/collaboration.js';
export function control(name = CONSULT, args: object = { specialty: 'review', question: 'Review correctness', refs: ['a0'] }, id = 'internal-1') {
  return answer('', { finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
}
test('SPEC-005-CONSULT SPEC-005-INTEGRATE: specialist returns to owner without exposing drafts', async t => {
  const config = v2config(); const laya = localDecisions(config);
  const { app, provider } = await fixture([control(), answer('private review'), answer('integrated result')], { config, laya }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, stream: true } });
  assert.equal(response.statusCode, 200); assert.match(response.body, /integrated result/); assert.doesNotMatch(response.body, /private review|__openswarm_consult|internal-1/);
  assert.deepEqual(provider.calls.map(c => c.model), ['worker', 'backup', 'worker']);
  assert.match(JSON.stringify(provider.calls[2]!.messages), /private review/);
});
test('SPEC-005-CONTEXT: original instructions stay and extra sources can be read by ID', async t => {
  const config = v2config(); const laya = localDecisions(config);
  const { app, provider } = await fixture([control(CONTEXT, { refs: ['a0'] }), answer('done')], { config, laya }); t.after(() => app.close());
  const request = { ...base, messages: [{ role: 'system', content: 'Never change production.' }, ...base.messages] };
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: request });
  assert.equal(response.statusCode, 200); assert.match(JSON.stringify(provider.calls[1]!.messages), /Never change production/);
  assert.equal(provider.calls[1]!.messages.at(-1)!.role, 'tool');
});
test('SPEC-005-CYCLES: identical consultation without new evidence stops, unknown sources fail', async t => {
  for (const unknown of [false, true]) {
    const config = v2config(); const laya = localDecisions(config);
    const actions = unknown ? [control(CONTEXT, { refs: ['a999'] })] : [control(), answer('review'), control(CONSULT, { specialty: 'review', question: 'Review correctness', refs: ['a0'] }, 'internal-2')];
    const { app } = await fixture(actions, { config, laya }); t.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
    assert.equal(response.json().error.code, unknown ? 'invalid_context_reference' : 'consultation_cycle');
  }
});
test('SPEC-005-CONSULT: depth and decision budgets bound repeated collaboration', async t => {
  const config = v2config(); config.collaboration.maxDepth = 0;
  const { app } = await fixture([control()], { config, laya: localDecisions(config) }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base })).json().error.code, 'consultation_limit');
});

test('SPEC-005-CONSULT: nested consultations unwind to the original responsible model', async t => {
  const config = v2config(); config.models.push({ ...config.models[2]!, id: 'third', remoteId: 'third', specialties: ['debugging'], fallbacks: [] });
  const { FakeProvider } = await import('./helpers.js');
  const provider = new FakeProvider([control(), control(CONSULT, { specialty: 'debugging', question: 'Diagnose edge case', refs: ['a0'] }, 'child-control'), answer('diagnosis'), answer('review with diagnosis'), answer('final')]);
  provider.models.push({ ...provider.models[2]!, id: 'third' });
  const laya = localDecisions(config, 'coding', (purpose, body) => {
    const question = purpose === 'initial' ? '' : JSON.parse(body.state).question;
    if (purpose !== 'consult' || !question.includes('Diagnose edge case')) return undefined;
    return { answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { choice: key === 'specialty' ? 'debugging' : 'keep', answer_confidence: 0.99 }])) };
  });
  const { app } = await fixture([], { config, provider, laya }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.statusCode, 200); assert.equal(response.json().choices[0].message.content, 'final');
  assert.deepEqual(provider.calls.map(c => c.model), ['worker', 'backup', 'third', 'backup', 'worker']);
});

test('SPEC-005-CONTEXT: over-budget sources fail explicitly rather than silently truncating', async t => {
  const config = v2config(); config.collaboration.packetTokens = 10;
  const { app } = await fixture([control(CONTEXT, { refs: ['a0'] })], { config, laya: localDecisions(config) }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.json().error.code, 'context_packet_too_large');
});
