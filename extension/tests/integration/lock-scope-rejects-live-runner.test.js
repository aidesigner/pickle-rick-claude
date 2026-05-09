// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * AC-PSAI-10 trap-door: lock-scope.js MUST refuse to run while
 * pipeline-runner.js is still alive (PID in state.json responds to
 * `process.kill(pid, 0)`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_SCOPE_BIN = path.resolve(__dirname, '../../bin/lock-scope.js');

function makeSession({ pid = null, phases = ['pickle', 'anatomy-park', 'szechuan-sauce'] } = {}) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lockscope-')));
  fs.writeFileSync(
    path.join(tmpRoot, 'state.json'),
    JSON.stringify({
      active: false,
      pid,
      worker_timeout_seconds: 1200,
      schema_version: 3,
    }),
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'pipeline.json'),
    JSON.stringify({
      phases,
      target: tmpRoot,
    }),
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'pipeline-status.json'),
    JSON.stringify({
      status: 'failed',
      current_phase: 'pickle',
      completed_phases: 0,
      skipped_phases: 0,
      total_phases: phases.length,
      updated_at: new Date().toISOString(),
    }),
  );
  return {
    tmpRoot,
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function runLockScope(sessionRoot, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [LOCK_SCOPE_BIN, sessionRoot, '--mode', 'branch', ...extraArgs],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

describe('lock-scope rejects live runner (AC-PSAI-10 trap-door)', () => {
  test('lock-scope.js exits 1 when state.json pid is the current test process (alive)', () => {
    // Use the test runner's own PID — it is guaranteed alive.
    const livePid = process.pid;
    const s = makeSession({ pid: livePid });
    try {
      const result = runLockScope(s.tmpRoot);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(
        result.stderr,
        /pipeline-runner\.js PID/,
        'stderr must mention "pipeline-runner.js PID"',
      );
      assert.match(
        result.stderr,
        new RegExp(String(livePid)),
        'stderr must include the live PID number',
      );
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js succeeds when state.json pid is null (no runner)', () => {
    const s = makeSession({ pid: null });
    try {
      const result = runLockScope(s.tmpRoot);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /scope=branch patched/);
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js succeeds when state.json pid is a dead process', () => {
    // PID 1 on macOS/Linux is launchd/init — we can't kill it but we CAN send signal 0.
    // Instead use a very large PID that is almost certainly not alive.
    const deadPid = 9_999_997;
    const s = makeSession({ pid: deadPid });
    try {
      const result = runLockScope(s.tmpRoot);
      // Dead PID → should succeed (not refuse).
      assert.equal(result.status, 0, `expected exit 0 for dead PID; got ${result.status}\nstderr: ${result.stderr}`);
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js patches pipeline.json with scope=branch', () => {
    const s = makeSession({ pid: null });
    try {
      const result = runLockScope(s.tmpRoot);
      assert.equal(result.status, 0);
      const pipeline = JSON.parse(fs.readFileSync(path.join(s.tmpRoot, 'pipeline.json'), 'utf8'));
      assert.equal(pipeline.scope, 'branch');
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js patches pipeline.json with scope_base when --scope-base passed', () => {
    const s = makeSession({ pid: null });
    try {
      const result = runLockScope(s.tmpRoot, ['--scope-base', 'develop']);
      assert.equal(result.status, 0);
      const pipeline = JSON.parse(fs.readFileSync(path.join(s.tmpRoot, 'pipeline.json'), 'utf8'));
      assert.equal(pipeline.scope, 'branch');
      assert.equal(pipeline.scope_base, 'develop');
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js sets pipeline-status.json status=running', () => {
    const s = makeSession({ pid: null, phases: ['pickle', 'anatomy-park', 'szechuan-sauce'] });
    try {
      const result = runLockScope(s.tmpRoot);
      assert.equal(result.status, 0);
      const status = JSON.parse(fs.readFileSync(path.join(s.tmpRoot, 'pipeline-status.json'), 'utf8'));
      assert.equal(status.status, 'running');
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js exits 1 when session-root does not exist', () => {
    const result = runLockScope('/nonexistent/path/to/session');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /session-root not found/);
  });

  test('lock-scope.js exits non-zero with missing --mode', () => {
    const s = makeSession({ pid: null });
    try {
      const result = spawnSync(process.execPath, [LOCK_SCOPE_BIN, s.tmpRoot], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0, 'missing --mode should fail');
    } finally {
      s.cleanup();
    }
  });

  test('lock-scope.js exits non-zero with unsupported --mode', () => {
    const s = makeSession({ pid: null });
    try {
      const result = spawnSync(
        process.execPath,
        [LOCK_SCOPE_BIN, s.tmpRoot, '--mode', 'paths'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      assert.notEqual(result.status, 0, 'unsupported mode should fail');
    } finally {
      s.cleanup();
    }
  });
});
