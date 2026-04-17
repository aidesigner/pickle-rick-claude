import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../services/state-manager.js';
import {
  StateError,
  LockError,
  TransactionError,
  STATE_MANAGER_DEFAULTS,
} from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test prompt',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// read — valid state
// ---------------------------------------------------------------------------

test('StateManager.read: reads valid state file', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    writeStateFile(sp, state);
    const result = sm.read(sp);
    assert.equal(result.active, true);
    assert.equal(result.iteration, 1);
    assert.equal(result.schema_version, 1);
  });
});

// ---------------------------------------------------------------------------
// read — missing file
// ---------------------------------------------------------------------------

test('StateManager.read: throws MISSING for non-existent file', () => {
  const sm = new StateManager();
  try {
    sm.read('/tmp/nonexistent-pickle-state-99999.json');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof StateError);
    assert.equal(err.code, 'MISSING');
  }
});

// ---------------------------------------------------------------------------
// read — corrupt JSON
// ---------------------------------------------------------------------------

test('StateManager.read: throws CORRUPT for invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON array', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '[1,2,3]');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON null', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, 'null');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

// ---------------------------------------------------------------------------
// read — schema migration
// ---------------------------------------------------------------------------

test('StateManager.read: migrates undefined schema_version to 1', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));
    const result = sm.read(sp);
    assert.equal(result.schema_version, 1);
    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 1);
  });
});

test('StateManager.read: throws SCHEMA_MISMATCH for future schema version', () => {
  withDir((dir) => {
    // State file claims schema_version 2, but this binary only understands version 1
    const sm = new StateManager({ schemaVersion: 1 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 2 }));
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
    }
  });
});

test('StateManager.read: tolerates past schema version (backward compat)', () => {
  withDir((dir) => {
    // Binary understands version 2, state file is version 1 — safe rollback scenario
    const sm = new StateManager({ schemaVersion: 2 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 1 }));
    // Should NOT throw — old state is readable by newer code
    const result = sm.read(sp);
    assert.equal(result.schema_version, 1);
  });
});

test('StateManager.read: logs to stderr on undefined schema_version migration', () => {
  withDir((dir) => {
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      const state = makeState();
      delete state.schema_version;
      fs.writeFileSync(sp, JSON.stringify(state, null, 2));
      sm.read(sp);
      assert.ok(
        messages.some((m) => m.includes('migrating to 1')),
        `expected migration log, got: ${JSON.stringify(messages)}`,
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// read — recovery: orphan tmp files
// ---------------------------------------------------------------------------

test('StateManager.read: cleans up orphan tmp file with dead PID', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp file with a dead PID (99999999)
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 3 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'orphan tmp should be deleted');
  });
});

test('StateManager.read: promotes orphan tmp file with higher iteration', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp with higher iteration
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10 })));
    const result = sm.read(sp);
    assert.equal(result.iteration, 10, 'should promote higher iteration');
    assert.equal(fs.existsSync(tmpFile), false, 'tmp file should be consumed');
  });
});

test('StateManager.read: deletes orphan tmp with invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, 'NOT VALID JSON');
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'invalid tmp should be deleted');
  });
});

test('StateManager.read: leaves tmp file from live process alone', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Use current PID — definitely alive
    const tmpFile = `${sp}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 99 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), true, 'tmp from live process should remain');
    fs.unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// read — recovery: stale active flag
// ---------------------------------------------------------------------------

test('StateManager.read: clears active flag when pid is dead', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: 99999999 }));
    const result = sm.read(sp);
    assert.equal(result.active, false, 'active should be cleared for dead PID');
  });
});

test('StateManager.read: preserves active flag when no pid set', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved when no pid');
  });
});

test('StateManager.read: preserves active flag for live pid', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: process.pid }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved for live PID');
  });
});

// ---------------------------------------------------------------------------
// update — basic mutation with lock
// ---------------------------------------------------------------------------

test('StateManager.update: applies mutator and persists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1 }));
    const result = sm.update(sp, (s) => { s.iteration = 42; });
    assert.equal(result.iteration, 42);
    // Persisted
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 42);
  });
});

test('StateManager.update: no lock file left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    sm.update(sp, (s) => { s.step = 'research'; });
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released');
  });
});

test('StateManager.update: releases lock even when mutator throws', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    try {
      sm.update(sp, () => { throw new Error('mutator boom'); });
    } catch { /* expected */ }
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released on error');
  });
});

// ---------------------------------------------------------------------------
// forceWrite — best effort, no lock
// ---------------------------------------------------------------------------

test('StateManager.forceWrite: writes state without lock', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    sm.forceWrite(sp, makeState({ iteration: 99 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 99);
  });
});

test('StateManager.forceWrite: succeeds even when lock file exists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create a lock file
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    sm.forceWrite(sp, makeState({ iteration: 77 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 77);
    // Cleanup
    try { fs.unlinkSync(`${sp}.lock`); } catch { /* ok */ }
  });
});

test('StateManager.forceWrite: never throws even on bad path', () => {
  const sm = new StateManager();
  // This should not throw
  sm.forceWrite('/nonexistent/path/state.json', makeState());
});

// ---------------------------------------------------------------------------
// transaction — success
// ---------------------------------------------------------------------------

test('StateManager.transaction: mutates multiple files atomically', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    const results = sm.transaction([sp1, sp2], (states) => {
      states[0].iteration = 10;
      states[1].iteration = 20;
    });

    assert.equal(results[0].iteration, 10);
    assert.equal(results[1].iteration, 20);

    // Persisted
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d1.iteration, 10);
    assert.equal(d2.iteration, 20);
  });
});

test('StateManager.transaction: no lock files left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState());
    writeStateFile(sp2, makeState());

    sm.transaction([sp1, sp2], () => { /* no-op */ });

    assert.equal(fs.existsSync(`${sp1}.lock`), false);
    assert.equal(fs.existsSync(`${sp2}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// transaction — rollback
// ---------------------------------------------------------------------------

test('StateManager.transaction: rolls back on write failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    // Make sp2 unwritable after backup is taken
    // We'll do this by having the mutator set a circular reference on states[1]
    // which will cause JSON.stringify to fail during write
    try {
      sm.transaction([sp1, sp2], (states) => {
        states[0].iteration = 100;
        // Create a circular reference to break JSON.stringify
        const circ = {};
        circ.self = circ;
        Object.assign(states[1], { bad: circ });
      });
      assert.fail('should have thrown TransactionError');
    } catch (err) {
      assert.ok(err instanceof TransactionError, `expected TransactionError, got ${err.constructor.name}`);
    }

    // sp1 should be rolled back to original value
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    assert.equal(d1.iteration, 1, 'sp1 should be rolled back');

    // sp2 should still have original value
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d2.iteration, 2, 'sp2 should be unchanged');
  });
});

