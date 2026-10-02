import Fastify, { LogController } from 'fastify';
import type { FastifyReply } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { asGatewayError, errorBody, GatewayError } from './errors.js';
import { Orchestrator } from './orchestrator.js';
import { ModelRunner } from './runner.js';
import { RunStore } from './store.js';
import type { Completion, ProviderAdapter } from './types.js';
import { validateRequest } from './validation.js';
import { LayaRouter } from './laya.js';

class SSEWriter {
  started = false;
  private roleSent = false;
  private hasText = false;
  constructor(private reply: FastifyReply, private identity: { id: string; created: number }, private includeUsage: boolean, private signal: AbortSignal) {}
  private start() {
    if (this.started) return;
    this.started = true;
    this.reply.hijack();
    this.reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  }
  private async write(value: string) {
    if (this.reply.raw.destroyed) throw new DOMException('Client disconnected', 'AbortError');
    this.start();
    if (this.reply.raw.write(value)) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { this.reply.raw.off('drain', drain); this.reply.raw.off('close', close); this.reply.raw.off('error', fail); this.signal.removeEventListener('abort', abort); };
      const drain = () => { clean(); resolve(); };
      const close = () => { clean(); reject(new DOMException('Client disconnected', 'AbortError')); };
      const fail = () => { clean(); reject(new DOMException('Stream failed', 'AbortError')); };
      const abort = () => { clean(); this.reply.raw.destroy(); reject(this.signal.reason); };
      this.reply.raw.once('drain', drain); this.reply.raw.once('close', close); this.reply.raw.once('error', fail);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }
  async heartbeat() { if (!this.reply.raw.writableNeedDrain) await this.write(': openswarm processing\n\n'); }
  private async chunk(delta: unknown, finish_reason: string | null = null) {
    await this.write(`data: ${JSON.stringify({ ...this.identity, object: 'chat.completion.chunk', model: 'openswarm-auto', choices: [{ index: 0, delta, finish_reason }], ...(this.includeUsage ? { usage: null } : {}) })}\n\n`);
  }
  private async role() { if (!this.roleSent) { this.roleSent = true; await this.chunk({ role: 'assistant', content: '' }); } }
  async text(text: string) { await this.role(); this.hasText = true; await this.chunk({ content: text }); }
  async finish(response: Completion) {
    this.identity = { id: response.id, created: response.created };
    await this.role();
    const choice = response.choices[0];
    if (!this.hasText && choice.message.content) await this.text(choice.message.content);
    if (choice.message.tool_calls) await this.chunk({ tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) });
    await this.chunk({}, choice.finish_reason);
    if (this.includeUsage && response.usage) await this.write(`data: ${JSON.stringify({ ...this.identity, object: 'chat.completion.chunk', model: 'openswarm-auto', choices: [], usage: response.usage })}\n\n`);
    await this.write('data: [DONE]\n\n');
    this.reply.raw.end();
  }
  async error(error: GatewayError) {
    await this.write(`data: ${JSON.stringify(errorBody(error))}\n\n`);
    this.reply.raw.end();
  }
}

export async function createApp(options: { config: Config; provider: ProviderAdapter; store: RunStore; gatewayKey: string; logLevel?: string; laya?: LayaRouter }) {
  const { config, provider, store } = options;
  if (!options.gatewayKey) throw new Error('GATEWAY_API_KEY is required.');
  const app = Fastify({ bodyLimit: config.limits.bodyLimitBytes, logger: options.logLevel === 'silent' ? false : { level: options.logLevel ?? 'info', redact: ['req.headers.authorization'] }, logController: new LogController({ disableRequestLogging: true }) });
  const catalog = await provider.catalog(AbortSignal.timeout(config.limits.modelTimeoutMs));
  const runner = new ModelRunner(config, provider, catalog, (fields, message) => app.log.info(fields, message));
  const laya = options.laya ?? new LayaRouter({ ...config.laya, baseUrl: process.env.LAYA_BASE_URL ?? config.laya.baseUrl }, (fields, message) => app.log.info(fields, message));
  const orchestrator = new Orchestrator(runner, store, laya);
  const expectedKey = createHash('sha256').update(`Bearer ${options.gatewayKey}`).digest();
  const controllers = new Set<AbortController>();
  let closing = false;
  const cleanup = setInterval(() => { try { store.cleanup(); } catch { app.log.error('State cleanup failed'); } }, Math.min(config.limits.idleTtlMs, 60_000)).unref();
  app.addHook('preClose', async () => { closing = true; for (const controller of controllers) controller.abort(); });
  app.addHook('onClose', async () => { clearInterval(cleanup); store.close(); });
  app.addHook('onRequest', async request => {
    if (!request.url.split('?')[0]?.startsWith('/v1/')) return;
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expectedKey, supplied)) throw new GatewayError(401, 'invalid_api_key', 'A valid Gateway Bearer key is required.');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const mapped = error instanceof GatewayError ? error : status < 500 ? new GatewayError(status, 'invalid_request', 'Malformed request or request body exceeds the configured limit.') : asGatewayError(error);
    reply.code(mapped.status).send(errorBody(mapped));
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(errorBody(new GatewayError(404, 'not_found', 'Endpoint not found.'))));
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    const ready = !closing && store.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });
  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: 'openswarm-auto', object: 'model', created: 0, owned_by: 'openswarm' }] }));
  app.post('/v1/chat/completions', async (incoming, reply) => {
    if (closing) throw new GatewayError(503, 'shutting_down', 'Gateway is shutting down.');
    const request = validateRequest(incoming.body);
    const prepared = orchestrator.prepare(request);
    const identity = 'replay' in prepared ? prepared.replay : { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.limits.requestTimeoutMs)]);
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
    incoming.raw.on('aborted', disconnect);
    reply.raw.on('close', disconnect);
    const writer = request.stream ? new SSEWriter(reply, identity, Boolean(request.stream_options?.include_usage), signal) : undefined;
    const heartbeat = writer ? setInterval(() => { void writer.heartbeat().catch(() => controller.abort()); }, 15_000).unref() : undefined;
    try {
      const response = 'replay' in prepared ? prepared.replay : await orchestrator.execute(request, prepared, signal, identity, writer ? text => writer.text(text) : undefined);
      if (heartbeat) clearInterval(heartbeat);
      if (writer) { await writer.finish(response); return reply; }
      return reply.send(response);
    } catch (error) {
      const mapped = asGatewayError(error);
      app.log.warn({ requestId: incoming.id, ...('state' in prepared ? { runId: prepared.state.id, budget: prepared.state.budget } : {}), code: mapped.code, status: mapped.status }, 'Request failed');
      if (reply.raw.destroyed) return reply;
      if (writer?.started) { await writer.error(mapped).catch(() => reply.raw.destroy()); return reply; }
      if (mapped.retryAfterSeconds !== undefined) reply.header('Retry-After', String(mapped.retryAfterSeconds));
      return reply.code(mapped.status).send(errorBody(mapped));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      controllers.delete(controller);
      incoming.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
    }
  });
  return app;
}
