// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_PATH = path.resolve(__dirname, '..', 'CLAUDE.md');
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

const REQUIRED_TRAP_DOOR_ENTRY_SUBSTRINGS = [
  '`src/bin/mux-runner.ts` (state-iteration write)',
  'ENFORCE: extension/tests/mux-runner-state-iteration.test.js',
  'PATTERN_SHAPE: `state.iteration = iteration`',
  '`src/bin/pipeline-runner.ts` (phase-step write)',
  'ENFORCE: extension/tests/integration/pipeline-state-coherence.test.js',
  "PATTERN_SHAPE: `state.step = '<phase>'`",
  '`src/services/pickle-utils.ts` (getExtensionRoot validation)',
  'ENFORCE: extension/tests/get-extension-root-fallback.test.js',
  'PATTERN_SHAPE: `extensionRootSentinelExists`',
];

const UNREGISTERED_TEST_ALLOWLIST = new Set([
  'tests/audit-test-isolation-fixture.test.js',
  'tests/bin/check-gate.test.js',
  'tests/bin/finalize-gate.test.js',
  'tests/bin/spawn-gate-remediator.test.js',
  'tests/bin/test-runner-tier-discovery.test.js',
  'tests/integration/anatomy-park-baseline-gate.test.js',
  'tests/integration/anatomy-park-scoped-final-gate.test.js',
  'tests/integration/anatomy-park-stall-limit.test.js',
  'tests/integration/concurrent-gate-remediation.test.js',
  'tests/integration/extension-wiring.test.js',
  'tests/integration/gate-cycle-escalation.test.js',
  'tests/integration/szechuan-strict-gate.test.js',
  'tests/services/pickle-utils-iso-compact-stamp.test.js',
  'tests/skill-prompts/anatomy-park-gate-integration.test.js',
  'tests/skill-prompts/szechuan-sauce-gate-integration.test.js',
]);

function discoverTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return discoverTestFiles(fullPath);
      if (!entry.name.endsWith('.test.js')) return [];
      return [path.relative(path.resolve(__dirname, '..'), fullPath)];
    })
    .sort();
}

function readPackageJson() {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8'));
}

function discoverTier(tier) {
  const result = spawnSync(process.execPath, ['bin/test-runner.js', '--tier', tier, '--dry-run'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    env: { ...process.env, RUN_EXPENSIVE_TESTS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(p => path.normalize(p));
}

test('no test file is silently unregistered', () => {
  const onDisk = discoverTestFiles(__dirname);

  const registeredSet = new Set(
    ['fast', 'integration', 'expensive', 'contract'].flatMap(discoverTier),
  );

  const missing = onDisk.filter(f => !registeredSet.has(f) && !UNREGISTERED_TEST_ALLOWLIST.has(f));
  assert.deepStrictEqual(
    missing,
    [],
    `Unregistered test files (add to package.json scripts.test): ${missing.join(', ')}`,
  );
});

test('package test scripts delegate to tier discovery', () => {
  const pkg = readPackageJson();

  assert.equal(pkg.scripts.test, 'npm run test:fast && npm run test:integration');
  assert.equal(pkg.scripts['pretest:fast'], 'bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh');
  assert.equal(pkg.scripts['test:fast'], 'node bin/test-runner.js --tier fast');
  assert.equal(pkg.scripts['test:integration'], 'node bin/test-runner.js --tier integration');
  assert.equal(pkg.scripts['test:expensive'], 'node bin/test-runner.js --tier expensive');
});

test('PSD-T9 trap-door catalog entries are present', () => {
  const claude = readFileSync(CLAUDE_PATH, 'utf8');

  for (const expected of REQUIRED_TRAP_DOOR_ENTRY_SUBSTRINGS) {
    assert.ok(claude.includes(expected), `missing CLAUDE.md trap-door text: ${expected}`);
  }
});
