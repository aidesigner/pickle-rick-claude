// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const anatomyPath = path.join(repoRoot, '.claude', 'commands', 'anatomy-park.md');
const szechuanPath = path.join(repoRoot, '.claude', 'commands', 'szechuan-sauce.md');
const statusSrcPath = path.join(repoRoot, 'extension', 'src', 'bin', 'status.ts');

test('scope-preflight-ordering: anatomy-park.md contains literal check-scope-diff.js invocation', () => {
  assert.ok(fs.existsSync(anatomyPath), `anatomy-park.md not found at ${anatomyPath}`);
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  assert.ok(
    content.includes('node "$HOME/.claude/pickle-rick/extension/bin/check-scope-diff.js"'),
    'anatomy-park.md must contain the literal check-scope-diff.js invocation'
  );
});

test('scope-preflight-ordering: anatomy-park.md step 4 tests → preflight → git commit ordering', () => {
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  const orderingRe = /4\.\s+\*\*Run the full test suite\*\*[\s\S]*?check-scope-diff\.js[\s\S]*?git commit/;
  assert.ok(
    orderingRe.test(content),
    'anatomy-park.md must match ordering: step 4 test-suite anchor → check-scope-diff.js → git commit'
  );
});

test('scope-preflight-ordering: anatomy-park.md no git commit before check-scope-diff.js after step-4 anchor', () => {
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  const step4Anchor = '4. **Run the full test suite**';
  const step4Idx = content.indexOf(step4Anchor);
  assert.ok(step4Idx !== -1, 'step-4 anchor must exist in anatomy-park.md');
  const afterStep4 = content.slice(step4Idx);
  const preflightIdx = afterStep4.indexOf('check-scope-diff.js');
  assert.ok(preflightIdx !== -1, 'check-scope-diff.js must appear after step-4 anchor');
  const firstCommitIdx = afterStep4.indexOf('git commit');
  assert.ok(firstCommitIdx !== -1, 'git commit must appear after step-4 anchor');
  assert.ok(
    firstCommitIdx > preflightIdx,
    'git commit must not appear before check-scope-diff.js after the step-4 anchor'
  );
});

test('scope-preflight-ordering: szechuan-sauce.md Scope preflight → check-scope-diff.js → Exit 0: proceed with commit ordering', () => {
  assert.ok(fs.existsSync(szechuanPath), `szechuan-sauce.md not found at ${szechuanPath}`);
  const content = fs.readFileSync(szechuanPath, 'utf-8');
  assert.ok(
    content.includes('node "$HOME/.claude/pickle-rick/extension/bin/check-scope-diff.js"'),
    'szechuan-sauce.md must contain the literal check-scope-diff.js invocation'
  );
  const orderingRe = /Scope preflight[\s\S]*?check-scope-diff\.js[\s\S]*?Exit 0\*\*:\s*proceed with commit/;
  assert.ok(
    orderingRe.test(content),
    "szechuan-sauce.md must match ordering: 'Scope preflight' heading → check-scope-diff.js → 'Exit 0**: proceed with commit'"
  );
});

test('scope-preflight-ordering: status.ts renderScopeDrift uses single console.log with exact contract string', () => {
  assert.ok(fs.existsSync(statusSrcPath), `status.ts not found at ${statusSrcPath}`);
  const content = fs.readFileSync(statusSrcPath, 'utf-8');

  const driftLogRe = /console\.log\(`Scope drift:/g;
  const matches = [...content.matchAll(driftLogRe)];
  assert.strictEqual(
    matches.length,
    1,
    'status.ts must have exactly one console.log(`Scope drift: ...) emission site'
  );

  const contractRe = /console\.log\(`Scope drift: \$\{driftEvents\.length\} edit\(s\) outside scope\.json — tickets: \$\{/;
  assert.ok(
    contractRe.test(content),
    'status.ts renderScopeDrift must use the exact emission pattern: console.log(`Scope drift: ${driftEvents.length} edit(s) outside scope.json — tickets: ${...}`)'
  );
});
