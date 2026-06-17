// @tier: integration
/**
 * T6 (AC-R-WPEXA-5 timeout/reap + AC-R-WPEXA-16 identity validation + force detach).
 *
 * The orchestrator backstop: a LIVE detached_worker that has exceeded its per-ticket
 * worker_timeout_seconds (measured from state.detached_worker.spawned_at_epoch, NOT a
 * manager turn) is identity-validated, session-group reaped (process.kill(-pid)), then
 * disposed-as-dead — emitting large_tier_worker_reaped + routing recovery + clearing
 * the arm. A recycled PID (start-time before spawn) or an unreadable start-time fails
 * CLOSED: the reap is refused, but the arm is still cleared and recovery routed.
 *
 * Exercised at the unit-of-contract level through the EXPORTED helpers with injected
 * deps (killFn / startTimeReader / disposeFn), so NO real process is killed and no real
 * subprocess spawns — pure in-process, no serial-tests entry needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateManager } from '../../services/state-manager.js';
import {
  reapTimedOutDetachedWorker,
  validateDetachedWorkerIdentity,
  readProcessStartEpochMs,
} from '../../bin/mux-runner.js';
import {
  shouldIsolateSessionGroup,
  shouldForceDetachForLargeTier,
} from '../../services/backend-spawn.js';

const sm = new StateManager();

function makeSession(ticketId, spawnedAtEpoch) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltrt-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: "In Progress"\ncomplexity_tier: large\n---\n# Ticket\n`);
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 5, working_dir: tmp, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: {
      worker_pid: 525252, ticket_id: ticketId, spawned_at_epoch: spawnedAtEpoch,
      worker_log_path: path.join(ticketDir, 'worker_session_525252.log'),
    },
    worker_artifact_progress: {}, activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

const WORKER_PID = 525252;

test('AC-R-WPEXA-5: timed-out LIVE worker with valid identity → reaped via NEGATIVE group pid + large_tier_worker_reaped + dispose routed + arm cleared', () => {
  const ticketId = 'reapabc01';
  const spawnedAt = Date.now() - 5000 * 1000; // 5000s ago, > 4800s budget
  const { tmp, statePath, sessionDir } = makeSession(ticketId, spawnedAt);
  const kills = [];
  let disposeCalls = 0;
  try {
    const disp = reapTimedOutDetachedWorker({
      sessionDir, statePath, extensionRoot: tmp, workingDir: tmp, ticketId,
      workerPid: WORKER_PID, spawnedAtEpoch: spawnedAt,
      workerTimeoutSeconds: 4800, elapsedSeconds: 5000,
      iteration: 0, flags: null, log: () => {},
      progress: { spawnCount: 1, zeroProgressCount: 0 },
      deps: {
        // identity OK: start-time well after spawn epoch.
        startTimeReader: () => spawnedAt + 1000,
        killFn: (groupPid, signal) => { kills.push([groupPid, signal]); },
        disposeFn: (di) => {
          disposeCalls += 1;
          // production dispose clears the arm — emulate that here.
          sm.update(di.statePath, s => { s.detached_worker = null; s.current_ticket = null; });
          return { action: 'continue' };
        },
      },
    });

    assert.equal(disp.action, 'continue');
    assert.equal(kills.length, 2, 'SIGTERM then SIGKILL issued');
    assert.deepEqual(kills[0], [-WORKER_PID, 'SIGTERM'], 'reap targets the NEGATIVE group pid');
    assert.deepEqual(kills[1], [-WORKER_PID, 'SIGKILL']);
    assert.equal(disposeCalls, 1, 'disposed exactly once (reap-then-dispose reuse)');

    const state = readState(statePath);
    const reaped = state.activity.filter(e => e.event === 'large_tier_worker_reaped');
    assert.equal(reaped.length, 1, 'large_tier_worker_reaped emitted once');
    assert.equal(reaped[0].gate_payload.outcome, 'reaped');
    assert.equal(reaped[0].gate_payload.worker_pid, WORKER_PID);
    assert.equal(reaped[0].gate_payload.ticket_id, ticketId);
    assert.equal(typeof reaped[0].ts, 'string');
    assert.equal(state.detached_worker, null, 'arm cleared by dispose');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-16 identity gate: recycled PID (start-time BEFORE spawn) → reap REFUSED (no kill), arm cleared + recovery routed', () => {
  const ticketId = 'reapabc02';
  const spawnedAt = Date.now() - 5000 * 1000;
  const { tmp, statePath, sessionDir } = makeSession(ticketId, spawnedAt);
  const kills = [];
  let disposeCalls = 0;
  try {
    const disp = reapTimedOutDetachedWorker({
      sessionDir, statePath, extensionRoot: tmp, workingDir: tmp, ticketId,
      workerPid: WORKER_PID, spawnedAtEpoch: spawnedAt,
      workerTimeoutSeconds: 4800, elapsedSeconds: 5000,
      iteration: 0, flags: null, log: () => {},
      progress: { spawnCount: 1, zeroProgressCount: 0 },
      deps: {
        // PID reuse: a stranger started LONG before our worker's spawn epoch.
        startTimeReader: () => spawnedAt - 60_000,
        killFn: (groupPid, signal) => { kills.push([groupPid, signal]); },
        disposeFn: (di) => {
          disposeCalls += 1;
          sm.update(di.statePath, s => { s.detached_worker = null; });
          return { action: 'continue' };
        },
      },
    });

    assert.equal(disp.action, 'continue');
    assert.equal(kills.length, 0, 'NO kill issued on PID-reuse (fail closed)');
    assert.equal(disposeCalls, 1, 'still disposed + recovery routed');

    const state = readState(statePath);
    const reaped = state.activity.filter(e => e.event === 'large_tier_worker_reaped');
    assert.equal(reaped.length, 1);
    assert.match(reaped[0].gate_payload.outcome, /^identity_failed_no_kill:/);
    assert.equal(state.detached_worker, null, 'arm still cleared');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-16 identity gate: unreadable start-time → reap REFUSED (no kill), arm cleared', () => {
  const ticketId = 'reapabc03';
  const spawnedAt = Date.now() - 5000 * 1000;
  const { tmp, statePath, sessionDir } = makeSession(ticketId, spawnedAt);
  const kills = [];
  try {
    const disp = reapTimedOutDetachedWorker({
      sessionDir, statePath, extensionRoot: tmp, workingDir: tmp, ticketId,
      workerPid: WORKER_PID, spawnedAtEpoch: spawnedAt,
      workerTimeoutSeconds: 4800, elapsedSeconds: 5000,
      iteration: 0, flags: null, log: () => {},
      progress: { spawnCount: 1, zeroProgressCount: 0 },
      deps: {
        startTimeReader: () => null, // unreadable
        killFn: (groupPid, signal) => { kills.push([groupPid, signal]); },
        disposeFn: () => ({ action: 'continue' }),
      },
    });
    assert.equal(disp.action, 'continue');
    assert.equal(kills.length, 0, 'fail closed — never kill an unverifiable PID');
    const reaped = readState(statePath).activity.filter(e => e.event === 'large_tier_worker_reaped');
    assert.equal(reaped[0].gate_payload.outcome, 'identity_failed_no_kill:start_time_unreadable');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-5: valid identity but killFn THROWS (ESRCH/already-dead) → reap is best-effort, still emits reaped + disposes once', () => {
  const ticketId = 'reapabc04';
  const spawnedAt = Date.now() - 5000 * 1000;
  const { tmp, statePath, sessionDir } = makeSession(ticketId, spawnedAt);
  let killAttempts = 0;
  let disposeCalls = 0;
  try {
    const disp = reapTimedOutDetachedWorker({
      sessionDir, statePath, extensionRoot: tmp, workingDir: tmp, ticketId,
      workerPid: WORKER_PID, spawnedAtEpoch: spawnedAt,
      workerTimeoutSeconds: 4800, elapsedSeconds: 5000,
      iteration: 0, flags: null, log: () => {},
      progress: { spawnCount: 1, zeroProgressCount: 0 },
      deps: {
        // identity OK, but the worker already exited → both group kills ESRCH.
        startTimeReader: () => spawnedAt + 1000,
        killFn: () => { killAttempts += 1; throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); },
        disposeFn: (di) => {
          disposeCalls += 1;
          sm.update(di.statePath, s => { s.detached_worker = null; s.current_ticket = null; });
          return { action: 'continue' };
        },
      },
    });

    // The throwing kill must NOT propagate — ESRCH-already-dead is the expected happy case.
    assert.equal(disp.action, 'continue');
    assert.equal(killAttempts, 2, 'both SIGTERM and SIGKILL attempted despite the first throwing (each is try/caught)');
    assert.equal(disposeCalls, 1, 'reap-then-dispose still routes the dispose after the kills throw');

    const state = readState(statePath);
    const reaped = state.activity.filter(e => e.event === 'large_tier_worker_reaped');
    assert.equal(reaped.length, 1, 'large_tier_worker_reaped still emitted');
    assert.equal(reaped[0].gate_payload.outcome, 'reaped', 'a validated-identity reap is "reaped" even when the kill ESRCHs');
    assert.equal(state.detached_worker, null, 'arm cleared by dispose');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateDetachedWorkerIdentity: start-time at/after spawn (within skew) is valid; strictly before is reuse', () => {
  const spawnedAt = 1_000_000_000_000;
  assert.equal(validateDetachedWorkerIdentity({ workerPid: 1, spawnedAtEpoch: spawnedAt, startTimeReader: () => spawnedAt }).ok, true);
  // within the whole-second skew tolerance (ps lstart truncates to seconds)
  assert.equal(validateDetachedWorkerIdentity({ workerPid: 1, spawnedAtEpoch: spawnedAt, startTimeReader: () => spawnedAt - 1000 }).ok, true);
  // clearly before → reuse
  const reuse = validateDetachedWorkerIdentity({ workerPid: 1, spawnedAtEpoch: spawnedAt, startTimeReader: () => spawnedAt - 60_000 });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.reason, 'pid_reuse_start_before_spawn');
  // unreadable → fail closed
  const unread = validateDetachedWorkerIdentity({ workerPid: 1, spawnedAtEpoch: spawnedAt, startTimeReader: () => null });
  assert.equal(unread.ok, false);
  assert.equal(unread.reason, 'start_time_unreadable');
});

test('readProcessStartEpochMs: parses an lstart string; null on invalid pid or unparseable value', () => {
  assert.equal(readProcessStartEpochMs(0), null, 'invalid pid');
  assert.equal(readProcessStartEpochMs(-5), null, 'negative pid');
  assert.equal(readProcessStartEpochMs(123, () => null), null, 'reader miss');
  assert.equal(readProcessStartEpochMs(123, () => 'not a date'), null, 'unparseable');
  const epoch = readProcessStartEpochMs(123, () => 'Tue Jun 17 12:00:00 2025');
  assert.equal(epoch, Date.parse('Tue Jun 17 12:00:00 2025'));
});

test('AC-R-WPEXA-16 forced isolation: PICKLE_RECOVERY_CONSOLIDATION=off still detaches the large-tier worker via the force marker', () => {
  if (process.platform === 'win32') return; // no process groups on win32
  // shouldIsolateSessionGroup is OFF, but the large-tier force marker keeps detach ON.
  const offEnv = { PICKLE_RECOVERY_CONSOLIDATION: 'off' };
  assert.equal(shouldIsolateSessionGroup(offEnv), false, 'general isolation disabled by kill-switch');
  assert.equal(shouldForceDetachForLargeTier(offEnv), false, 'no force without the marker');
  const forced = { PICKLE_RECOVERY_CONSOLIDATION: 'off', PICKLE_LARGE_TIER_DETACHED_WORKER: '1' };
  assert.equal(shouldForceDetachForLargeTier(forced), true, 'force marker re-enables detach');
  // The spawn-morty expression: shouldIsolateSessionGroup() || shouldForceDetachForLargeTier().
  assert.equal(shouldIsolateSessionGroup(forced) || shouldForceDetachForLargeTier(forced), true,
    'detached:true holds even when recovery-consolidation is off');
});
