import type { Config } from './config.js';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayError } from './errors.js';
import { estimateInputTokens } from './tokens.js';
import type { Log, ModelInfo, ProviderAdapter, ProviderInput, ProviderResult, Usage, RunBudget } from './types.js';

export class UsageAccumulator {
  constructor(private budget: RunBudget = { calls: 0, tokens: 0 }, private checkpoint: () => void = () => {}) {}
  private reservation = 0;
  private complete = true;
  private total: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  add(usage?: Usage) {
    if (!usage) { this.complete = false; return; }
    this.budget.tokens += usage.total_tokens - this.reservation;
    this.reservation = 0;
    this.checkpoint();
    this.total.prompt_tokens += usage.prompt_tokens;
    this.total.completion_tokens += usage.completion_tokens;
    this.total.total_tokens += usage.total_tokens;
  }
  unknown() { this.complete = false; }
  rejectedBeforeGeneration() {
    this.budget.tokens -= this.reservation;
    this.reservation = 0;
    this.checkpoint();
  }
  check(tokens: number, limits: Config['limits']) {
    if (this.budget.calls >= limits.maxModelCalls || this.budget.tokens + tokens > limits.maxRunTokens) throw new GatewayError(400, 'run_budget_exceeded', `Gateway execution budget exceeded: calls ${this.budget.calls}/${limits.maxModelCalls}, accounted tokens ${this.budget.tokens}, estimated next call ${tokens}, token limit ${limits.maxRunTokens}. Reduce client context/tools or adjust the Gateway budget; this is not a provider rate limit.`);
  }
  reserve(tokens: number, limits: Config['limits']) {
    this.check(tokens, limits);
    this.reservation = tokens;
    this.budget.calls++;
    this.budget.tokens += tokens;
    this.checkpoint(); // Persist before inference; failed/unknown calls retain their reservation.
  }
  value(): Usage | undefined { return this.complete ? { ...this.total } : undefined; }
}

