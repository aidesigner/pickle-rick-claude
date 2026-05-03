// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');

function makeFixtureRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'test-runner-tier-'));
}

function cleanupFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeFixtureTest(root, relativePath, tier, body = '') {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `// @tier: ${tier}\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body || "test('fixture', () => assert.equal(1, 1));"}\n`,
  );
}

function writeQuarantine(root, content) {
  const manifestPath = path.join(root, 'tests', 'QUARANTINE.md');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, content);
}

function runRunner(root, args, options = {}) {
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function stdoutLines(result) {
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

test('discovery walks all tagged test tiers', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/fast-a.test.js', 'fast');
    writeFixtureTest(root, 'tests/integration/integration-a.test.js', 'integration');
    writeFixtureTest(root, 'tests/expensive-a.test.js', 'expensive');
    writeFixtureTest(root, 'tests/contracts/contract-a.test.js', 'contract');

    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'fast', '--dry-run'])), [
      'tests/fast-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'integration', '--dry-run'])), [
      'tests/integration/integration-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'])), [
      'tests/expensive-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'contract', '--dry-run'])), [
      'tests/contracts/contract-a.test.js',
    ]);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('quarantine excludes fast and integration tier files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/fast-keep.test.js', 'fast');
    writeFixtureTest(root, 'tests/fast-quarantined.test.js', 'fast');
    writeFixtureTest(root, 'tests/integration/integration-quarantined.test.js', 'integration');
    writeQuarantine(root, [
      '# Quarantine',
      '- tests/fast-quarantined.test.js',
      '- `tests/integration/integration-quarantined.test.js`',
      '',
    ].join('\n'));

    const fastFiles = stdoutLines(runRunner(root, ['--tier', 'fast', '--dry-run']));
    assert.deepEqual(fastFiles, ['tests/fast-keep.test.js']);

    const integration = runRunner(root, ['--tier', 'integration', '--dry-run']);
    assert.equal(integration.status, 0);
    assert.deepEqual(stdoutLines(integration), []);
    assert.match(integration.stderr, /\[no files for tier integration\]/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('quarantine retains expensive tier files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/expensive-quarantined.test.js', 'expensive');
    writeQuarantine(root, '- tests/expensive-quarantined.test.js\n');

    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'])), [
      'tests/expensive-quarantined.test.js',
    ]);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('invalid tier exits 2', () => {
  const root = makeFixtureRoot();
  try {
    const result = runRunner(root, ['--tier', 'bogus']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown tier: bogus/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('positional argv behavior still runs the selected file', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(
      root,
      'tests/positional.test.js',
      'fast',
      [
        "test('positional fixture', () => {",
        "  assert.equal(process.env.TEST_RUNNER_POSITIONAL, '1');",
        '});',
      ].join('\n'),
    );
    writeFixtureTest(
      root,
      'tests/unselected.test.js',
      'fast',
      "test('unselected fixture', () => assert.fail('unselected test should not run'));",
    );

    const result = runRunner(root, ['tests/positional.test.js'], {
      env: { TEST_RUNNER_POSITIONAL: '1' },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    cleanupFixtureRoot(root);
  }
});
