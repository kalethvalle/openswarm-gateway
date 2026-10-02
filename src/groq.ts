import { ChatCompletionsAdapter } from './provider.js';
import { GatewayError } from './errors.js';
import type { ModelInfo, ProviderInput, Usage } from './types.js';

// Groq's catalog has context_window but no supported_parameters. Keep capability
// profiles explicit so audio and moderation models cannot enter the swarm.
const toolModels = new Set(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
const parameters = ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'max_tokens'];

export class GroqAdapter extends ChatCompletionsAdapter {
  constructor(apiKey: string, baseUrl = 'https://api.groq.com/openai/v1', fetcher: typeof fetch = fetch) {
    super(apiKey, baseUrl, fetcher, 'Groq');
  }

  async catalog(signal: AbortSignal): Promise<ModelInfo[]> {
    const payload = await this.json(await this.request('/models', signal), signal);
    if (!Array.isArray(payload.data)) throw new GatewayError(502, 'invalid_provider_response', 'Groq returned an invalid model catalog.');
    return payload.data.filter((model: any) => toolModels.has(model.id) && model.active !== false && Number.isInteger(model.context_window) && model.context_window > 0)
      .map((model: any) => ({ id: model.id, contextLength: model.context_window, supportedParameters: [...parameters, ...(model.id.startsWith('openai/gpt-oss-') || model.id === 'qwen/qwen3.8-27b' ? ['response_format'] : [])] }));
  }

  protected requestBody(input: ProviderInput): unknown {
    if (!toolModels.has(input.model)) throw new GatewayError(400, 'unsupported_model', 'This Groq model has no supported chat/tool capability profile.');
    const { max_tokens, messages, ...options } = input;
    return {
      ...options,
      max_completion_tokens: max_tokens,
      ...(input.model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : input.model === 'qwen/qwen3.8-27b' ? { reasoning_effort: 'none' } : {}),
      messages: messages.map(({ name, reasoning: _reasoning, reasoning_details: _details, ...message }) => {
        if (name && message.role !== 'tool') throw new GatewayError(400, 'unsupported_parameters', 'Groq does not support names on conversation messages.');
        return { ...message, role: message.role === 'developer' ? 'system' : message.role };
      }),
      ...(input.stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  protected responseUsage(payload: any): Usage | undefined {
    return super.responseUsage({ usage: payload.usage ?? payload.x_groq?.usage });
  }
}
