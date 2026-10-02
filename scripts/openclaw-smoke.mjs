import 'dotenv/config';
import { readFile, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

if (process.env.RUN_LIVE_SMOKE !== '1') {
  console.error('Set RUN_LIVE_SMOKE=1. This test consumes Groq quota and allows OpenClaw to create and test two files in data/openclaw-laya-smoke.');
  process.exit(1);
}
if (!process.env.GATEWAY_API_KEY) throw new Error('GATEWAY_API_KEY is required.');
const current = JSON.parse(await readFile(resolve(homedir(), '.openclaw/openclaw.json'), 'utf8'));
const provider = current.models?.providers?.openswarm;
if (!provider) throw new Error('Configure the openswarm provider in OpenClaw first.');
const root = resolve('data/openclaw-laya-smoke');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const configPath = resolve('data/openclaw-smoke.config.json');
// Dedicated test config: reuse the configured provider, store an environment reference,
// expose only the file/command tools needed for this task. Never change the ambient config.
await writeFile(configPath, JSON.stringify({
  models: { providers: { openswarm: {
    baseUrl: provider.baseUrl, api: provider.api, models: provider.models,
    timeoutSeconds: 360, apiKey: '${GATEWAY_API_KEY}',
  } } },
  agents: { defaults: { model: { primary: 'openswarm/openswarm-auto' }, models: { 'openswarm/openswarm-auto': {} }, timeoutSeconds: 360, compaction: { memoryFlush: { enabled: false } } } },
  tools: { profile: 'coding', allow: ['read', 'write', 'exec'], deny: ['apply_patch'], toolSearch: false, fs: { workspaceOnly: true } },
  skills: { allowBundled: [] },
}, null, 2) + '\n', { mode: 0o600 });
const prompt = 'Implementa una función JavaScript exportada validarTitulo(value): true solo para strings con algún carácter no vacío. Crea tasks.mjs y tasks.test.mjs con node:test y cinco casos incluyendo null y espacios. Usa una sola llamada a exec para escribir ambos archivos y ejecutar node --test tasks.test.mjs. Después realiza una revisión independiente del código y reporta el resultado real. Trabaja solo en esta carpeta y no instales dependencias.';
const child = spawn('openclaw', ['agent', 'exec', '--config', configPath, '--model', 'openswarm/openswarm-auto', '--cwd', directory, '--code-mode', 'direct', '--thinking', 'off', '--timeout', '360', '--json', prompt], { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', async code => {
  try {
    const result = JSON.parse(output);
    await writeFile(resolve('data/openclaw-smoke-result.json'), JSON.stringify({ ...result, workspace: directory }, null, 2) + '\n');
    if (code !== 0 || !result.ok || !result.toolSummary?.tools?.includes('exec')) throw new Error('OpenClaw did not complete a successful turn with an exec tool call.');
    await access(resolve(directory, 'tasks.mjs'));
    await access(resolve(directory, 'tasks.test.mjs'));
    process.exitCode = 0;
  } catch (error) {
    await writeFile(resolve('data/openclaw-smoke-output.txt'), output);
    console.error(error.message); process.exitCode = 1;
  }
});
