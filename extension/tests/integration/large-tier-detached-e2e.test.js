// @tier: integration
/**
 * Wire ticket 0d0fdfda — END-TO-END integration of the B-WPEX-AUTO detached
 * large-tier lifecycle (T1–T9). Every prior test exercises exactly ONE seam in
 * isolation (spawn alone, poll alone, dead-disposition alone, timeout-reap alone,
 * resume alone). NONE drives the WHOLE chain as one continuous orchestrator loop.
 * This file does: it threads spawn → poll-while-alive → worker-completes → dispose
 * through the SAME exported production helpers `runMuxRunnerMain` calls, in the
 * SAME branch order, and asserts:
 *   - exactly ONE spawn per detached ticket (the `!state.detached_worker` spawn
 *     guard + the poll branch's `continue` before any re-spawn);
 *   - the 3 large_tier_worker_* events fire at their transitions
 *     (spawned once, poll once per alive iteration, NONE on completion-dispose);
 *   - the arm is cleared and the ticket advanced on the committed-done disposition;
 *   - NO interactive routeLargeTierTicket punt occurs on the autonomous path;
 *   - PICKLE_LARGE_TIER_DETACHED=off runs the VERBATIM routeLargeTierTicket punt
 *     end-to-end (no detached arm, no large_tier_worker_* events).
 *
 * Pure in-process: worker liveness is a mutable flag (mirrors isProcessAlive
 * without a real subprocess) and the committed-done completion is injected via the
 * routeDeadDetachedWorkerDisposition `deps` test seam (salvageTicket stays the
 * single oracle — no new completion authority). No real binary is spawned, so this
 * file is NOT subprocess-heavy and needs no .serial-tests.json entry (mirrors
 * large-tier-detached-poll.test.js / large-tier-detached-dead-disposition.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateManager } from '../../services/state-manager.js';
import {
  recordWorkerArtifactProgress,
  routeDeadDetachedWorkerDisposition,
  largeTierDetachedEnabled,
  routeLargeTierTicket,
} from '../../bin/mux-runner.js';

const sm = new StateManager();
const WORKER_PID = 525252;

function makeSession(ticketId) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-lte2e-'));
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
    detached_worker: null, worker_artifact_progress: {}, activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function addConformanceArtifact(ticketDir, n) {
  writeFileSync(path.join(ticketDir, `conformance_${n}.md`), `# conformance ${n}\n`);
}

/** committed-done deps: worker landed clean, gate passes, commit succeeds. */
function committedDoneDeps(ticketId) {
  return {
    reconcile: () => ({ workingDir: '', dirty: true, dirtyPaths: ['x'], ticketStatuses: { [ticketId]: 'In Progress' } }),
    gate: () => 'passing',
    commitScoped: () => ({ committed: true, sha: 'feedface9999' }),
    archive: () => null,
    resetTodo: () => {},
    ffReattach: () => ({ recovered: false }),
  };
}

/**
 * One iteration of runMuxRunnerMain's large-tier control flow, faithful to the
 * real branch ORDER (spawn-when-no-arm → poll-when-arm-set → fallback). Returns
 * 'spawned' | 'polled' | 'disposed' | 'punted'. `ctx.alive` is the mutable worker
 * liveness flag (the in-process stand-in for isProcessAlive(dw.worker_pid)).
 */
function runLoopIteration(ctx) {
  const { sessionDir, statePath, ticketDir, ticketId, extensionRoot, counters } = ctx;
  const state = readState(statePath);
  const apTicketId = state.current_ticket;
  const detachedEnabled = largeTierDetachedEnabled();

  // [SPAWN] — guarded by !state.detached_worker (T3/T7 main-loop seam).
  if (state.current_ticket_tier === 'large' && detachedEnabled && apTicketId && !state.detached_worker) {
    counters.spawns += 1;
    sm.update(statePath, s => {
      s.detached_worker = {
        worker_pid: WORKER_PID,
        ticket_id: apTicketId,
        spawned_at_epoch: Date.now(),
        worker_log_path: path.join(ticketDir, `worker_session_${WORKER_PID}.log`),
      };
      s.activity.push({
        event: 'large_tier_worker_spawned',
        ts: new Date().toISOString(),
        ticket: apTicketId,
        gate_payload: { worker_pid: WORKER_PID, ticket_id: apTicketId, spawned_at_epoch: Date.now() },
      });
    });
    return 'spawned'; // continue
  }

  // [POLL] — guarded by arm-set + ticket-match (T4). Sits AFTER the spawn branch
  // so its continue fires before any re-spawn → single-spawn invariant.
  if (state.current_ticket_tier === 'large' && detachedEnabled && apTicketId &&
      state.detached_worker && state.detached_worker.ticket_id === apTicketId) {
    const dw = state.detached_worker;

    // Dead (worker completed) → dispose via the single salvageTicket oracle (T5).
    if (!ctx.alive) {
      const disp = routeDeadDetachedWorkerDisposition({
        sessionDir, statePath, extensionRoot, workingDir: state.working_dir,
        ticketId: dw.ticket_id, iteration: state.iteration, flags: null, log: () => {},
        progress: { spawnCount: 1, zeroProgressCount: 0 },
        deps: committedDoneDeps(dw.ticket_id),
      });
      assert.equal(disp.action, 'continue', 'committed-done disposition yields continue');
      return 'disposed';
    }

    // Alive + not-timed-out → poll: re-pointed artifact progress + emit poll, yield.
    const beforeCount = state.worker_artifact_progress?.[dw.ticket_id]?.last_artifact_count ?? 0;
    recordWorkerArtifactProgress(statePath, sessionDir, dw.ticket_id, beforeCount, {
      iteration: state.iteration,
      workingDir: state.working_dir,
      sourceSignatureFn: () => 'STATIC_SIG',
      creditEarlyPhases: false,
    });
    sm.update(statePath, s => {
      s.activity.push({
        event: 'large_tier_worker_poll',
        ts: new Date().toISOString(),
        ticket: dw.ticket_id,
        gate_payload: { worker_pid: dw.worker_pid, ticket_id: dw.ticket_id },
      });
    });
    return 'polled'; // continue
  }

  // [FALLBACK] — kill-switch off / non-large / no-pid: the interactive punt.
  counters.punts += 1;
  routeLargeTierTicket(apTicketId ?? '', sessionDir, statePath);
  return 'punted';
}

