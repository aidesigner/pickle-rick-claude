// @tier: expensive
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const CLAUDE_PATH = path.join(REPO_ROOT, 'CLAUDE.md');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const GATE = [
  'npx tsc --noEmit',
  'npx eslint src/ --max-warnings=-1',
  'npx tsc',
  'bash scripts/audit-test-tiers.sh',
  'bash scripts/audit-test-isolation.sh',
  'bash scripts/audit-subprocess-heavy-tests.sh',
  'bash scripts/audit-fix-commits.sh',
  'bash scripts/audit-bundle-thesis.sh',
  'bash scripts/audit-quarantine.sh',
  'bash scripts/audit-trap-door-enforcement.sh',
  'bash scripts/audit-guarded-reset.sh',
  'bash scripts/audit-design-ground-truth.sh',
  'npm run test:fast:budget',
  'npm run test:integration',
  'RUN_EXPENSIVE_TESTS=1 npm run test:expensive',
].join(' && ');

const FULL_CMD = `cd extension && npm ci && ${GATE}`;

function extractClaudeGate(text) {
  const line = text.split(/\r?\n/).find(l => l.startsWith('cd extension &&'));
  assert.ok(line, 'CLAUDE.md: no line starting with "cd extension &&" in Build & Test section');
  return line;
}

function extractWorkflowRun(text) {
  const line = text.split(/\r?\n/).find(l => /^\s*run:\s*cd extension &&/.test(l));
  assert.ok(line, 'workflow: no "run: cd extension &&" line found');
  return line.replace(/^\s*run:\s*/, '');
}

test('gate command parity across CLAUDE.md, release.yml, and ci.yml', () => {
  const claudeGate = extractClaudeGate(readFileSync(CLAUDE_PATH, 'utf8'));
  const releaseRun = extractWorkflowRun(readFileSync(RELEASE_WORKFLOW, 'utf8'));
  const ciRun = extractWorkflowRun(readFileSync(CI_WORKFLOW, 'utf8'));

  assert.equal(claudeGate, FULL_CMD, 'CLAUDE.md Build&Test gate does not match canonical');
  assert.equal(releaseRun, FULL_CMD, 'release.yml gate does not match canonical');
  assert.equal(ciRun, FULL_CMD, 'ci.yml gate does not match canonical');
});

test('check-wired.sh exits 0', () => {
  const result = spawnSync('bash', ['scripts/check-wired.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `check-wired.sh failed:\n${result.stderr}`);
});

// AC-R-ITIH-4 / B-V2RG: hang-guard, NOT a perf-assertion. This test nests the
// ENTIRE gate (fast+integration+expensive) as a subprocess; corpus growth pushed
// the nested run to ~25min, so the prior 20-min budget timed it out deterministically.
// Raised to 40min to stay a genuine hang-guard above legitimate nested-gate runtime.
// Never shrunk. (The nested expensive tier is now serial-split so C0 no longer starves.)
test('full gate exits 0 against HEAD', { timeout: 40 * 60 * 1000 }, () => {
  // Guard against infinite recursion: if this test is already running inside
  // the gate subprocess, bail out immediately.
  if (process.env.RELEASE_GATE_WIRING_ACTIVE === '1') return;

  const result = spawnSync('bash', ['-c', FULL_CMD], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_GATE_WIRING_ACTIVE: '1', RUN_EXPENSIVE_TESTS: '1' },
    timeout: 40 * 60 * 1000,
  });
  assert.equal(
    result.status,
    0,
    `Full gate failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
  );
});
