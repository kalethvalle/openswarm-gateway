import type { Config } from './config.js';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayError } from './errors.js';
import type { QuotaLedger } from './quota.js';
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
  constructor(public config: Config, private provider: ProviderAdapter, private models: ModelInfo[], private log: Log = () => {}, private quota?: QuotaLedger) {
    for (const model of config.version === 1 ? config.models : []) if (!models.some(m => m.id === model.id)) throw new GatewayError(503, 'model_unavailable', `Configured model is unavailable or unsupported in the ${config.provider} catalog: ${model.id}`);
  }
  private catalog() { return this.provider.availableModels?.() ?? this.models; }
  supports(id: string, input: Partial<ProviderInput>): boolean {
    const info = this.catalog().find(m => m.id === id);
    if (!info || !this.config.models.some(m => m.id === id)) return false;
    const binding = this.config.models.find(m => m.id === id)!;
    if (this.config.version === 2 && info.provider && (binding.provider !== info.provider || binding.remoteId !== info.remoteId)) return false;
    const parameters = ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'max_tokens', 'response_format'] as const;
    return parameters.every(p => input[p] === undefined || input[p] === null || info.supportedParameters.includes(p) || p === 'parallel_tool_calls' && input[p] === false && info.supportedParameters.includes('tools'));
  }
  private async reserveAttempt(id: string, tokens: number, usage: UsageAccumulator, signal: AbortSignal, fields: Record<string, unknown>, dispatch: () => void = () => {}) {
    usage.check(tokens, this.config.limits); // Reject before touching the scheduling lane.
    const interval = this.config.models.find(model => model.id === id)!.minIntervalMs;
    if (!interval) { signal.throwIfAborted(); dispatch(); usage.reserve(tokens, this.config.limits); return; }
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
      usage.check(tokens, this.config.limits);
      dispatch();
      usage.reserve(tokens, this.config.limits);
      // Only dispatched calls move the clock; rejected/cancelled turns reserve no slot.
      this.nextSlots.set(id, Date.now() + interval);
    } finally {
      void previous.then(release);
      void tail.then(() => { if (this.lanes.get(id) === tail) this.lanes.delete(id); });
    }
  }
  async complete(input: ProviderInput, signal: AbortSignal, usage: UsageAccumulator, options: {
    locked?: boolean; exclude?: string[]; inputForModel?: (id: string) => ProviderInput; onText?: (text: string) => Promise<void>; runId: string; role: string;
  }): Promise<{ result: ProviderResult; selectedModel: string }> {
    const selected = this.config.models.find(m => m.id === input.model);
    if (!selected) throw new GatewayError(400, 'unauthorized_model', 'The model is not in the configured allowlist.');
    const extra = this.config.version === 2 && !options.locked ? this.config.models.filter(m => m.specialties.some(s => selected.specialties.includes(s))).sort((a, b) => (this.config.providers[a.provider!]?.priority ?? 100) - (this.config.providers[b.provider!]?.priority ?? 100)).map(m => m.id) : [];
    const requiredSpecialty = this.config.version === 2 && ['general', 'coding', 'debugging', 'architecture', 'review'].includes(options.role) ? options.role : undefined;
    const candidates = [...new Set([selected.id, ...(options.locked ? [] : selected.fallbacks), ...extra])].filter(id => !options.exclude?.includes(id) && (!requiredSpecialty || this.config.models.find(m => m.id === id)?.specialties.includes(requiredSpecialty)) && this.supports(id, input));
    if (!candidates.length) throw new GatewayError(this.config.version === 2 ? 503 : 400, this.config.version === 2 ? 'model_unavailable' : 'unsupported_parameters', 'No configured candidate supports the requested parameters.');
    let lastError: unknown;
    let published = false;
    let rateLimitRetries = 0;
    let quotaWaited = false;
    const quotaErrors: GatewayError[] = [];
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
      const info = this.catalog().find(m => m.id === id);
      if (!info || !this.supports(id, input)) {
        lastError = new GatewayError(503, 'model_unavailable', 'The candidate became unavailable after a catalog refresh.', true);
        continue;
      }
      const candidateInput = { ...(options.inputForModel?.(id) ?? input) };
      // Some catalogs omit this transport option. False is still enforced when
      // validating the returned calls, without requiring provider-side support.
      if (candidateInput.parallel_tool_calls === false && !info.supportedParameters.includes('parallel_tool_calls')) delete candidateInput.parallel_tool_calls;
      const estimated = estimateInputTokens(candidateInput);
      // Keep the byte bound for model context safety, independently of run budgeting.
      if ((this.config.version === 1 ? estimated.bytes + input.messages.length * 32 + 1024 : estimated.tokens) + input.max_tokens > info.contextLength) {
        lastError = new GatewayError(400, 'context_length_exceeded', `Context exceeds the conservative limit for ${id}; no messages were discarded.`);
        continue;
      }
      this.log({ runId: options.runId, role: options.role, model: id, inputBytes: estimated.bytes, estimatedInputTokens: estimated.tokens, maxOutputTokens: input.max_tokens }, 'Model request budget');
      let quotaAttempt: string | undefined;
      try {
        await this.reserveAttempt(id, estimated.tokens + input.max_tokens, usage, signal, { runId: options.runId, role: options.role }, () => { quotaAttempt = this.quota?.reserve(id, estimated.tokens + input.max_tokens); });
      } catch (error) {
        if (quotaAttempt) this.quota?.cancel(quotaAttempt);
        if (!(error instanceof GatewayError) || !['provider_rate_limited', 'quota_request_too_large'].includes(error.code)) throw error;
        lastError = error; quotaErrors.push(error);
        if (index === candidates.length - 1 && !quotaWaited) {
          const shortest = Math.min(...quotaErrors.filter(e => e.status === 429).map(e => (e.retryAfterSeconds ?? 30) * 1000));
          if (shortest + 10 <= this.config.collaboration.maxQuotaWaitMs) { quotaWaited = true; await delay(shortest + 10, undefined, { signal }); index = -1; }
        }
        continue;
      }
      const started = Date.now();
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.limits.modelTimeoutMs)]);
      try {
        const result = await this.provider.complete({ ...candidateInput, model: id }, attemptSignal, options.onText ? async text => {
          if (text) published = true;
          await options.onText!(text);
        } : undefined);
        signal.throwIfAborted();
        usage.add(result.usage);
        if (quotaAttempt) this.quota?.settle(quotaAttempt, result.usage?.total_tokens);
        this.quota?.observe(id, result.rateHeaders);
        this.log({ runId: options.runId, role: options.role, model: result.model, selectedModel: id, fallback: index > 0, durationMs: Date.now() - started, usage: result.usage }, 'Model completed');
        return { result, selectedModel: id };
      } catch (error) {
        usage.unknown();
        if (signal.aborted) throw signal.reason;
        lastError = attemptSignal.aborted ? new GatewayError(504, 'provider_timeout', 'Provider model deadline exceeded.', true) : error;
        // An HTTP 429 rejects the call before inference. Count the attempt, but
        // release its token reservation; network/SSE failures retain theirs.
        if (lastError instanceof GatewayError && lastError.upstreamStatus === 429 && !published) { usage.rejectedBeforeGeneration(); if (quotaAttempt) this.quota?.settle(quotaAttempt, 0); }
        if (lastError instanceof GatewayError) { this.quota?.observe(id, lastError.rateHeaders); if (lastError.status === 429) this.quota?.block(id, lastError.retryAfterSeconds ?? 30, lastError.rateLimitScope); }
        if (lastError instanceof GatewayError && lastError.status === 429) this.cooldowns.set(id, Date.now() + (lastError.retryAfterSeconds ?? 30) * 1000);
        this.log({ runId: options.runId, role: options.role, model: id, durationMs: Date.now() - started, code: lastError instanceof GatewayError ? lastError.code : 'provider_error', ...(lastError instanceof GatewayError ? { status: lastError.status, upstreamStatus: lastError.upstreamStatus, upstreamCode: lastError.upstreamCode, retryAfterSeconds: lastError.retryAfterSeconds, rateLimitScope: lastError.rateLimitScope } : {}) }, 'Model failed');
        if (this.config.version === 1 && !published && lastError instanceof GatewayError && lastError.upstreamStatus === 429 && rateLimitRetries < this.config.limits.rateLimitRetries) {
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