test('e2e: ONE large ticket spawn→poll→complete→dispose runs autonomously, no interactive punt', () => {
  const ticketId = 'e2eauto01';
  const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
  const counters = { spawns: 0, punts: 0 };
  const ctx = { sessionDir, statePath, ticketDir, ticketId, extensionRoot: tmp, counters, alive: true };
  const prevConsolidation = process.env.PICKLE_RECOVERY_CONSOLIDATION;
  process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off';
  try {
    // Iteration 1: SPAWN. Arm populated, large_tier_worker_spawned fired.
    assert.equal(runLoopIteration(ctx), 'spawned', 'iter 1 spawns the detached worker');
    let state = readState(statePath);
    assert.ok(state.detached_worker, 'spawn populates the detached_worker arm');
    assert.equal(state.detached_worker.worker_pid, WORKER_PID);
    assert.equal(state.detached_worker.ticket_id, ticketId);
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_spawned').length, 1);

    // Iterations 2..4: POLL while alive. Worker keeps landing artifacts. No re-spawn.
    const ALIVE_POLLS = 3;
    for (let i = 1; i <= ALIVE_POLLS; i++) {
      addConformanceArtifact(ticketDir, i);
      assert.equal(runLoopIteration(ctx), 'polled', `iter ${i + 1} polls (alive), never re-spawns`);
      const armNow = readState(statePath).detached_worker;
      assert.ok(armNow && armNow.worker_pid === WORKER_PID && armNow.ticket_id === ticketId,
        'arm stays stable across polls (same pid + ticket)');
    }
    state = readState(statePath);
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_poll').length, ALIVE_POLLS,
      'large_tier_worker_poll fired exactly once per alive iteration');

    // Worker completes → next poll observes a dead pid → DISPOSE committed-done.
    ctx.alive = false;
    assert.equal(runLoopIteration(ctx), 'disposed', 'final iteration disposes the completed worker');

    state = readState(statePath);
    assert.equal(state.detached_worker, null, 'committed-done clears the detached_worker arm');
    assert.equal(state.current_ticket, null, 'committed-done advances (current_ticket=null)');

    // Whole-chain invariants.
    assert.equal(counters.spawns, 1, 'exactly ONE spawn across the entire lifecycle');
    assert.equal(counters.punts, 0, 'NO interactive routeLargeTierTicket punt on the autonomous path');
    assert.equal(state.activity.filter(e => e.event === 'large_tier_routed').length, 0,
      'no large_tier_routed event — the autonomous path never punted');
    // Event tally across the whole unit: 1 spawned + 3 poll + 0 reaped on this committed-done path.
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_spawned').length, 1);
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_poll').length, ALIVE_POLLS);
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_reaped').length, 0,
      'no reap on a worker that completed under budget');
  } finally {
    if (prevConsolidation === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION;
    else process.env.PICKLE_RECOVERY_CONSOLIDATION = prevConsolidation;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e: PICKLE_LARGE_TIER_DETACHED=off runs the VERBATIM routeLargeTierTicket punt end-to-end', () => {
  const ticketId = 'e2eoff001';
  const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
  const counters = { spawns: 0, punts: 0 };
  const ctx = { sessionDir, statePath, ticketDir, ticketId, extensionRoot: tmp, counters, alive: true };
  const prev = process.env.PICKLE_LARGE_TIER_DETACHED;
  process.env.PICKLE_LARGE_TIER_DETACHED = 'off';
  try {
    assert.equal(largeTierDetachedEnabled(), false, 'kill-switch off resolves to detached-disabled');

    // With the kill-switch off, the very first iteration falls through to the punt.
    const r = runLoopIteration(ctx);
    assert.equal(r, 'punted', 'kill-switch off → the interactive routeLargeTierTicket punt');

    const state = readState(statePath);
    // VERBATIM legacy disposition: large_tier_routed emitted, NO detached arm, NO worker events.
    assert.equal(state.activity.filter(e => e.event === 'large_tier_routed').length, 1,
      'off path emits the legacy large_tier_routed event');
    assert.ok(!state.detached_worker, 'off path never populates state.detached_worker');
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_spawned').length, 0,
      'off path spawns no detached worker');
    assert.equal(state.activity.filter(e => e.event === 'large_tier_worker_poll').length, 0,
      'off path emits no poll events');
    assert.equal(counters.spawns, 0, 'off path makes zero detached spawns');
    assert.equal(counters.punts, 1, 'off path punts exactly once');
  } finally {
    if (prev === undefined) delete process.env.PICKLE_LARGE_TIER_DETACHED;
    else process.env.PICKLE_LARGE_TIER_DETACHED = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});
