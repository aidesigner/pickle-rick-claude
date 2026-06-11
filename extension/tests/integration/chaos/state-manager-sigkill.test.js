// @tier: integration
/**
 * state-manager-sigkill.test.js — real-SIGKILL crash recovery for StateManager.
 *
 * A child process performs a real StateManager.update(): inside the held lock (created by the
 * production acquireLock) it drops an in-flight `state.json.tmp.<pid>` sibling, signals readiness,
 * then hangs holding the lock. The parent SIGKILLs it mid-transaction and asserts the SHIPPED
 * recovery contract:
 *   - lock recovered (the orphaned dead-pid lock is stolen by a subsequent update),
 *   - state readable (read() returns a valid snapshot),
 *   - zero `state.json.tmp.*` litter after recovery.
 *
 * Determinism: the kill is gated on a readiness token, never on a timer. Escalate bugs, do not fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { StateManager } from '../../../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SM_PATH = path.resolve(__dirname, '../../../services/state-manager.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chaos-sigkill-'));
}

function mkState(extra = {}) {
  return {
    active: false,
    working_dir: '/tmp/chaos',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'chaos-sigkill',
    current_ticket: null,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    session_dir: '/tmp/chaos',
    schema_version: 1,
    ...extra,
  };
}

// Child: holds the real lock across a hung mutator, dropping an in-flight tmp sibling first.
const HUNG_TXN_CHILD = `
  const fs = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const smPath = process.argv[1];
  const statePath = process.argv[2];
  const { StateManager } = await import(pathToFileURL(smPath).href);
  const sm = new StateManager();
  sm.update(statePath, () => {
    // Inside the held lock (acquireLock already wrote the real lock file). Simulate an
    // interrupted atomic write by leaving a tmp sibling, then block forever holding the lock.
    const tmp = statePath + '.tmp.' + process.pid + '.' + Date.now() + '.0';
    fs.writeFileSync(tmp, fs.readFileSync(statePath));
    process.stdout.write('TMP_WRITTEN\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
`;

function spawnChild(script, args) {
  // timeout >= 30000: hang-guard only (the child is SIGKILLed well before this fires).
  return spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function waitForToken(child, token) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onErr);
    };
    const onData = (d) => { buf += d.toString(); if (buf.includes(token)) { cleanup(); resolve(); } };
    const onExit = (code) => { cleanup(); reject(new Error(`child exited (code ${code}) before token "${token}"; stdout: ${buf}`)); };
    const onErr = (err) => { cleanup(); reject(err); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onErr);
  });
}

test('SIGKILL mid-transaction: lock recovered, state readable, zero tmp litter', { timeout: 60_000 }, async () => {
  const dir = tmpDir();
  let child;
  try {
    const statePath = path.join(dir, 'state.json');
    const lockPath = `${statePath}.lock`;
    fs.writeFileSync(statePath, JSON.stringify(mkState(), null, 2));

    child = spawnChild(HUNG_TXN_CHILD, [SM_PATH, statePath]);
    await waitForToken(child, 'TMP_WRITTEN');

    // Crash residue present: real lock file + in-flight tmp sibling.
    assert.ok(fs.existsSync(lockPath), 'lock file must exist while the child holds the transaction');
    const litterBefore = fs.readdirSync(dir).filter((e) => e.startsWith('state.json.tmp.'));
    assert.ok(litterBefore.length >= 1, 'an in-flight tmp sibling must exist before the kill');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = null;

    const sm = new StateManager();

    // state readable.
    const recovered = sm.read(statePath);
    assert.equal(typeof recovered.working_dir, 'string', 'recovered state must be a valid snapshot');

    // lock recovered: the orphaned dead-pid lock is stolen, so a fresh update succeeds.
    assert.doesNotThrow(
      () => sm.update(statePath, (s) => { s.step = 'research'; }),
      'update() must succeed after the holder was SIGKILLed (stale lock stolen)',
    );

    // zero tmp litter.
    const litterAfter = fs.readdirSync(dir).filter((e) => e.startsWith('state.json.tmp.'));
    assert.deepEqual(litterAfter, [], `no state.json.tmp.* litter expected, found: ${litterAfter.join(', ')}`);

    // lock released by the successful update.
    assert.equal(fs.existsSync(lockPath), false, 'lock file must be released after recovery');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Reference SM_PATH file URL so a path typo surfaces as an explicit failure, not a silent skip.
test('SIGKILL fixture: compiled state-manager module resolves', { timeout: 60_000 }, () => {
  assert.ok(fs.existsSync(fileURLToPath(pathToFileURL(SM_PATH))), `state-manager.js must exist at ${SM_PATH}`);
});
