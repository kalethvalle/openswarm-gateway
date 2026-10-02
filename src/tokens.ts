import { getEncoding } from 'js-tiktoken';
import type { ProviderInput } from './types.js';

let encoder: ReturnType<typeof getEncoding> | undefined;
export function estimateInputTokens(input: ProviderInput): { tokens: number; bytes: number } {
  const payload = JSON.stringify({ messages: input.messages, tools: input.tools, response_format: input.response_format });
  encoder ??= getEncoding('o200k_base');
  // A budgeting estimate, not the provider's exact chat template/tokenizer.
  // Treat special-token strings as ordinary user text. Settle against real usage.
  const tokens = Math.ceil(encoder.encode(payload, [], []).length * 1.2) + input.messages.length * 16 + 256;
  return { tokens, bytes: Buffer.byteLength(payload, 'utf8') };
}
