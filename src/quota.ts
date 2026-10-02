import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { GatewayError } from './errors.js';
import type { RateHeaders } from './types.js';

type Limits = Config['models'][number]['quotas'];
const windows = { rpm: [60000, 'requests'], rpd: [86400000, 'requests'], tpm: [60000, 'tokens'], tpd: [86400000, 'tokens'] } as const;

export function resetMs(value: string | undefined): number | undefined {
  if (!value) return;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (parts.length && parts.map(p => p[0]).join('') === value) return parts.reduce((sum, p) => sum + Number(p[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[p[2]!]!), 0);
  const date = Date.parse(value); if (Number.isFinite(date)) return Math.max(0, date - Date.now());
}

export class QuotaLedger {
  constructor(private db: Database.Database, private config: Config, private now: () => number = Date.now) {}
  private groups(id: string): { key: string; limits: Limits }[] {
    const model = this.config.models.find(m => m.id === id)!;
    return [{ key: `provider:${model.provider}`, limits: this.config.providers[model.provider!]?.quotas ?? {} },
      { key: `model:${model.provider}:${model.remoteId}`, limits: model.quotas },
      ...model.quotaGroups.map(group => ({ key: `shared:${group}`, limits: this.config.quotaGroups[group]! }))];
  }
  reserve(id: string, tokens: number): string {
    return this.db.transaction(() => {
      const now = this.now(); const groups = this.groups(id); let wait = 0;
      this.db.prepare('DELETE FROM quota_reservations WHERE created < ?').run(now - 86400000);
      for (const group of groups) {
        const block = this.db.prepare('SELECT until_ms FROM quota_blocks WHERE scope = ?').get(group.key) as { until_ms: number } | undefined;
        wait = Math.max(wait, (block?.until_ms ?? now) - now);
        for (const [key, limit] of Object.entries(group.limits)) {
          const [duration, column] = windows[key as keyof Limits];
          const rows = this.db.prepare(`SELECT created, ${column} AS amount FROM quota_reservations WHERE scope = ? AND created > ? ORDER BY created`).all(group.key, now - duration) as { created: number; amount: number }[];
          const needed = column === 'tokens' ? tokens : 1;
          // Waiting cannot make an individual oversized request fit.
          if (needed > limit) throw new GatewayError(400, 'quota_request_too_large', `The request exceeds the configured ${key} capacity for this candidate. Reduce context or choose another model.`, true);
          let used = rows.reduce((sum, row) => sum + row.amount, 0);
          if (used + needed > limit) for (const row of rows) { used -= row.amount; if (used + needed <= limit) { wait = Math.max(wait, row.created + duration - now); break; } }
        }
        const hints = this.db.prepare('SELECT dimension, remaining, until_ms FROM quota_hints WHERE scope = ? AND until_ms > ?').all(group.key, now) as { dimension: string; remaining: number; until_ms: number }[];
        for (const hint of hints) if (hint.remaining < (hint.dimension === 'tokens' ? tokens : 1)) wait = Math.max(wait, hint.until_ms - now);
      }
      if (wait > 0) { const error = new GatewayError(429, 'provider_rate_limited', 'All considered quota windows must admit this call.', true); error.retryAfterSeconds = Math.ceil(wait / 1000); throw error; }
      const attempt = randomUUID();
      for (const group of groups) {
        this.db.prepare('INSERT INTO quota_reservations VALUES (?, ?, ?, 1, ?)').run(attempt, group.key, now, tokens);
        this.db.prepare("UPDATE quota_hints SET remaining = MAX(0, remaining - CASE WHEN dimension = 'tokens' THEN ? ELSE 1 END) WHERE scope = ? AND until_ms > ?").run(tokens, group.key, now);
      }
      return attempt;
    })();
  }
  settle(attempt: string, tokens?: number) { if (tokens !== undefined) this.db.prepare('UPDATE quota_reservations SET tokens = ? WHERE id = ?').run(tokens, attempt); }
  cancel(attempt: string) {
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT scope, tokens FROM quota_reservations WHERE id = ?').all(attempt) as { scope: string; tokens: number }[];
      for (const row of rows) this.db.prepare("UPDATE quota_hints SET remaining = remaining + CASE WHEN dimension = 'tokens' THEN ? ELSE 1 END WHERE scope = ? AND until_ms > ?").run(row.tokens, row.scope, this.now());
      this.db.prepare('DELETE FROM quota_reservations WHERE id = ?').run(attempt);
    })();
  }
  observe(id: string, headers?: RateHeaders) {
    if (!headers) return;
    // Groq's request/token headers are model windows; configured account/shared groups still apply independently.
    const scope = this.groups(id)[1]!.key;
    this.db.prepare('DELETE FROM quota_hints WHERE until_ms <= ?').run(this.now());
    for (const dimension of ['requests', 'tokens']) {
      const value = headers[`x-ratelimit-remaining-${dimension}`];
      const duration = resetMs(headers[`x-ratelimit-reset-${dimension}`]);
      if (value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0 || duration === undefined) continue;
      this.db.prepare('INSERT INTO quota_hints VALUES (?, ?, ?, ?) ON CONFLICT(scope, dimension) DO UPDATE SET remaining = MIN(quota_hints.remaining, excluded.remaining), until_ms = MAX(quota_hints.until_ms, excluded.until_ms)').run(scope, dimension, Number(value), this.now() + duration);
    }
  }
  block(id: string, seconds: number, level: 'model' | 'provider' = 'model') {
    const scope = this.groups(id)[level === 'provider' ? 0 : 1]!.key;
    this.db.prepare('INSERT INTO quota_blocks VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET until_ms = MAX(quota_blocks.until_ms, excluded.until_ms)').run(scope, this.now() + seconds * 1000);
  }
}
