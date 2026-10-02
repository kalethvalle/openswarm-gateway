import { readFile, writeFile, copyFile, constants } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
const path = process.argv[2] ?? 'config.yaml';
const old = parse(await readFile(path, 'utf8'));
if (old.version === 2) { console.log('Configuration is already v2.'); process.exit(0); }
if (old.provider !== 'groq') throw new Error('Automatic migration supports the existing Groq profile. For OpenRouter, define explicit :free models using config.example.yaml.');
const next = parse(await readFile('config.example.yaml', 'utf8'));
const ids = new Set(next.models.map(m => m.id));
if (!old.models.every(m => ids.has(m.id))) throw new Error('Custom models require explicit v2 provider/capability mapping. Original file was not changed.');
next.limits = { ...next.limits, ...old.limits, rateLimitRetries: 0 };
next.laya = { ...next.laya, ...old.laya, maxInputChars: 24000 };
const backup = path.replace(/\.yaml$/, '') + '.v1.backup.yaml';
await copyFile(path, backup, constants.COPYFILE_EXCL);
await writeFile(path, stringify(next));
console.log(`Migrated ${path}; original saved to ${backup}. Restart the gateway to load v2.`);
