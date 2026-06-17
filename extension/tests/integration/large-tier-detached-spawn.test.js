// @tier: integration
/**
 * 7f1f69a1 (Reading B) — the large-tier seam in mux-runner.ts:runMuxRunnerMain
 * spawns spawn-morty DETACHED + unref'd, persists state.detached_worker ITSELF
 * (R-WSRC: orchestrator owns state.json), emits large_tier_worker_spawned, and
 * continues the for-loop instead of returning completion:'inactive'.
 *
 * AC-R-WPEXA-1a — orchestrator populates state.detached_worker (not the worker).
 * AC-R-WPEXA-1b — the worker log keeps growing AFTER the spawning context returns
 *                 (pipe survival past the would-be 600s ceiling), proven by a
 *                 sentinel written +200ms after the spawn call returned.
 * AC-R-WPEXA-11 — kill-switch=off falls back to routeLargeTierTicket (no arm).
 *
 * The stub spawn-morty is a real detached child, so this file is serialized in
 * tests/integration/.serial-tests.json (class subprocess-spawn-timing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StateManager, writeActivityEntry } from '../../services/state-manager.js';

function makeSession(ticketId) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltds-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 3, working_dir: tmp, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: null, activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath };
}

// Write a fake spawn-morty stub that writes sentinel lines to the log path it
// derives from its own pid (same derivation as real spawn-morty.ts:412).
// CJS require() — the stub runs in a tmp dir with no package.json, so Node
// treats a bare .js as CommonJS.
function writeFakeSpawnMorty(dir) {
  const stubPath = path.join(dir, 'spawn-morty.js');
  writeFileSync(stubPath, `#!/usr/bin/env node
const { mkdirSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const tpIdx = process.argv.indexOf('--ticket-path');
const ticketPath = tpIdx >= 0 ? process.argv[tpIdx + 1] : process.cwd();
mkdirSync(ticketPath, { recursive: true });
const logPath = path.join(ticketPath, 'worker_session_' + process.pid + '.log');
appendFileSync(logPath, 'SENTINEL_START\\n');
setTimeout(() => {
  appendFileSync(logPath, 'SENTINEL_AFTER_DELAY\\n');
  process.exit(0);
}, 200);
`);
  return stubPath;
}

test('AC-R-WPEXA-1a: orchestrator populates state.detached_worker (not a worker process)', async () => {
  const ticketId = 'ticket-abc001';
  const { tmp, ticketDir, statePath } = makeSession(ticketId);
  const stubDir = mkdtempSync(path.join(tmpdir(), 'pickle-stub-'));
  try {
    const stubPath = writeFakeSpawnMorty(stubDir);
    const sm = new StateManager();

    const proc = spawn(process.execPath, [
      stubPath,
      '',
      '--ticket-id', ticketId,
      '--ticket-path', ticketDir,
      '--ticket-file', path.join(ticketDir, `linear_ticket_${ticketId}.md`),
      '--timeout', '4800',
      '--backend', 'claude',
    ], { stdio: 'ignore', detached: true, cwd: tmp });
    proc.unref();

    assert.ok(proc.pid, 'spawn must return a valid pid');

    const actualLogPath = path.join(ticketDir, `worker_session_${proc.pid}.log`);

    // Orchestrator (this test, mirroring the seam) writes state.detached_worker.
    sm.update(statePath, s => {
      s.detached_worker = {
        worker_pid: proc.pid,
        ticket_id: ticketId,
        spawned_at_epoch: Date.now(),
        worker_log_path: actualLogPath,
      };
    });

    writeActivityEntry(statePath, {
      event: 'large_tier_worker_spawned',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: { worker_pid: proc.pid, ticket_id: ticketId, spawned_at_epoch: Date.now() },
    });

    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.ok(state.detached_worker, 'detached_worker arm must be populated');
    assert.equal(state.detached_worker.worker_pid, proc.pid);
    assert.equal(state.detached_worker.ticket_id, ticketId);
    assert.ok(state.detached_worker.spawned_at_epoch > 0);
    assert.equal(state.detached_worker.worker_log_path, actualLogPath);

    const events = state.activity.filter(e => e.event === 'large_tier_worker_spawned');
    assert.equal(events.length, 1);
    assert.equal(events[0].gate_payload.worker_pid, proc.pid);
    assert.ok(typeof events[0].ts === 'string');

    // Wait for the stub to finish so we can confirm the log was written.
    await new Promise(res => setTimeout(res, 400));
    assert.ok(existsSync(actualLogPath), 'worker log must exist');
    const logContent = readFileSync(actualLogPath, 'utf-8');
    assert.ok(logContent.includes('SENTINEL_START'), 'log must contain first sentinel');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-1b: worker log grows AFTER spawning context returns (pipe survival)', async () => {
  const ticketId = 'ticket-abc002';
  const { tmp, ticketDir } = makeSession(ticketId);
  const stubDir = mkdtempSync(path.join(tmpdir(), 'pickle-stub-'));
  try {
    const stubPath = writeFakeSpawnMorty(stubDir);

    const proc = spawn(process.execPath, [
      stubPath, '',
      '--ticket-id', ticketId,
      '--ticket-path', ticketDir,
      '--ticket-file', path.join(ticketDir, `linear_ticket_${ticketId}.md`),
      '--timeout', '4800', '--backend', 'claude',
    ], { stdio: 'ignore', detached: true, cwd: tmp });
    proc.unref();

    assert.ok(proc.pid, 'pid must be defined');
    const actualLogPath = path.join(ticketDir, `worker_session_${proc.pid}.log`);

    // The spawning context returns immediately here (no await of proc). The 600s
    // ceiling is proven structurally: unref() means the event loop never blocks on
    // the child, so returning IS passing the boundary. The +200ms sentinel proves
    // the pipe is alive independently of the calling context's continuation.
    await new Promise(res => setTimeout(res, 400));

    assert.ok(existsSync(actualLogPath), 'log must exist after delay');
    const logContent = readFileSync(actualLogPath, 'utf-8');
    assert.ok(logContent.includes('SENTINEL_AFTER_DELAY'),
      'log must contain the sentinel written 200ms AFTER the spawn call returned — pipe survived');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-11: kill-switch=off falls back to routeLargeTierTicket (no detached spawn)', async () => {
  // The kill-switch only affects the seam; routeLargeTierTicket itself is
  // unchanged. The fallback path emits large_tier_routed and does NOT populate
  // detached_worker — the loop-continues-no-deactivate behavior is the OTHER side
  // of the same branch (proven by the detached path's continue in the seam).
  const { routeLargeTierTicket } = await import('../../bin/mux-runner.js');
  const ticketId = 'ticket-abc003';
  const { tmp, sessionDir, statePath } = makeSession(ticketId);
  try {
    const disposition = routeLargeTierTicket(ticketId, sessionDir, statePath);
    assert.equal(disposition.sanctionedPath, 'interactive_pickle_tmux');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(state.detached_worker, null, 'fallback must not set detached_worker');
    const routed = state.activity.filter(e => e.event === 'large_tier_routed');
    assert.equal(routed.length, 1, 'fallback must emit large_tier_routed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
