// @tier: integration
/**
 * lock-contention.test.js — two real child writers contend for one state.json lock.
 *
 * A HOLDER child acquires the lock and holds it; once the parent observes the holder is locked,
 * it starts a CONTENDER child configured with maxLockRetries:0 (no steal of a live lock). The
 * SHIPPED contract: exactly one winner, the resulting file is valid JSON with the winner's content,
 * and the loser surfaces the documented LockError (name 'LockError', code 'LOCK_FAILED').
 *
 * Determinism: the contender starts only after the holder's confirmed lock, so the single-winner
 * oracle is pinned, not racy. Escalate bugs, do not fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeStateFile } from '../../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SM_PATH = path.resolve(__dirname, '../../../services/state-manager.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chaos-lock-'));
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
    original_prompt: 'BASE',
    current_ticket: null,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    session_dir: '/tmp/chaos',
    schema_version: 5,
    pipeline_continue_on_phase_fail: true,
    ...extra,
  };
}

// HOLDER: prints LOCKED the moment the lock is held, holds ~3s, then writes the winning marker.
const HOLDER_CHILD = `
  const { pathToFileURL } = await import('node:url');
  const { StateManager } = await import(pathToFileURL(process.argv[1]).href);
  const statePath = process.argv[2];
  const sm = new StateManager();
  sm.update(statePath, (s) => {
    process.stdout.write('LOCKED\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    s.original_prompt = 'WINNER';
  });
  process.stdout.write('DONE\\n');
`;

// CONTENDER: single lock attempt (maxLockRetries:0); a live held lock is not stealable.
const CONTENDER_CHILD = `
  const { pathToFileURL } = await import('node:url');
  const { StateManager } = await import(pathToFileURL(process.argv[1]).href);
  const statePath = process.argv[2];
  const sm = new StateManager({ maxLockRetries: 0, staleLockTimeoutMs: 600000 });
  try {
    sm.update(statePath, (s) => { s.original_prompt = 'CONTENDER'; });
    process.stdout.write('UNEXPECTED_WIN\\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write('LOCK_ERROR:' + (e && e.name) + ':' + (e && e.code) + '\\n');
    process.exit(7);
  }
`;

function spawnHolder(args) {
  return spawn(process.execPath, ['--input-type=module', '-e', HOLDER_CHILD, ...args], {
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
    const onExit = (code) => { cleanup(); reject(new Error(`holder exited (code ${code}) before token "${token}"; stdout: ${buf}`)); };
    const onErr = (err) => { cleanup(); reject(err); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onErr);
  });
}

test('two concurrent writers: exactly one winner, valid JSON, loser gets LockError', { timeout: 60_000 }, async () => {
  const dir = tmpDir();
  let holder;
  try {
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, mkState());

    holder = spawnHolder([SM_PATH, statePath]);
    await waitForToken(holder, 'LOCKED');

    // Contender attacks while the lock is held by the live holder — must lose.
    const contender = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CONTENDER_CHILD, SM_PATH, statePath],
      { encoding: 'utf-8', timeout: 60_000 },
    );

    const [holderCode] = await once(holder, 'exit');
    holder = null;

    // Loser gets the documented LockError.
    assert.match(
      contender.stdout,
      /LOCK_ERROR:LockError:LOCK_FAILED/,
      `contender must surface the documented LockError; stdout: ${contender.stdout} stderr: ${contender.stderr}`,
    );
    assert.equal(contender.status, 7, 'contender must exit via the LockError branch (7)');

    // Holder is the single winner.
    assert.equal(holderCode, 0, 'holder must complete its write cleanly');

    // Resulting file is valid JSON with exactly the winner's content.
    const raw = fs.readFileSync(statePath, 'utf-8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'resulting state.json must be valid JSON');
    assert.equal(parsed.original_prompt, 'WINNER', 'the single winner is the holder, not the contender');
  } finally {
    if (holder) { try { holder.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Reference SM_PATH so a path typo surfaces as an explicit failure, not a silent skip.
test('lock-contention fixture: compiled state-manager module resolves', { timeout: 60_000 }, () => {
  assert.ok(fs.existsSync(fileURLToPath(pathToFileURL(SM_PATH))), `state-manager.js must exist at ${SM_PATH}`);
});
