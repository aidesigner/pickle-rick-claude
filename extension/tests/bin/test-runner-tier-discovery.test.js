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

function writeSerialManifest(root, content) {
  const manifestPath = path.join(root, 'tests', 'integration', '.serial-tests.json');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(content, null, 2));
}

function runRunner(root, args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
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
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '1' },
    })), [
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

test('manifest include mode selects only listed integration files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');
    writeFixtureTest(root, 'tests/integration/b.test.js', 'integration');
    writeSerialManifest(root, { entries: ['tests/integration/b.test.js'] });

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'include',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stdoutLines(result), ['tests/integration/b.test.js']);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('manifest exclude mode removes listed integration files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');
    writeFixtureTest(root, 'tests/integration/b.test.js', 'integration');
    writeSerialManifest(root, { entries: ['tests/integration/b.test.js'] });

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'exclude',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stdoutLines(result), ['tests/integration/a.test.js']);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('manifest path is required for manifest mode', () => {
  const root = makeFixtureRoot();
  try {
    const result = runRunner(root, ['--tier', 'integration', '--manifest-mode', 'include']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--manifest and --manifest-mode must be provided together/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('missing manifest fails loudly', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'include',
      '--dry-run',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Manifest not found: tests\/integration\/\.serial-tests\.json/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('quarantine retains expensive tier files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/expensive-quarantined.test.js', 'expensive');
    writeQuarantine(root, '- tests/expensive-quarantined.test.js\n');

    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '1' },
    })), [
      'tests/expensive-quarantined.test.js',
    ]);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('expensive tier is skipped unless RUN_EXPENSIVE_TESTS is set', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/expensive-a.test.js', 'expensive');

    const result = runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(stdoutLines(result), []);
    assert.match(result.stderr, /\[skipped: RUN_EXPENSIVE_TESTS unset\]/);
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

test('runner times out wedged child test process instead of hanging indefinitely', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(
      root,
      'tests/hangs.test.js',
      'fast',
      [
        "test('blocks event loop past timeout', () => {",
        '  const shared = new SharedArrayBuffer(4);',
        '  const view = new Int32Array(shared);',
        '  Atomics.wait(view, 0, 0, 60_000);',
        '});',
      ].join('\n'),
    );

    const startedAt = Date.now();
    const result = runRunner(root, ['tests/hangs.test.js'], {
      env: { PICKLE_TEST_RUNNER_TIMEOUT_MS: '200' },
    });

    assert.ok(
      result.status === 1 || /ETIMEDOUT|timed out/i.test(result.stderr),
      `expected timeout failure, got status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stderr, /ETIMEDOUT|timed out/i);
    assert.ok(Date.now() - startedAt < 10_000, 'timeout should fail fast');
  } finally {
    cleanupFixtureRoot(root);
  }
});
