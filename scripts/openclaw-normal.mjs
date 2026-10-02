import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
if (process.env.RUN_LIVE_SMOKE !== '1') throw new Error('Set RUN_LIVE_SMOKE=1; this test uses your normal OpenClaw agent configuration and consumes provider quota.');
const message = process.env.SMOKE_MESSAGE ?? 'Hola, ¿qué puedes hacer conmigo? Responde brevemente sin ejecutar herramientas.';
const started = Date.now();
const child = spawn('openclaw', ['agent', '--agent', 'main', '--model', 'openswarm/openswarm-auto', '--session-id', randomUUID(), '--message', message, '--json', '--timeout', '120'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; if (stdout.length > 4 * 1024 * 1024) child.kill('SIGTERM'); });
child.stderr.on('data', data => { stderr += data; if (stderr.length > 1024 * 1024) child.kill('SIGTERM'); });
const deadline = setTimeout(() => child.kill('SIGTERM'), 130000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', async code => {
  clearTimeout(deadline);
  await mkdir('data', { recursive: true });
  let result;
  try { result = JSON.parse(stdout); } catch { result = null; }
  const record = { timestamp: new Date().toISOString(), code, durationMs: Date.now() - started, result, stderr, stdout: result ? undefined : stdout };
  await writeFile('data/openclaw-normal-result.json', JSON.stringify(record, null, 2), { mode: 0o600 });
  const payloads = result?.payloads ?? result?.result?.payloads ?? [];
  const text = payloads.map(p => p.text ?? '').join('');
  const error = payloads.some(p => p.isError) || result?.isError || result?.meta?.aborted || result?.meta?.stopReason === 'error';
  const ok = code === 0 && text.length > 0 && !error;
  console.log(JSON.stringify({ ok, code, durationMs: record.durationMs, responseCharacters: text.length, evidence: 'data/openclaw-normal-result.json' }));
  process.exitCode = ok ? 0 : 1;
});
