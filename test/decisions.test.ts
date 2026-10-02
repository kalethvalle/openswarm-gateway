import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, answer, base, headers } from './helpers.js';
import { v2config, localDecisions } from './v2-helpers.js';

test('SPEC-004-DECIDE: accepted greeting uses local IA and one generation', async t => {
  const config = v2config(); const laya = localDecisions(config, 'general');
  const { app, provider } = await fixture([answer('Hola')], { config, laya }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...base, messages: [{ role: 'user', content: 'hola' }] } });
  assert.equal(response.statusCode, 200); assert.equal(provider.calls.length, 1); assert.equal(provider.calls[0]!.model, 'worker');
});
test('SPEC-004-ABSTAIN: low confidence, truncation and offline router use bounded generative decision', async t => {
  for (const reason of ['low', 'truncated', 'offline']) {
    const config = v2config(); const laya = localDecisions(config, 'general', () => {
      if (reason === 'offline') throw new Error('offline');
      return { answers: { specialty: { choice: 'general', answer_confidence: reason === 'low' ? 0.8 : 0.99 }, delivery: { choice: 'direct', answer_confidence: 0.99 } }, usage: { truncated: reason === 'truncated' } };
    });
    const { app, provider } = await fixture([answer('{"specialty":"general"}'), answer('ok')], { config, laya }); t.after(() => app.close());
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base })).statusCode, 200);
    assert.deepEqual(provider.calls.map(c => c.model), ['planner', 'worker']);
  }
});
test('SPEC-004-BOUNDS: oversized routing input never reaches Laya and invalid generative choices fail', async t => {
  const config = v2config(); config.laya.maxInputChars = 1;
  let contacted = false;
  const laya = localDecisions(config, 'general', () => { contacted = true; throw new Error(); });
  const { app } = await fixture([answer('{"specialty":"unapproved"}')], { config, laya }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: base });
  assert.equal(response.json().error.code, 'invalid_decision'); assert.equal(contacted, false);
});
