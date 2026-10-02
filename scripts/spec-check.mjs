import { readdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
const root = resolve('specs');
const entries = (await readdir(root)).filter(name => /^\d{3}-/.test(name));
const specs = new Map();
const errors = [];
for (const directory of entries) {
  const path = resolve(root, directory);
  try {
    const content = await readFile(resolve(path, 'spec.md'), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
    if (!match) throw new Error('Missing YAML front matter');
    const metadata = parse(match[1]);
    if (!/^SPEC-\d{3}$/.test(metadata.id) || metadata.id.slice(-3) !== directory.slice(0, 3) || specs.has(metadata.id)) throw new Error('Invalid or duplicate spec ID');
    if (!Number.isInteger(metadata.revision) || metadata.revision < 1 || !['draft', 'ready', 'in_progress', 'validated', 'superseded'].includes(metadata.status)) throw new Error('Invalid revision/status');
    if (!Array.isArray(metadata.depends_on) || !Array.isArray(metadata.tests)) throw new Error('Missing dependencies/tests');
    const requirements = [...content.matchAll(/\*\*(SPEC-\d{3}-[A-Z][A-Z0-9_-]*)\*\*/g)].map(m => m[1]);
    if (!requirements.length || new Set(requirements).size !== requirements.length || requirements.some(id => !id.startsWith(metadata.id + '-'))) throw new Error('Missing/duplicate/foreign requirement IDs');
    for (const name of ['plan.md', 'tasks.md', 'validation.md']) await access(resolve(path, name));
    let tests = '';
    for (const test of metadata.tests) {
      if (!/^test\/[a-z0-9-]+\.test\.ts$/.test(test)) throw new Error('Invalid test path');
      tests += await readFile(resolve(test), 'utf8');
    }
    for (const id of requirements) if (!tests.includes(id)) throw new Error('Requirement has no test reference: ' + id);
    const validation = await readFile(resolve(path, 'validation.md'), 'utf8');
    if (metadata.status === 'validated') {
      if (/^- \[ \]/m.test(await readFile(resolve(path, 'tasks.md'), 'utf8'))) throw new Error('Validated spec has unfinished tasks');
      if (!/## Evidencia/.test(validation) || requirements.some(id => !validation.includes(id))) throw new Error('Validated spec lacks requirement evidence');
    }
    specs.set(metadata.id, metadata);
  } catch (error) { errors.push(directory + ': ' + error.message); }
}
function visit(id, chain = []) {
  if (chain.includes(id)) { errors.push('Dependency cycle: ' + [...chain, id].join(' -> ')); return; }
  const spec = specs.get(id);
  if (!spec) { errors.push('Unknown dependency: ' + id); return; }
  for (const dependency of spec.depends_on) visit(dependency, [...chain, id]);
}
for (const id of specs.keys()) visit(id);
if (errors.length) { for (const error of new Set(errors)) console.error(error); process.exitCode = 1; }
else console.log(`Validated structure and traceability for ${specs.size} specifications. Execution evidence must still be reviewed.`);
