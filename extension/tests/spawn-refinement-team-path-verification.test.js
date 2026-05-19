// @tier: fast
// AC-TAQ-01, AC-TAQ-01-2, AC-TAQ-01-3 — Path verification gate in analyst prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_REFINEMENT_TS = path.resolve(__dirname, '../src/bin/spawn-refinement-team.ts');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const {
  buildWorkerPrompt,
  checkAnalystOutputPaths,
} = await import('../bin/spawn-refinement-team.js');

// AC-TAQ-01: lint — grep -c "git ls-files" ≥ 1
test('AC-TAQ-01: spawn-refinement-team source contains git ls-files verification', () => {
  const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
  const count = (content.match(/git ls-files/g) || []).length;
  assert.ok(count >= 1, `expected ≥1 occurrence of "git ls-files" in source, got ${count}`);
});

// AC-TAQ-01-2: each literal substring appears exactly once in the rendered analyst prompt body
test('AC-TAQ-01-2: rendered analyst prompt contains git ls-files exactly once', () => {
  const prompt = buildWorkerPrompt('codebase', '# Test PRD\n', '/tmp/output.md', '/tmp', 1);
  const count = (prompt.match(/git ls-files/g) || []).length;
  assert.strictEqual(count, 1, `expected exactly 1 "git ls-files" in rendered prompt, got ${count}`);
});

test('AC-TAQ-01-2: rendered analyst prompt contains forward-created at least once', () => {
  const prompt = buildWorkerPrompt('codebase', '# Test PRD\n', '/tmp/output.md', '/tmp', 1);
  const count = (prompt.match(/forward-created/g) || []).length;
  // R-RTRC-7 annotation guidance expanded to multiple references when the canonical
  // schema (forward-created / created by ticket / introduced by ticket) was rolled in.
  // The contract that matters is "forward-created appears in the rendered prompt";
  // multiple mentions are a feature, not a regression.
  assert.ok(count >= 1, `expected at least 1 "forward-created" in rendered prompt, got ${count}`);
});

test('AC-TAQ-01-2: rendered analyst prompt contains path verification rule', () => {
  const prompt = buildWorkerPrompt('codebase', '# Test PRD\n', '/tmp/output.md', '/tmp', 1);
  const hasRule = prompt.includes('MUST be verified') || prompt.includes('must be verified');
  assert.ok(hasRule, 'rendered prompt must contain path verification rule ("must be verified")');
});

// AC-TAQ-01-3: fixture analyst output citing a non-existent path without annotation → path_not_verified
test('AC-TAQ-01-3: unclaimed non-existent path produces path_not_verified warning', () => {
  const fixture = '`extension/src/totally-nonexistent-xyz-9cdf481a.ts` cited without annotation.';
  const warnings = checkAnalystOutputPaths(fixture, PROJECT_ROOT);
  assert.ok(warnings.length >= 1, 'expected at least one path_not_verified warning');
  const w = warnings.find(x => x.path === 'extension/src/totally-nonexistent-xyz-9cdf481a.ts');
  assert.ok(w, 'expected path_not_verified warning for the fixture nonexistent path');
  assert.strictEqual(w.type, 'path_not_verified');
});

test('AC-TAQ-01-3: (forward-created) annotation suppresses path_not_verified warning', () => {
  const fixture = '`extension/src/totally-nonexistent-xyz-9cdf481a.ts` (forward-created) see sibling ticket.';
  const warnings = checkAnalystOutputPaths(fixture, PROJECT_ROOT);
  const w = warnings.find(x => x.path === 'extension/src/totally-nonexistent-xyz-9cdf481a.ts');
  assert.ok(!w, 'expected no path_not_verified warning when (forward-created) annotation is present');
});

test('AC-TAQ-01-3: canonical created-by-ticket annotation suppresses path_not_verified warning', () => {
  const fixture = '`extension/src/totally-nonexistent-xyz-9cdf481a.ts` (created by ticket abcd1234) see sibling ticket.';
  const warnings = checkAnalystOutputPaths(fixture, PROJECT_ROOT);
  const w = warnings.find(x => x.path === 'extension/src/totally-nonexistent-xyz-9cdf481a.ts');
  assert.ok(!w, 'expected no path_not_verified warning when canonical created-by-ticket annotation is present');
});

test('AC-TAQ-01-3: malformed created-by-ticket hash does not suppress path_not_verified warning', () => {
  const fixture = '`extension/src/totally-nonexistent-xyz-9cdf481a.ts` (created by ticket abc) malformed sibling ticket.';
  const warnings = checkAnalystOutputPaths(fixture, PROJECT_ROOT);
  const w = warnings.find(x => x.path === 'extension/src/totally-nonexistent-xyz-9cdf481a.ts');
  assert.ok(w, 'expected malformed created-by-ticket annotation to preserve path_not_verified warning');
  assert.strictEqual(w.type, 'path_not_verified');
});
