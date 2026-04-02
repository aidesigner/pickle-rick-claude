import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'init-microverse.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'init-microverse-'));
}

function run(args, expectError = false) {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 };
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], opts);
    return { code: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    if (!expectError) throw err;
    return {
      code: err.status,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function readMicroverse(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('init-microverse convergence flags', () => {
  test('--convergence-mode worker --convergence-file ap.json produces correct microverse.json', () => {
    const dir = makeTempDir();
    try {
      run([dir, '/some/target', '--convergence-mode', 'worker', '--convergence-file', 'ap.json']);
      const state = readMicroverse(dir);
      assert.equal(state.convergence_mode, 'worker');
      assert.equal(state.convergence_file, 'ap.json');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('--convergence-mode metric without --convergence-file succeeds', () => {
    const dir = makeTempDir();
    try {
      run([dir, '/some/target', '--convergence-mode', 'metric']);
      const state = readMicroverse(dir);
      assert.equal(state.convergence_mode, 'metric');
      assert.equal(state.convergence_file, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('default: no convergence flags produces no convergence_mode field', () => {
    const dir = makeTempDir();
    try {
      run([dir, '/some/target']);
      const state = readMicroverse(dir);
      assert.equal(state.convergence_mode, undefined);
      assert.equal(state.convergence_file, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------------------

  test('--convergence-mode worker without --convergence-file exits with error', () => {
    const result = run([makeTempDir(), '/some/target', '--convergence-mode', 'worker'], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('worker mode requires --convergence-file'));
  });

  test('--convergence-file with path traversal (../) exits with error', () => {
    const result = run([makeTempDir(), '/some/target', '--convergence-file', '../../etc/passwd'], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('convergence_file must be a bare filename'));
  });

  test('--convergence-file with forward slash exits with error', () => {
    const result = run([makeTempDir(), '/some/target', '--convergence-file', 'sub/dir.json'], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('convergence_file must be a bare filename'));
  });

  test('--convergence-file with backslash exits with error', () => {
    const result = run([makeTempDir(), '/some/target', '--convergence-file', 'sub\\dir.json'], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('convergence_file must be a bare filename'));
  });

  test('type: none without --convergence-mode worker exits with error', () => {
    const metricJson = JSON.stringify({ type: 'none', description: 'n/a', validation: 'n/a', timeout_seconds: 60, tolerance: 0, direction: 'lower' });
    const result = run([makeTempDir(), '/some/target', '--metric-json', metricJson], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('type: none requires convergence_mode: worker'));
  });

  test('type: none WITH --convergence-mode worker succeeds', () => {
    const dir = makeTempDir();
    try {
      const metricJson = JSON.stringify({ type: 'none', description: 'n/a', validation: 'n/a', timeout_seconds: 60, tolerance: 0, direction: 'lower' });
      run([dir, '/some/target', '--convergence-mode', 'worker', '--convergence-file', 'ap.json', '--metric-json', metricJson]);
      const state = readMicroverse(dir);
      assert.equal(state.convergence_mode, 'worker');
      assert.equal(state.convergence_file, 'ap.json');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Usage string
  // ---------------------------------------------------------------------------

  test('usage string includes new flags', () => {
    const result = run([], true);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('--convergence-mode'));
    assert.ok(result.stderr.includes('--convergence-file'));
  });
});
