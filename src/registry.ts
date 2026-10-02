import type { Config } from './config.js';
import { ChatCompletionsAdapter, OpenRouterAdapter } from './provider.js';
import { GroqAdapter } from './groq.js';
import { GatewayError } from './errors.js';
import type { Log, ModelInfo, ProviderAdapter, ProviderInput } from './types.js';

export class LocalAdapter extends ChatCompletionsAdapter {
  constructor(key: string, url: string, private profiles: ModelInfo[], fetcher: typeof fetch = fetch) { super(key, url.replace(/\/$/, ''), fetcher, 'Local'); }
  async catalog(signal: AbortSignal) {
    const result = await this.json(await this.request('/models', signal), signal);
    if (!Array.isArray(result.data)) throw new GatewayError(502, 'invalid_provider_response', 'Invalid local model catalog.');
    return this.profiles.filter(profile => result.data.some((entry: { id: string }) => entry.id === profile.id));
  }
  protected requestBody(input: ProviderInput) { return { ...input, ...(input.stream ? { stream_options: { include_usage: true } } : {}) }; }
}

/** Public aliases are stable; transport IDs and credential-bearing adapters stay private. */
export class ProviderRegistry implements ProviderAdapter {
  private entries = new Map<string, ProviderAdapter>();
  private models: ModelInfo[] = [];
  private statuses: Record<string, string> = {};
  private refreshing?: Promise<ModelInfo[]>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private config: Config, private log: Log = () => {}, injected?: Record<string, ProviderAdapter>) {
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!provider.enabled) { this.statuses[id] = 'disabled'; continue; }
      if (injected?.[id]) { this.entries.set(id, injected[id]); continue; }
      const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      if (provider.type !== 'local' && !key?.trim()) { this.statuses[id] = 'missing_credentials'; continue; }
      const adapter = provider.type === 'groq' ? new GroqAdapter(key!, provider.baseUrl)
        : provider.type === 'openrouter' ? new OpenRouterAdapter(key!, provider.baseUrl)
        : new LocalAdapter(key ?? 'local', provider.baseUrl ?? 'http://127.0.0.1:11434/v1', config.models.filter(m => m.provider === id).map(m => ({ id: m.remoteId!, contextLength: m.contextLength!, supportedParameters: m.supportedParameters! })));
      this.entries.set(id, adapter);
    }
  }
  availableModels() { return this.models; }
  health() { return { providers: { ...this.statuses }, availableModels: this.models.map(m => m.id) }; }
  async catalog(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(signal: AbortSignal) {
    const candidates: ModelInfo[] = [];
    await Promise.all([...this.entries].map(async ([id, adapter]) => {
      try {
        const catalog = await adapter.catalog(signal);
        const accepted = this.config.models.filter(m => m.provider === id).flatMap(model => {
          const info = catalog.find(m => m.id === model.remoteId);
          if (!info || this.config.providers[id]!.type === 'openrouter' && info.free !== true) return [];
          return [{ ...info, id: model.id, remoteId: model.remoteId, provider: id }];
        });
        candidates.push(...accepted);
        this.statuses[id] = accepted.length ? 'ready' : 'no_eligible_models';
      } catch { this.statuses[id] = 'unavailable'; }
      this.log({ provider: id, status: this.statuses[id] }, 'Provider catalog refreshed');
    }));
    this.models = candidates;
    if (!this.timer) this.timer = setInterval(() => { void this.catalog(AbortSignal.timeout(Math.min(10000, this.config.limits.modelTimeoutMs))).catch(() => {}); }, this.config.catalogRefreshMs).unref();
    return this.models;
  }
  async complete(input: ProviderInput, signal: AbortSignal, onText?: (text: string) => Promise<void>) {
    const model = this.models.find(m => m.id === input.model);
    const adapter = model?.provider ? this.entries.get(model.provider) : undefined;
    if (!adapter || !model?.remoteId) throw new GatewayError(503, 'model_unavailable', 'The selected provider/model is unavailable.', true);
    const result = await adapter.complete({ ...input, model: model.remoteId }, signal, onText);
    return result; // Keep the actual transport model in audit logs.
  }
  close() { if (this.timer) clearInterval(this.timer); for (const adapter of this.entries.values()) adapter.close?.(); }
}
