import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.RUN_DOCKER_SMOKE !== '1') throw new Error('Set RUN_DOCKER_SMOKE=1; builds images, starts isolated containers and consumes a greeting request.');
if (!process.env.GATEWAY_API_KEY) throw new Error('GATEWAY_API_KEY is required.');
const suffix = randomUUID().slice(0, 8); const network = 'openswarm-smoke-' + suffix;
const laya = network + '-laya', gateway = network + '-gateway';
const report = { timestamp: new Date().toISOString(), imageBuild: false, layaReady: false, gatewayReady: false, inference: false, cachedCheckpoint: Boolean(process.env.DOCKER_HF_CACHE), error: undefined };
async function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const collect = data => { output = (output + data).slice(-6000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(`Docker ${args[0]} failed (${code}): ${output}`)); });
  });
}
async function ready(container, port, path, seconds, auth = false) {
  for (let i = 0; i < seconds; i++) {
    try {
      const url = `http://127.0.0.1:${port}${path}`;
      const headers = auth && process.env.LAYA_API_KEY ? { Authorization: 'Bearer ' + process.env.LAYA_API_KEY } : {};
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.ok) { const value = await response.json(); if (!auth || value.loaded?.includes('multilingual')) return; }
    } catch {}
    if (i % 30 === 0) console.log(`Waiting for ${container} (${i}s)`);
    await delay(1000);
  }
  throw new Error('Readiness timeout: ' + container + '\n' + await docker(['logs', '--tail', '20', container]).catch(() => 'No logs'));
}
try {
  console.log('Building Gateway and Laya images');
  await docker(['compose', '-f', 'compose.yaml', '-f', 'compose.laya.yaml', 'build'], 900000); report.imageBuild = true;
  await docker(['network', 'create', network]);
  const cache = process.env.DOCKER_HF_CACHE ? ['--mount', `type=bind,source=${resolve(process.env.DOCKER_HF_CACHE)},target=/home/laya/.cache/huggingface/hub,readonly`, '-e', 'HF_HUB_OFFLINE=1'] : [];
  await docker(['run', '-d', '--name', laya, '--network', network, '--network-alias', 'laya', '-p', '127.0.0.1:8002:8001', '-e', 'LAYA_API_KEY', ...cache, 'openswarm-gateway-laya']);
  await ready(laya, 8002, '/health', 300, true); report.layaReady = true;
  await docker(['run', '-d', '--name', gateway, '--network', network, '-p', '127.0.0.1:3001:3000', '--env-file', '.env', '--mount', `type=bind,source=${resolve('config.yaml')},target=/app/config.yaml,readonly`, '-e', 'HOST=0.0.0.0', '-e', 'PORT=3000', '-e', 'CONFIG_PATH=/app/config.yaml', '-e', 'DATABASE_PATH=/app/data/validation.sqlite', '-e', 'LAYA_BASE_URL=http://laya:8001', 'openswarm-gateway-gateway']);
  await ready(gateway, 3001, '/readyz', 60); report.gatewayReady = true;
  const response = await fetch('http://127.0.0.1:3001/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GATEWAY_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openswarm-auto', messages: [{ role: 'user', content: 'Hola, responde brevemente.' }] }), signal: AbortSignal.timeout(120000) });
  const result = await response.json(); report.inference = response.ok && result.choices?.[0]?.finish_reason === 'stop' && Boolean(result.choices[0].message.content);
  if (!report.inference) throw new Error('Container inference failed: ' + (result.error?.code ?? response.status));
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  for (const container of [gateway, laya]) await docker(['rm', '-f', container]).catch(() => {});
  await docker(['network', 'rm', network]).catch(() => {});
  await mkdir('data', { recursive: true }); await writeFile('data/docker-smoke-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
