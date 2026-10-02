import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { GatewayError } from './errors.js';
import type { ChatRequest, Completion, Message, RunState } from './types.js';

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function fingerprint(request: ChatRequest, legacy = false) {
  const { stream: _stream, stream_options: _options, ...rest } = request;
  return createHash('sha256').update(stable(legacy ? rest : { ...rest, messages: comparableHistory(rest.messages) })).digest('hex');
}
function comparableHistory(messages: Message[]): Message[] {
  return messages.map(message => !message.tool_calls?.length ? message : {
    ...message,
    // Clients parse and serialize arguments before replaying tool calls. Whitespace
    // and object-key order are not changes to the call. Keep provider state untouched.
    content: message.content === '' ? null : message.content,
    tool_calls: message.tool_calls.map(call => {
      let args = call.function.arguments;
      try { args = stable(JSON.parse(args)); } catch { /* Invalid JSON must still fail comparison. */ }
      return { ...call, function: { ...call.function, arguments: args } };
    }),
  });
}
interface RunRow { id: string; state: string; status: string }
interface ToolRow { id: string; run_id: string }
interface RequestRow { id: string; fingerprint: string; status: string; response: string | null }
export type Prepared = { replay: Completion } | { state: RunState; requestId: string };

export class RunStore {
  private db: Database.Database;
  constructor(path: string, private ttlMs: number) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.transaction(() => {
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 1) throw new Error('Database schema is newer than this application.');
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            continuation_key TEXT UNIQUE, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT);
          CREATE TABLE tool_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE);
          CREATE INDEX runs_updated ON runs(updated_at);
          PRAGMA user_version = 1;
        `);
      }
      this.db.prepare("UPDATE runs SET status = 'interrupted' WHERE status = 'running'").run();
      this.db.prepare("UPDATE requests SET status = 'interrupted' WHERE status = 'running'").run();
    })();
  }
  ready(): boolean { try { this.db.prepare('SELECT 1').get(); return true; } catch { return false; } }
  close() { this.db.close(); }
  cleanup(now = Date.now()) { this.db.prepare('DELETE FROM runs WHERE updated_at < ? AND status != ?').run(now - this.ttlMs, 'running'); }

  private normalizeContinuation(request: ChatRequest, trailing: Message[]): { request: ChatRequest; row: RunRow } {
    const unknown = () => new GatewayError(400, 'unknown_tool_call', 'No matching tool calls were found for this continuation.');
    const lookup = this.db.prepare('SELECT id, run_id FROM tool_calls WHERE id IN (?, ?)');
    const cache = new Map<string, ToolRow | undefined>();
    const resolve = (id: string): ToolRow | undefined => {
      if (cache.has(id)) return cache.get(id);
      // Only accept the exact alias produced by removing the legacy prefix's underscore.
      // Verify it in SQLite; arbitrary punctuation changes must never match a call.
      const legacy = /^call[0-9a-f]{32}$/.test(id) ? `call_${id.slice(4)}` : id;
      const matches = lookup.all(id, legacy) as ToolRow[];
      if (matches.length > 1) throw unknown();
      cache.set(id, matches[0]);
      return matches[0];
    };
    const calls = trailing.map(m => resolve(m.tool_call_id!));
    const runId = calls[0]?.run_id;
    if (!runId || calls.some(call => !call || call.run_id !== runId)) throw unknown();
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) throw unknown();
    const canonicalId = (id: string) => {
      const call = resolve(id);
      return call?.run_id === runId ? call.id : id;
    };
    // Canonicalize ID fields only, including previous rounds, before fingerprinting.
    // Preserve content, arguments and tools so changed input still fails validation.
    return { row, request: { ...request, messages: request.messages.map(message => ({
      ...message,
      ...(message.tool_call_id ? { tool_call_id: canonicalId(message.tool_call_id) } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, id: canonicalId(call.id) })) } : {}),
    })) } };
  }

  prepare(request: ChatRequest): Prepared {
    return this.db.transaction((): Prepared => {
      this.cleanup();
      let trailing: Message[] = [];
      for (let i = request.messages.length - 1; i >= 0 && request.messages[i]?.role === 'tool'; i--) trailing.unshift(request.messages[i]!);
      const requestId = randomUUID();
      if (!trailing.length) {
        const state: RunState = { id: randomUUID(), step: 0, results: [], conversation: request.messages, expectedMessages: request.messages, tools: request.tools, toolRounds: 0 };
        this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(state.id, JSON.stringify(state), 'running', Date.now());
        this.db.prepare('INSERT INTO requests VALUES (?, ?, NULL, ?, ?, NULL)').run(requestId, state.id, fingerprint(request), 'running');
        return { state, requestId };
      }
      const normalized = this.normalizeContinuation(request, trailing);
      request = normalized.request;
      const row = normalized.row;
      trailing = request.messages.slice(-trailing.length);
      const ids = trailing.map(m => m.tool_call_id!).sort();
      const key = stable(ids);
      const previous = this.db.prepare('SELECT * FROM requests WHERE continuation_key = ?').get(key) as RequestRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint(request) && previous.fingerprint !== fingerprint(request, true)) throw new GatewayError(409, 'continuation_conflict', 'This continuation was already submitted with different input.');
        if (previous.status === 'complete' && previous.response) return { replay: JSON.parse(previous.response) };
        throw new GatewayError(409, previous.status === 'running' ? 'continuation_in_progress' : 'execution_interrupted', 'This continuation is running or was interrupted; it will not be executed again automatically.');
      }
      if (row.status !== 'waiting') throw new GatewayError(409, 'execution_unavailable', 'The execution is not waiting for these tool results.');
      const state = JSON.parse(row.state) as RunState;
      if (stable(state.pending?.map(p => p.publicId).sort()) !== stable(ids)) throw new GatewayError(400, 'missing_tool_results', 'Provide all pending tool results in one request.');
      const prefix = request.messages.slice(0, -trailing.length);
      if (stable(comparableHistory(prefix)) !== stable(comparableHistory(state.expectedMessages)) || stable(request.tools) !== stable(state.tools)) throw new GatewayError(409, 'conversation_mismatch', 'Continuation must preserve the conversation and tool definitions.');
      for (const result of trailing) {
        const mapping = state.pending!.find(p => p.publicId === result.tool_call_id)!;
        state.agentMessages!.push({ ...result, tool_call_id: mapping.providerId });
      }
      state.expectedMessages = request.messages;
      state.pending = undefined;
      this.db.prepare("UPDATE runs SET status = 'running', state = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(state), Date.now(), state.id);
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, NULL)').run(requestId, state.id, key, fingerprint(request), 'running');
      return { state, requestId };
    })();
  }

  checkpoint(state: RunState) {
    this.db.prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ? AND status = ?').run(JSON.stringify(state), Date.now(), state.id, 'running');
  }
  finish(state: RunState, requestId: string, response: Completion) {
    this.db.transaction(() => {
      for (const pending of state.pending ?? []) this.db.prepare('INSERT INTO tool_calls VALUES (?, ?)').run(pending.publicId, state.id);
      this.db.prepare('UPDATE runs SET state = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), state.pending ? 'waiting' : 'complete', Date.now(), state.id);
      this.db.prepare("UPDATE requests SET status = 'complete', response = ? WHERE id = ?").run(JSON.stringify(response), requestId);
    })();
  }
  fail(state: RunState, requestId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), state.id);
      this.db.prepare("UPDATE requests SET status = 'interrupted' WHERE id = ? AND status = 'running'").run(requestId);
    })();
  }
}
