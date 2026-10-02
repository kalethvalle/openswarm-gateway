import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const executable = new URL('../.venv-laya/bin/laya-serve', import.meta.url);
if (!existsSync(executable)) {
  console.error('Install the local classifier: uv venv --python 3.11 .venv-laya && uv pip install --python .venv-laya/bin/python -r requirements-laya.txt');
  process.exit(1);
}
const child = spawn(executable.pathname, [], { stdio: 'inherit', env: {
  ...process.env, LAYA_HOST: process.env.LAYA_HOST ?? '127.0.0.1', LAYA_PORT: process.env.LAYA_PORT ?? '8001',
  LAYA_MODELS: 'multilingual', LAYA_DEFAULT_MODEL: 'multilingual', LAYA_PRELOAD: '1',
  LAYA_THREADS: process.env.LAYA_THREADS ?? '2', LAYA_DEVICE: process.env.LAYA_DEVICE ?? 'cpu',
  LAYA_MAX_CONCURRENT: '2', LAYA_REVISION: process.env.LAYA_REVISION ?? 'reviewed',
} });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Could not start Laya.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
