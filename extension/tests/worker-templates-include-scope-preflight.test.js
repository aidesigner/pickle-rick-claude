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

test('worker-templates: anatomy-park.md contains check-scope-diff.js scope preflight step', () => {
  assert.ok(fs.existsSync(anatomyPath), `anatomy-park.md not found at ${anatomyPath}`);
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  assert.ok(
    content.includes('check-scope-diff.js'),
    'anatomy-park.md must include check-scope-diff.js reference for scope preflight'
  );
  assert.ok(
    content.includes('--scope-json'),
    'anatomy-park.md scope preflight must use --scope-json flag'
  );
  assert.ok(
    content.includes('scope.json'),
    'anatomy-park.md must reference scope.json in preflight context'
  );
});

test('worker-templates: anatomy-park.md scope preflight instructs exit 1 to NOT commit', () => {
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  assert.ok(
    content.includes('DO NOT commit') || content.includes('do not commit'),
    'anatomy-park.md scope preflight must instruct worker NOT to commit on exit 1'
  );
});

test('worker-templates: szechuan-sauce.md contains check-scope-diff.js scope preflight step', () => {
  assert.ok(fs.existsSync(szechuanPath), `szechuan-sauce.md not found at ${szechuanPath}`);
  const content = fs.readFileSync(szechuanPath, 'utf-8');
  assert.ok(
    content.includes('check-scope-diff.js'),
    'szechuan-sauce.md must include check-scope-diff.js reference for scope preflight'
  );
  assert.ok(
    content.includes('--scope-json'),
    'szechuan-sauce.md scope preflight must use --scope-json flag'
  );
  assert.ok(
    content.includes('scope.json'),
    'szechuan-sauce.md must reference scope.json in preflight context'
  );
});

test('worker-templates: szechuan-sauce.md scope preflight instructs exit 1 to NOT commit', () => {
  const content = fs.readFileSync(szechuanPath, 'utf-8');
  assert.ok(
    content.includes('DO NOT commit') || content.includes('do not commit'),
    'szechuan-sauce.md scope preflight must instruct worker NOT to commit on exit 1'
  );
});

test('worker-templates: anatomy-park.md scope preflight is in Phase 2 Fix section', () => {
  const content = fs.readFileSync(anatomyPath, 'utf-8');
  const phase2Idx = content.indexOf('#### PHASE 2: FIX');
  const phase25Idx = content.indexOf('#### PHASE 2.5');
  const preflightIdx = content.indexOf('check-scope-diff.js');
  assert.ok(phase2Idx !== -1, 'PHASE 2: FIX section must exist');
  assert.ok(phase25Idx !== -1, 'PHASE 2.5 section must exist');
  assert.ok(
    preflightIdx > phase2Idx && preflightIdx < phase25Idx,
    'check-scope-diff.js reference must appear between Phase 2 Fix and Phase 2.5'
  );
});
