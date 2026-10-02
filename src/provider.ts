import { createParser } from 'eventsource-parser';
import { GatewayError } from './errors.js';
import type { Message, ModelInfo, ProviderAdapter, ProviderInput, ProviderResult, ToolCall, Usage, FinishReason } from './types.js';

function rateHeaders(response: Response): Record<string, string> {
  return Object.fromEntries([...response.headers].filter(([key]) => key.startsWith('x-ratelimit-') || key === 'retry-after'));
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const finishes = new Set(['stop', 'length', 'tool_calls', 'content_filter']);
function upstreamError(status: number, providerName: string) {
  return new GatewayError(status === 429 ? 429 : 502, 'provider_error', `${providerName} request failed (upstream status ${status}).`, status === 408 || status === 429 || status >= 500);
}
function usageOf(value: any): Usage | undefined {
  if (!value || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isInteger(value[k]) && value[k] >= 0)) return undefined;
  return { prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens, total_tokens: value.total_tokens };
}
function protocolError(): GatewayError { return new GatewayError(502, 'invalid_provider_response', 'The provider returned an invalid or incomplete response.'); }
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, providerName: string) {
  try { return await reader.read(); } catch {
    if (signal.aborted) throw signal.reason;
    throw new GatewayError(502, 'provider_connection_error', `The connection to ${providerName} was interrupted.`, true);
  }
}
function normalizeMessage(value: any): Message {
  if (!value || value.role !== 'assistant' || (value.content != null && typeof value.content !== 'string')) throw protocolError();
  const result: Message = { role: 'assistant', content: value.content ?? null };
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls) || !value.tool_calls.length) throw protocolError();
    result.tool_calls = value.tool_calls.map((c: any): ToolCall => {
      if (!c || typeof c.id !== 'string' || !c.id || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string') throw protocolError();
      return { id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } };
    });
  }
  if (typeof value.reasoning === 'string') result.reasoning = value.reasoning;
  if (Array.isArray(value.reasoning_details)) result.reasoning_details = value.reasoning_details;
  return result;
}

export abstract class ChatCompletionsAdapter implements ProviderAdapter {
  constructor(private apiKey: string, private baseUrl: string, private fetcher: typeof fetch, private providerName: string) {}

  abstract catalog(signal: AbortSignal): Promise<ModelInfo[]>;
  protected abstract requestBody(input: ProviderInput): unknown;
  protected responseUsage(payload: any): Usage | undefined { return usageOf(payload.usage); }

