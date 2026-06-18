// @tier: integration
/**
 * AC-R-WPEXA-6 (resume portion) — `setup.js --resume` must NOT clobber / null a
 * live `state.detached_worker`, and MUST NOT re-spawn over it. The resumed
 * mux-runner's poll path owns re-attach via ground truth (isProcessAlive); setup
 * only preserves the arm so the poll can re-attach.
 *
 * setup.ts has no spawn path, so "no re-spawn" is proven by the arm surviving the
 * resume identically (same pid/ticket/log) and no `large_tier_worker_spawned`
 * event being added by resume. The operator breadcrumb stderr line
 * (noteLiveDetachedWorkerOnResume) is captured via spawnSync and asserted
 * structurally — pinned to the real pid + ticket id, not a substring match.
 *
 * SERIAL: spawns setup.js as a subprocess (resume), keep at c=1 via the manifest
 * if it ever flakes under load. Live PID = this test process's own pid (alive for
 * the duration of the resume subprocess), so isProcessAlive returns true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../../bin/setup.js');

function buildResumableSession(detachedWorker) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'pickle-ltrr-data-'));
  const workingDir = mkdtempSync(path.join(tmpdir(), 'pickle-ltrr-wd-'));
  const ticketId = 'resumeabc01';
  // Sessions live under <dataRoot>/sessions/<hash>/.
  const sessionDir = path.join(dataRoot, 'sessions', '2026-06-17-resume0e');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: false, schema_version: 5, working_dir: workingDir, step: 'implement',
    iteration: 3, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'resume re-attach test',
    session_dir: sessionDir, tmux_mode: true, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: detachedWorker, worker_artifact_progress: {}, activity: [],
    history: [], flags: {},
  }));
  return { dataRoot, workingDir, sessionDir, ticketDir, statePath, ticketId };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

test('AC-R-WPEXA-6: --resume preserves a LIVE detached_worker arm and never re-spawns', () => {
  const ticketId = 'resumeabc01';
  const liveDetached = {
    worker_pid: process.pid, // alive for the duration of the resume subprocess
    ticket_id: ticketId,
    spawned_at_epoch: Date.now(),
    worker_log_path: '/tmp/worker_session_live.log',
  };
  const { dataRoot, sessionDir, statePath } = buildResumableSession(liveDetached);
  try {
    // spawnSync (not execFileSync) so we capture BOTH stdout and stderr as strings —
    // the operator breadcrumb is written to stderr and must be asserted, not assumed.
    const res = spawnSync(
      process.execPath,
      [SETUP, '--resume', sessionDir],
      { encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot } },
    );
    assert.equal(res.status, 0, `setup --resume must exit 0 (stderr: ${res.stderr})`);

    const after = readState(statePath);
    // Arm preserved IDENTICALLY — not nulled, not mutated.
    assert.ok(after.detached_worker, 'live detached_worker arm must survive resume');
    assert.equal(after.detached_worker.worker_pid, process.pid, 'pid preserved');
    assert.equal(after.detached_worker.ticket_id, ticketId, 'ticket_id preserved');
    assert.equal(after.detached_worker.worker_log_path, liveDetached.worker_log_path, 'log path preserved');
    assert.equal(after.detached_worker.spawned_at_epoch, liveDetached.spawned_at_epoch, 'spawn epoch preserved');

    // setup has NO spawn path — resume must not add a spawn event.
    const spawnEvents = (after.activity || []).filter(e => e.event === 'large_tier_worker_spawned');
    assert.equal(spawnEvents.length, 0, 'resume must not re-spawn (no large_tier_worker_spawned event)');

    // Operator breadcrumb ACTUALLY fires on stderr for a LIVE arm (noteLiveDetachedWorkerOnResume,
    // setup.ts). Pinned to the real pid + ticket so a substring can't false-positive.
    const stderr = res.stderr + '';
    assert.match(
      stderr,
      new RegExp(`\\[setup\\] detached worker pid=${process.pid} still live`),
      'live-arm resume must emit the operator breadcrumb on stderr with the exact pid',
    );
    assert.match(
      stderr,
      new RegExp(`\\(ticket ${ticketId}\\)`),
      'breadcrumb must name the detached worker ticket',
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-6: --resume leaves a DEAD-PID detached_worker arm for the poll (no clear in setup)', () => {
  const ticketId = 'resumeabc01';
  // PID 1 is init/launchd — never a dead large-tier worker; use a high unlikely-alive pid.
  const deadDetached = {
    worker_pid: 2147483646, // implausible pid → isProcessAlive false
    ticket_id: ticketId,
    spawned_at_epoch: Date.now(),
    worker_log_path: '/tmp/worker_session_dead.log',
  };
  const { dataRoot, sessionDir, statePath } = buildResumableSession(deadDetached);
  try {
    execFileSync(
      process.execPath,
      [SETUP, '--resume', sessionDir],
      { encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot } },
    );

    const after = readState(statePath);
    // setup MUST NOT clear a dead arm — the poll's T5 dead-disposition owns that.
    assert.ok(after.detached_worker, 'dead detached_worker arm must remain for the poll to dispose');
    assert.equal(after.detached_worker.worker_pid, 2147483646, 'dead pid preserved');
    assert.equal(after.detached_worker.ticket_id, ticketId, 'ticket_id preserved');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
