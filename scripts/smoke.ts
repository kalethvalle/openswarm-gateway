import 'dotenv/config';
import OpenAI from 'openai';

if (process.env.RUN_LIVE_SMOKE !== '1') {
  console.error('Live smoke is opt-in and consumes provider quota or credits. Start the gateway, then set RUN_LIVE_SMOKE=1.');
  process.exitCode = 1;
} else {
  if (!process.env.GATEWAY_API_KEY) throw new Error('GATEWAY_API_KEY is required.');
  const client = new OpenAI({ baseURL: process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:3000/v1', apiKey: process.env.GATEWAY_API_KEY, maxRetries: 0, timeout: 310_000 });
  const models = await client.models.list();
  if (!models.data.some(m => m.id === 'openswarm-auto')) throw new Error('Virtual model missing.');
  const stream = await client.chat.completions.create({ model: 'openswarm-auto', messages: [{ role: 'user', content: 'Reply with a short greeting.' }], stream: true, stream_options: { include_usage: true } });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta.content;
    if (text) process.stdout.write(text);
  }
  process.stdout.write('\n');
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Use the supplied echo tool with text "smoke" and report its result.' }];
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{ type: 'function', function: { name: 'echo', description: 'Return the supplied text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
  for (let round = 0; round < 12; round++) {
    const response = await client.chat.completions.create({ model: 'openswarm-auto', messages, tools, ...(round === 0 ? { tool_choice: { type: 'function' as const, function: { name: 'echo' } } } : {}) });
    const message = response.choices[0]!.message;
    messages.push(message);
    if (!message.tool_calls?.length) { console.log(message.content); console.log('Live smoke completed.'); break; }
    for (const call of message.tool_calls) {
      if (call.type !== 'function' || call.function.name !== 'echo') throw new Error('Unexpected tool requested.');
      const args = JSON.parse(call.function.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(args.text) });
    }
    if (round === 11) throw new Error('Live smoke exceeded the tool round limit.');
  }
}
