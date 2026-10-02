import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeBenchmark, extractModule } from '../src/evaluation.js';

test('SPEC-007-EVAL: frozen development/heldout splits have distinct prompts and expected sizes', () => {
  const development = JSON.parse(readFileSync('evals/routing-development.json', 'utf8'));
  const heldout = JSON.parse(readFileSync('evals/routing-heldout.json', 'utf8'));
  assert.equal(development.length, 20); assert.equal(heldout.length, 60);
  assert.equal(new Set([...development, ...heldout].map((c: any) => c.prompt)).size, 80);
  assert.equal(heldout.filter((c: any) => c.language === 'en').length, 20);
});
test('SPEC-007-EVIDENCE: blocked/failed runs never count as solved or complete', () => {
  const summary = summarizeBenchmark([
    { mode: 'single', status: 'complete', passed: true, calls: 1, tokens: 100, durationMs: 10 },
    { mode: 'single', status: 'blocked', passed: false, calls: 1, tokens: 0, durationMs: 20 },
    { mode: 'single', status: 'complete', passed: false, calls: 1, tokens: 100, durationMs: 10 },
  ]);
  assert.equal(summary.single!.passed, 1); assert.equal(summary.single!.completed, 2); assert.equal(summary.single!.blocked, 1);
});
test('SPEC-007-RELEASE: offline metadata, MIT license and portable module extraction', () => {
  assert.match(readFileSync('LICENSE', 'utf8'), /MIT License/);
  assert.match(readFileSync('.github/workflows/ci.yml', 'utf8'), /npm run verify/);
  assert.equal(extractModule('```js\nexport function solve() {}\n```'), 'export function solve() {}');
});
