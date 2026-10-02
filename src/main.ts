import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { OpenRouterAdapter } from './provider.js';
import { GroqAdapter } from './groq.js';
import { RunStore } from './store.js';

let store: RunStore | undefined;
try {
  const config = loadConfig(process.env.CONFIG_PATH ?? 'config.yaml');
  const keyName = config.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY';
  const apiKey = process.env[keyName];
  const gatewayKey = process.env.GATEWAY_API_KEY;
  if (!apiKey?.trim() || !gatewayKey) throw new Error(`${keyName} and GATEWAY_API_KEY must be set.`);
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  store = new RunStore(process.env.DATABASE_PATH ?? (config.provider === 'groq' ? 'data/openswarm-groq.sqlite' : 'data/openswarm.sqlite'), config.limits.idleTtlMs);
  const provider = config.provider === 'groq' ? new GroqAdapter(apiKey) : new OpenRouterAdapter(apiKey);
  const app = await createApp({ config, provider, store, gatewayKey, logLevel: process.env.LOG_LEVEL });
  app.log.info({ provider: config.provider, plannerModel: config.plannerModel }, 'Provider configured');
  const stop = async () => { await app.close(); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  store?.close();
  console.error('OpenSwarm startup failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