export class ModelRunner {
  private cooldowns = new Map<string, number>();
  private nextSlots = new Map<string, number>();
  private lanes = new Map<string, Promise<void>>();
  constructor(public config: Config, private provider: ProviderAdapter, private models: ModelInfo[], private log: Log = () => {}) {
    for (const model of config.models) if (!models.some(m => m.id === model.id)) throw new GatewayError(503, 'model_unavailable', `Configured model is unavailable or unsupported in the ${config.provider} catalog: ${model.id}`);
  }
  supports(id: string, input: Partial<ProviderInput>): boolean {
    const info = this.models.find(m => m.id === id);
    if (!info || !this.config.models.some(m => m.id === id)) return false;
    const parameters = ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'max_tokens', 'response_format'] as const;
    return parameters.every(p => input[p] === undefined || input[p] === null || info.supportedParameters.includes(p));
  }
  private async reserveAttempt(id: string, tokens: number, usage: UsageAccumulator, signal: AbortSignal, fields: Record<string, unknown>) {
    usage.check(tokens, this.config.limits); // Reject before touching the scheduling lane.
    const interval = this.config.models.find(model => model.id === id)!.minIntervalMs;
    if (!interval) { signal.throwIfAborted(); usage.reserve(tokens, this.config.limits); return; }
    const previous = this.lanes.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.lanes.set(id, tail);
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      signal.throwIfAborted();
      const waitMs = (this.nextSlots.get(id) ?? 0) - Date.now();
      if (waitMs > 0) {
        this.log({ ...fields, model: id, waitMs }, 'Waiting for model slot');
        await delay(waitMs, undefined, { signal });
      }
      signal.throwIfAborted();
      usage.reserve(tokens, this.config.limits);
      // Only dispatched calls move the clock; rejected/cancelled turns reserve no slot.
      this.nextSlots.set(id, Date.now() + interval);
    } finally {
      void previous.then(release);
      void tail.then(() => { if (this.lanes.get(id) === tail) this.lanes.delete(id); });
    }
  }
  async complete(input: ProviderInput, signal: AbortSignal, usage: UsageAccumulator, options: {
    locked?: boolean; onText?: (text: string) => Promise<void>; runId: string; role: string;
  }): Promise<{ result: ProviderResult; selectedModel: string }> {
    const selected = this.config.models.find(m => m.id === input.model);
    if (!selected) throw new GatewayError(400, 'unauthorized_model', 'The model is not in the configured allowlist.');
    const candidates = [...new Set([selected.id, ...(options.locked ? [] : selected.fallbacks)])].filter(id => this.supports(id, input));
    if (!candidates.length) throw new GatewayError(400, 'unsupported_parameters', 'No configured candidate supports the requested parameters.');
    let lastError: unknown;
    let published = false;
    let rateLimitRetries = 0;
    for (let index = 0; index < candidates.length; index++) {
      const id = candidates[index]!;
      signal.throwIfAborted();
      const remaining = (this.cooldowns.get(id) ?? 0) - Date.now();
      if (remaining > 0) {
        const error = new GatewayError(429, 'provider_rate_limited', 'The model is cooling down after a provider rate limit.', true);
        error.retryAfterSeconds = Math.ceil(remaining / 1000);
        lastError = error;
        continue;
      }
      const info = this.models.find(m => m.id === id)!;
      const estimated = estimateInputTokens(input);
      // Keep the byte bound for model context safety, independently of run budgeting.
      if (estimated.bytes + input.messages.length * 32 + 1024 + input.max_tokens > info.contextLength) {
        lastError = new GatewayError(400, 'context_length_exceeded', `Context exceeds the conservative limit for ${id}; no messages were discarded.`);
        continue;
      }
      this.log({ runId: options.runId, role: options.role, model: id, inputBytes: estimated.bytes, estimatedInputTokens: estimated.tokens, maxOutputTokens: input.max_tokens }, 'Model request budget');
      await this.reserveAttempt(id, estimated.tokens + input.max_tokens, usage, signal, { runId: options.runId, role: options.role });
      const started = Date.now();
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.limits.modelTimeoutMs)]);
      try {
        const result = await this.provider.complete({ ...input, model: id }, attemptSignal, options.onText ? async text => {
          if (text) published = true;
          await options.onText!(text);
        } : undefined);
        signal.throwIfAborted();
        usage.add(result.usage);
        this.log({ runId: options.runId, role: options.role, model: result.model, selectedModel: id, fallback: index > 0, durationMs: Date.now() - started, usage: result.usage }, 'Model completed');
        return { result, selectedModel: id };
      } catch (error) {
        usage.unknown();
        if (signal.aborted) throw signal.reason;
        lastError = attemptSignal.aborted ? new GatewayError(504, 'provider_timeout', 'Provider model deadline exceeded.', true) : error;
        // An HTTP 429 rejects the call before inference. Count the attempt, but
        // release its token reservation; network/SSE failures retain theirs.
        if (lastError instanceof GatewayError && lastError.upstreamStatus === 429 && !published) usage.rejectedBeforeGeneration();
        if (lastError instanceof GatewayError && lastError.status === 429) this.cooldowns.set(id, Date.now() + (lastError.retryAfterSeconds ?? 30) * 1000);
        this.log({ runId: options.runId, role: options.role, model: id, durationMs: Date.now() - started, code: lastError instanceof GatewayError ? lastError.code : 'provider_error', ...(lastError instanceof GatewayError ? { status: lastError.status, upstreamStatus: lastError.upstreamStatus, upstreamCode: lastError.upstreamCode, retryAfterSeconds: lastError.retryAfterSeconds } : {}) }, 'Model failed');
        if (!published && lastError instanceof GatewayError && lastError.upstreamStatus === 429 && rateLimitRetries < this.config.limits.rateLimitRetries) {
          const waitMs = (lastError.retryAfterSeconds ?? 30) * 1000;
          if (waitMs <= 60000) {
            rateLimitRetries++;
            this.log({ runId: options.runId, role: options.role, model: id, waitMs, retry: rateLimitRetries }, 'Waiting after provider rate limit');
            await delay(waitMs + 10, undefined, { signal });
            index--;
            continue;
          }
        }
        if (published || options.locked || !(lastError instanceof GatewayError && lastError.retryable)) throw lastError;
      }
    }
    throw lastError ?? new GatewayError(503, 'model_unavailable', 'No eligible models are available.');
  }
}