  protected async request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'OpenSwarm Gateway' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const error = upstreamError(response.status, this.providerName);
        error.upstreamStatus = response.status;
        error.rateHeaders = rateHeaders(response);
        const hint = response.headers.get('retry-after');
        if (hint) {
          const seconds = Number(hint);
          const delay = Number.isFinite(seconds) ? seconds : (Date.parse(hint) - Date.now()) / 1000;
          if (Number.isFinite(delay) && delay >= 0) error.retryAfterSeconds = Math.ceil(delay);
        }
        try {
          const payload = await this.json(response, signal);
          const code = payload?.error?.code;
          if (typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(code)) error.upstreamCode = code;
          if (response.status === 429) {
            const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
            // OpenRouter platform free quotas are shared; upstream capacity 429s
            // are not proof that every model on the account is exhausted.
            error.rateLimitScope = /free-models-per-(day|minute)|daily limit|account.*rate limit/i.test(message) ? 'provider' : 'model';
            if (error.retryAfterSeconds === undefined && /free-models-per-day|daily limit/i.test(message)) error.retryAfterSeconds = 86400;
          }
        } catch { /* Preserve the upstream status even if its error body is not JSON. */ }
        throw error;
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(502, 'provider_connection_error', `Could not connect to ${this.providerName}.`, true);
    }
  }

  protected async json(response: Response, signal: AbortSignal): Promise<any> {
    if (!response.body) throw protocolError();
    const reader = response.body.getReader();
    let bytes = 0; const parts: Uint8Array[] = [];
    try {
      while (true) {
        const next = await readChunk(reader, signal, this.providerName);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw protocolError();
        parts.push(next.value);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof GatewayError) throw error;
      throw protocolError();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async complete(input: ProviderInput, signal: AbortSignal, onText?: (text: string) => Promise<void>): Promise<ProviderResult> {
    const response = await this.request('/chat/completions', signal, this.requestBody(input));
    if (!input.stream) {
      const payload = await this.json(response, signal);
      if (payload.error) throw upstreamError(Number(payload.error.code) || 502, this.providerName);
      const choice = payload.choices?.[0];
      if (!choice || !finishes.has(choice.finish_reason)) throw protocolError();
      return { model: payload.model ?? input.model, message: normalizeMessage(choice.message), finishReason: choice.finish_reason, usage: this.responseUsage(payload), rateHeaders: rateHeaders(response) };
    }
    if (!response.body) throw protocolError();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];
    const parser = createParser({ onEvent: e => events.push(e.data), onError: () => { throw protocolError(); } });
    let content = '', reasoning = '', model = input.model, done = false, bytes = 0;
    let finishReason: FinishReason | undefined, usage: Usage | undefined;
    const calls = new Map<number, any>();
    const details = new Map<number, Record<string, any>>();
    const consume = async () => {
      for (const data of events.splice(0)) {
        if (data === '[DONE]') { done = true; continue; }
        if (done) throw protocolError();
        const chunk = JSON.parse(data);
        if (chunk.error) throw upstreamError(Number(chunk.error.code) || 502, this.providerName);
        model = chunk.model ?? model;
        const measured = this.responseUsage(chunk);
        if (measured) usage = measured;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason != null) {
          if (!finishes.has(choice.finish_reason)) throw protocolError();
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string') { content += delta.content; if (delta.content) await onText?.(delta.content); }
        if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
        for (const detail of delta.reasoning_details ?? []) {
          const index = detail.index ?? 0;
          const current = details.get(index) ?? {};
          for (const [key, value] of Object.entries(detail)) {
            current[key] = ['text', 'data', 'signature', 'summary'].includes(key) && typeof value === 'string' ? (current[key] ?? '') + value : value;
          }
          details.set(index, current);
        }
        for (const part of delta.tool_calls ?? []) {
          if (!Number.isInteger(part.index) || part.index < 0) throw protocolError();
          const current = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id) current.id = part.id;
          if (part.type && part.type !== 'function') throw protocolError();
          if (part.function?.name) current.function.name += part.function.name;
          if (part.function?.arguments) current.function.arguments += part.function.arguments;
          calls.set(part.index, current);
        }
      }
    };
    try {
      while (!done) {
        const next = await readChunk(reader, signal, this.providerName);
        if (next.done) { parser.feed(decoder.decode()); await consume(); break; }
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw protocolError();
        parser.feed(decoder.decode(next.value, { stream: true }));
        await consume();
      }
      if (!done || !finishReason) throw protocolError();
      return { model, finishReason, usage, rateHeaders: rateHeaders(response), message: normalizeMessage({
        role: 'assistant', content: content || null,
        ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c) } : {}),
        ...(reasoning ? { reasoning } : {}), ...(details.size ? { reasoning_details: [...details.values()] } : {}),
      }) };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof GatewayError) throw error;
      throw protocolError();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export class OpenRouterAdapter extends ChatCompletionsAdapter {
  constructor(apiKey: string, baseUrl = 'https://openrouter.ai/api/v1', fetcher: typeof fetch = fetch) {
    super(apiKey, baseUrl, fetcher, 'OpenRouter');
  }
  async catalog(signal: AbortSignal): Promise<ModelInfo[]> {
    const payload = await this.json(await this.request('/models', signal), signal);
    if (!Array.isArray(payload.data)) throw protocolError();
    return payload.data.filter((m: any) => typeof m.id === 'string' && Number.isInteger(m.context_length) && m.context_length > 0 && Array.isArray(m.supported_parameters))
      .map((m: any) => ({ id: m.id, contextLength: m.context_length, supportedParameters: m.supported_parameters.filter((p: unknown) => typeof p === 'string'), ...(m.pricing ? { free: m.id.endsWith(':free') && ['prompt', 'completion'].every(k => typeof m.pricing[k] === 'string' && Number(m.pricing[k]) === 0) && Object.values(m.pricing).every(v => typeof v === 'string' && Number(v) === 0) } : {}) }));
  }
  protected requestBody(input: ProviderInput): unknown {
    return { ...input, provider: { require_parameters: true }, transforms: [], ...(input.stream ? { stream_options: { include_usage: true } } : {}) };
  }
}
