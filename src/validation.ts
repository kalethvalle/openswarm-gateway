import { z } from 'zod';
import { GatewayError } from './errors.js';
import type { ChatRequest } from './types.js';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const call = z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({ name, arguments: z.string() }).strict() }).strict();
const content = z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()).min(1).transform(parts => parts.map(p => p.text).join(''))]);
const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: content.nullable().optional(), name: name.optional(), tool_call_id: z.string().min(1).optional(),
  tool_calls: z.array(call).min(1).optional(),
}).strict().superRefine((m, ctx) => {
  if (m.role !== 'assistant' && typeof m.content !== 'string') ctx.addIssue({ code: 'custom', message: 'This role requires text content.' });
  if (m.role === 'assistant' && m.content == null && !m.tool_calls) ctx.addIssue({ code: 'custom', message: 'Assistant requires content or tool_calls.' });
  if ((m.role === 'tool') !== Boolean(m.tool_call_id)) ctx.addIssue({ code: 'custom', message: 'tool_call_id is required only for tool messages.' });
  if (m.tool_calls && m.role !== 'assistant') ctx.addIssue({ code: 'custom', message: 'Only assistant messages may contain tool_calls.' });
}).transform(m => ({ ...m, content: m.content ?? null }));

const requestSchema = z.object({
  model: z.literal('openswarm-auto'), messages: z.array(message).min(1), stream: z.boolean().default(false), n: z.literal(1).optional(),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({
    name, description: z.string().optional(), parameters: z.record(z.unknown()).optional(), strict: z.boolean().optional(),
  }).strict() }).strict()).min(1).max(128).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), function: z.object({ name }).strict() }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(), temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)]).nullable().optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
}).strict().superRefine((r, ctx) => {
  if (r.max_tokens && r.max_completion_tokens) ctx.addIssue({ code: 'custom', message: 'Specify only one output token limit.' });
  if (r.stream_options && !r.stream) ctx.addIssue({ code: 'custom', message: 'stream_options requires stream=true.' });
  if (!r.tools && (r.tool_choice && r.tool_choice !== 'none' || r.parallel_tool_calls !== undefined)) ctx.addIssue({ code: 'custom', message: 'Tool options require tools.' });
  const names = new Set(r.tools?.map(t => t.function.name));
  if (names.size !== (r.tools?.length ?? 0)) ctx.addIssue({ code: 'custom', message: 'Duplicate tool names.' });
  if (typeof r.tool_choice === 'object' && !names.has(r.tool_choice.function.name)) ctx.addIssue({ code: 'custom', message: 'Named tool is not declared.' });
  const pending = new Set<string>();
  const used = new Set<string>();
  for (const m of r.messages) {
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id!)) ctx.addIssue({ code: 'custom', message: 'Unknown or duplicate tool result.' });
    } else {
      if (pending.size) ctx.addIssue({ code: 'custom', message: 'All tool results must precede the next message.' });
      for (const c of m.tool_calls ?? []) {
        if (used.has(c.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate tool call ID.' });
        pending.add(c.id); used.add(c.id);
      }
    }
  }
  if (pending.size) ctx.addIssue({ code: 'custom', message: 'Missing tool results.' });
});

export function validateRequest(body: unknown): ChatRequest {
  const result = requestSchema.safeParse(body);
  if (!result.success) throw new GatewayError(400, 'invalid_request', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
