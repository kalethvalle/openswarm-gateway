import { configSchema } from '../src/config.js';
import type { Config } from '../src/config.js';
import type { ModelInfo, Plan, ProviderAdapter, ProviderInput, ProviderResult } from '../src/types.js';
import { createApp } from '../src/app.js';
import { RunStore } from '../src/store.js';
import type { LayaRouter } from '../src/laya.js';

export const parameters = ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'max_tokens'];
export const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
export const tools = [{ type: 'function' as const, function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }];
export const headers = { authorization: 'Bearer test-key' };
export const base = { model: 'openswarm-auto', messages: [{ role: 'user', content: 'Solve this task.' }] };
export function configuration(limits: Partial<Config['limits']> = {}): Config {
  return configSchema.parse({ plannerModel: 'planner', models: [
    { id: 'planner', specialties: ['planning'], fallbacks: [] },
    { id: 'worker', specialties: ['general'], fallbacks: ['backup'] },
    { id: 'backup', specialties: ['general'], fallbacks: [] },
  ], limits });
}
export function plan(count = 1): Plan {
  return { intent: 'Solve the task', steps: Array.from({ length: count }, (_, i) => ({ role: `role-${i}`, objective: 'Solve', instructions: 'Do the task', model: 'worker', output: i === count - 1 ? 'final' as const : 'handoff' as const })) };
}
export function answer(content: string, extra: Partial<ProviderResult> = {}): ProviderResult {
  return { model: 'worker', message: { role: 'assistant', content }, finishReason: 'stop', usage, ...extra };
}
export function planned(count = 1) { return answer(JSON.stringify(plan(count)), { model: 'planner' }); }
export function toolAnswer(count = 1): ProviderResult {
  return { model: 'worker', finishReason: 'tool_calls', usage, message: { role: 'assistant', content: null,
    tool_calls: Array.from({ length: count }, (_, i) => ({ id: `upstream-${i}`, type: 'function', function: { name: 'lookup', arguments: '{"query":"test"}' } })),
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-state' }],
  } };
}
export type Action = ProviderResult | Error | ((input: ProviderInput, signal: AbortSignal, onText?: (text: string) => Promise<void>) => Promise<ProviderResult>);
export class FakeProvider implements ProviderAdapter {
  calls: ProviderInput[] = [];
  models: ModelInfo[] = ['planner', 'worker', 'backup'].map(id => ({ id, contextLength: 200_000, supportedParameters: [...parameters] }));
  constructor(public actions: Action[]) {}
  async catalog() { return this.models; }
  async complete(input: ProviderInput, signal: AbortSignal, onText?: (text: string) => Promise<void>): Promise<ProviderResult> {
    this.calls.push(structuredClone(input));
    const action = this.actions.shift();
    if (!action) throw new Error('Unexpected provider invocation');
    if (action instanceof Error) throw action;
    if (typeof action === 'function') return action(input, signal, onText);
    if (input.stream && action.message.content) await onText?.(action.message.content);
    return structuredClone(action);
  }
}
export async function fixture(actions: Action[], options: { config?: Config; path?: string; provider?: FakeProvider; laya?: LayaRouter } = {}) {
  const config = options.config ?? configuration();
  const provider = options.provider ?? new FakeProvider(actions);
  const store = new RunStore(options.path ?? ':memory:', config.limits.idleTtlMs);
  const app = await createApp({ config, provider, store, gatewayKey: 'test-key', logLevel: 'silent', laya: options.laya });
  return { app, provider, store };
}
export function continueWith(request: any, response: any, result = 'tool-result') {
  const message = response.choices[0].message;
  return { ...request, messages: [...request.messages, message, ...message.tool_calls.map((c: any) => ({ role: 'tool', tool_call_id: c.id, content: result }))] };
}
