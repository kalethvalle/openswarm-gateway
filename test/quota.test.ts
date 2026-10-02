import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/store.js';
import { QuotaLedger, resetMs } from '../src/quota.js';
import { v2config } from './v2-helpers.js';
import { ModelRunner, UsageAccumulator } from '../src/runner.js';
import { FakeProvider, answer } from './helpers.js';

test('SPEC-003-ATOMIC: shared account reservation blocks other models until released/reset', t => {
  const config = v2config(); config.providers.free!.quotas = { rpm: 1, tpm: 500 };
  const store = new RunStore(':memory:', 10000); t.after(() => store.close()); let now = 100000;
  const ledger = new QuotaLedger(store.quotaDatabase(), config, () => now);
  const attempt = ledger.reserve('worker', 300);
  assert.throws(() => ledger.reserve('backup', 100), (e: any) => e.status === 429);
  ledger.cancel(attempt); const next = ledger.reserve('backup', 100); ledger.settle(next, 30);
  now += 60001; assert.ok(ledger.reserve('worker', 400));
  assert.throws(() => ledger.reserve('worker', 501), (e: any) => e.code === 'quota_request_too_large');
});
test('SPEC-003-FALLBACK: try independent provider before waiting', async t => {
  const config = v2config(); config.providers.other = { ...config.providers.free!, quotas: {} }; config.providers.free!.quotas = { rpm: 1 }; config.models[2]!.provider = 'other';
  const store = new RunStore(':memory:', 10000); t.after(() => store.close()); const quota = new QuotaLedger(store.quotaDatabase(), config);
  quota.reserve('worker', 20);
  const provider = new FakeProvider([answer('fallback')]); const runner = new ModelRunner(config, provider, provider.models, () => {}, quota);
  await runner.complete({ model: 'worker', messages: [], stream: false, max_tokens: 10 }, new AbortController().signal, new UsageAccumulator(), { runId: 'x', role: 'coding' });
  assert.deepEqual(provider.calls.map(c => c.model), ['backup']);
});
test('SPEC-003-RESTART: reservations, header windows and cooldown survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'q.sqlite'); const config = v2config();
  let store = new RunStore(path, 10000); let ledger = new QuotaLedger(store.quotaDatabase(), config);
  ledger.reserve('worker', 300); ledger.block('worker', 60); ledger.observe('backup', { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1m2s' }); store.close();
  store = new RunStore(path, 10000); t.after(() => store.close()); ledger = new QuotaLedger(store.quotaDatabase(), config);
  assert.throws(() => ledger.reserve('worker', 1), (e: any) => e.status === 429);
  assert.throws(() => ledger.reserve('backup', 1), (e: any) => e.status === 429);
  assert.equal(resetMs('1m2s'), 62000); assert.equal(resetMs('500ms'), 500);
});

test('SPEC-003-FALLBACK: model capacity 429 does not imply account exhaustion', t => {
  const config = v2config(); const store = new RunStore(':memory:', 10000); t.after(() => store.close());
  const quota = new QuotaLedger(store.quotaDatabase(), config);
  quota.block('worker', 60, 'model');
  assert.ok(quota.reserve('backup', 10));
  quota.block('worker', 60, 'provider');
  assert.throws(() => quota.reserve('backup', 10), (e: any) => e.status === 429);
});