test('StateManager.transaction: releases locks on failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    writeStateFile(sp1, makeState());

    try {
      sm.transaction([sp1], (states) => {
        const circ = {};
        circ.self = circ;
        Object.assign(states[0], { bad: circ });
      });
    } catch { /* expected */ }

    assert.equal(fs.existsSync(`${sp1}.lock`), false, 'lock should be released');
  });
});

// ---------------------------------------------------------------------------
// Lock — stale lock stealing
// ---------------------------------------------------------------------------

test('StateManager.update: steals stale lock from dead process', () => {
  withDir((dir) => {
    const sm = new StateManager({ staleLockTimeoutMs: 100 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create stale lock from dead PID
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: 99999999, ts: Date.now() - 200 }));
    // Should succeed by stealing the stale lock
    const result = sm.update(sp, (s) => { s.iteration = 7; });
    assert.equal(result.iteration, 7);
  });
});

test('StateManager.update: steals lock with corrupt JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    fs.writeFileSync(`${sp}.lock`, 'NOT JSON AT ALL');
    const result = sm.update(sp, (s) => { s.iteration = 8; });
    assert.equal(result.iteration, 8);
  });
});

// ---------------------------------------------------------------------------
// Lock — failure after max retries
// ---------------------------------------------------------------------------

test('StateManager.update: throws LockError after max retries', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 1, baseLockDelayMs: 10, staleLockTimeoutMs: 999_999 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create lock held by current process (alive, not stale)
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      sm.update(sp, () => {});
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof LockError, `expected LockError, got ${err.constructor.name}`);
      assert.ok(err.code === 'LOCK_FAILED');
    } finally {
      fs.unlinkSync(`${sp}.lock`);
    }
  });
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

test('StateError: has correct name and code', () => {
  const err = new StateError('CORRUPT', 'bad data');
  assert.equal(err.name, 'StateError');
  assert.equal(err.code, 'CORRUPT');
  assert.equal(err.message, 'bad data');
  assert.ok(err instanceof Error);
});

test('LockError: inherits from StateError with LOCK_FAILED code', () => {
  const err = new LockError('lock test');
  assert.equal(err.name, 'LockError');
  assert.equal(err.code, 'LOCK_FAILED');
  assert.ok(err instanceof StateError);
  assert.ok(err instanceof Error);
});

test('TransactionError: carries rollback errors', () => {
  const rbErr = new Error('rollback failed');
  const err = new TransactionError('tx failed', [rbErr]);
  assert.equal(err.name, 'TransactionError');
  assert.equal(err.code, 'WRITE_FAILED');
  assert.equal(err.rollbackErrors.length, 1);
  assert.equal(err.rollbackErrors[0].message, 'rollback failed');
  assert.ok(err instanceof StateError);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('STATE_MANAGER_DEFAULTS: has expected values', () => {
  assert.equal(STATE_MANAGER_DEFAULTS.maxLockRetries, 10);
  assert.equal(STATE_MANAGER_DEFAULTS.baseLockDelayMs, 100);
  assert.equal(STATE_MANAGER_DEFAULTS.lockJitter, true);
  assert.equal(STATE_MANAGER_DEFAULTS.staleLockTimeoutMs, 30_000);
  assert.equal(STATE_MANAGER_DEFAULTS.schemaVersion, 2);
});

// ---------------------------------------------------------------------------
// Constructor: custom options override defaults
// ---------------------------------------------------------------------------

test('StateManager: custom options override defaults', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 3, baseLockDelayMs: 50 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Should work with custom options
    const result = sm.read(sp);
    assert.equal(result.schema_version, 1);
  });
});

// ---------------------------------------------------------------------------
// transaction: returns states in original path order
// ---------------------------------------------------------------------------

test('StateManager.transaction: returns states in caller path order (not sorted)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const spZ = path.join(dir, 'z-state.json');
    const spA = path.join(dir, 'a-state.json');
    writeStateFile(spZ, makeState({ iteration: 100 }));
    writeStateFile(spA, makeState({ iteration: 200 }));

    // Pass in Z before A — results should match that order
    const results = sm.transaction([spZ, spA], () => { /* no-op */ });
    assert.equal(results[0].iteration, 100, 'first result should be Z');
    assert.equal(results[1].iteration, 200, 'second result should be A');
  });
});
