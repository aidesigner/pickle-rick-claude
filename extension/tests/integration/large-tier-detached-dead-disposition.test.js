// @tier: integration
/**
 * T5 (AC-R-WPEXA-15 + AC-R-WPEXA-11(c)) — the DEAD detached-worker disposition in
 * mux-runner.ts:runMuxRunnerMain's POLL branch. When state.detached_worker is set,
 * matches the current ticket, but its pid is no longer alive, the poll invokes the
 * SINGLE salvageTicket oracle (via routeDeadDetachedWorkerDisposition) and maps ALL
 * SIX salvageTicket dispositions to exactly one deterministic poll action:
 *
 *   committed-done            → clear arm, advance (currentTicket=null), continue
 *   no-op / already_terminal  → clear arm, advance, continue (no re-gate)
 *   ff-reattached             → clear arm, advance, continue
 *   no-op / clean_tree        → routeRecoveryBeforeTerminal (dead-without-completion)
 *   archived-todo             → bounded re-attempt: clear arm, continue (NOT a commit,
 *                               NOT a terminal park; salvage already reset Todo)
 *   error                     → no destructive action, routeRecoveryBeforeTerminal
 *
 * The six dispositions are driven through the helper's `deps` test seam (an injected
 * SalvageDeps) so each is deterministic WITHOUT a real git repo or test:fast spin —
 * salvageTicket stays the single oracle (no parallel completion path). The recovery
 * routing for clean_tree + error is verified under PICKLE_RECOVERY_CONSOLIDATION=off
 * (deterministic fall_through: clear arm + continue, NO host-repo git). Pure
 * in-process — no real subprocess — so this file needs no serial-tests entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateManager } from '../../services/state-manager.js';
import { routeDeadDetachedWorkerDisposition } from '../../bin/mux-runner.js';

const sm = new StateManager();
const DEAD_PID = 424242; // reaped pid: isProcessAlive is false for the real branch.

function makeSession(ticketId, status = 'In Progress') {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltdd-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: "${status}"\ncomplexity_tier: large\n---\n# Ticket\n`);
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 5, working_dir: tmp, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: {
      worker_pid: DEAD_PID, ticket_id: ticketId,
      spawned_at_epoch: Date.now(),
      worker_log_path: path.join(ticketDir, `worker_session_${DEAD_PID}.log`),
    },
    worker_artifact_progress: { [ticketId]: { spawn_count: 1, last_artifact_count: 0, zero_progress_count: 2 } },
    activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

/** A SalvageDeps factory that forces a chosen disposition deterministically. */
function depsForDisposition(kind, ticketId) {
  const base = {
    reconcile: () => ({ workingDir: '', dirty: false, dirtyPaths: [], ticketStatuses: {} }),
    gate: () => 'failing',
    commitScoped: () => ({ committed: false }),
    archive: () => null,
    resetTodo: () => { /* track separately per case */ },
    ffReattach: () => ({ recovered: false }),
  };
  switch (kind) {
    case 'committed-done':
      // dirty + gate passing + commit succeeds → committed-done.
      return {
        ...base,
        reconcile: () => ({ workingDir: '', dirty: true, dirtyPaths: ['x'], ticketStatuses: { [ticketId]: 'In Progress' } }),
        gate: () => 'passing',
        commitScoped: () => ({ committed: true, sha: 'deadbeef1234' }),
      };
    case 'already_terminal':
      // dirty + ticket already Done → no-op/already_terminal.
      return {
        ...base,
        reconcile: () => ({ workingDir: '', dirty: true, dirtyPaths: ['x'], ticketStatuses: { [ticketId]: 'Done' } }),
      };
    case 'ff-reattached':
      return { ...base, ffReattach: () => ({ recovered: true, sha: 'cafe5678' }) };
    case 'clean_tree':
      return base; // dirty:false → no-op/clean_tree.
    case 'archived-todo': {
      // dirty + gate failing → archive + reset Todo → archived-todo.
      let didReset = false;
      const d = {
        ...base,
        reconcile: () => ({ workingDir: '', dirty: true, dirtyPaths: ['x'], ticketStatuses: { [ticketId]: 'In Progress' } }),
        gate: () => 'failing',
        archive: () => ({ archived: true }),
        resetTodo: () => { didReset = true; },
      };
      d._didReset = () => didReset;
      return d;
    }
    case 'error':
      return { ...base, reconcile: () => { throw new Error('forced reconcile failure'); } };
    default:
      throw new Error(`unknown disposition ${kind}`);
  }
}

function callHelper(ctx, deps) {
  const state = readState(ctx.statePath);
  return routeDeadDetachedWorkerDisposition({
    sessionDir: ctx.sessionDir,
    statePath: ctx.statePath,
    extensionRoot: ctx.tmp,
    workingDir: state.working_dir,
    ticketId: ctx.ticketId,
    iteration: state.iteration,
    flags: null,
    log: () => {},
    progress: { spawnCount: 1, zeroProgressCount: 2 },
    deps,
  });
}

// AC-R-WPEXA-15: describe.each-style for...of over the SIX dispositions.
const ADVANCE_CASES = [
  { kind: 'committed-done', clearsCurrentTicket: true },
  { kind: 'already_terminal', clearsCurrentTicket: true },
  { kind: 'ff-reattached', clearsCurrentTicket: true },
];

for (const c of ADVANCE_CASES) {
  test(`AC-R-WPEXA-15: ${c.kind} → clear arm + advance + continue`, () => {
    const ticketId = `dead${c.kind.replace(/[^a-z]/g, '').slice(0, 6)}`;
    const status = c.kind === 'already_terminal' ? 'Done' : 'In Progress';
    const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId, status);
    try {
      const disp = callHelper({ tmp, sessionDir, ticketId, statePath }, depsForDisposition(c.kind, ticketId));
      assert.equal(disp.action, 'continue', `${c.kind} yields continue`);
      const state = readState(statePath);
      assert.equal(state.detached_worker, null, `${c.kind} clears the detached_worker arm`);
      if (c.clearsCurrentTicket) {
        assert.equal(state.current_ticket, null, `${c.kind} advances (current_ticket=null)`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      void ticketDir;
    }
  });
}

test('AC-R-WPEXA-15: archived-todo → bounded re-attempt (clear arm, continue, NOT terminal park)', () => {
  const ticketId = 'deadarchtd';
  const { tmp, sessionDir, statePath } = makeSession(ticketId);
  const deps = depsForDisposition('archived-todo', ticketId);
  try {
    const disp = callHelper({ tmp, sessionDir, ticketId, statePath }, deps);
    assert.equal(disp.action, 'continue', 'archived-todo yields continue (re-attempt)');
    assert.ok(deps._didReset(), 'salvage reset the ticket to Todo (not a commit)');
    const state = readState(statePath);
    assert.equal(state.detached_worker, null, 'arm cleared so the ticket re-spawns next loop');
    // NOT a terminal park: current_ticket is left pointing at the re-attemptable ticket.
    assert.equal(state.current_ticket, ticketId, 'current_ticket preserved for re-attempt');
    // NOT a Failed/oversized terminal flip.
    const flips = state.activity.filter(e => e.event === 'worker_auto_skip_oversized' || e.event === 'ticket_ladder_exhausted');
    assert.equal(flips.length, 0, 'archived-todo is NOT a terminal park');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// AC-R-WPEXA-11(c): dead-without-completion → routeRecoveryBeforeTerminal.
// Under PICKLE_RECOVERY_CONSOLIDATION=off the choke point returns fall_through
// deterministically (no host git): clear arm + continue (re-attempt, NO auto-Fail).
const RECOVERY_CASES = ['clean_tree', 'error'];
for (const kind of RECOVERY_CASES) {
  test(`AC-R-WPEXA-11(c): ${kind} → routeRecoveryBeforeTerminal (fall_through: clear arm, continue, no auto-Fail)`, () => {
    const ticketId = `deadrec${kind.slice(0, 4)}`;
    const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
    const prev = process.env.PICKLE_RECOVERY_CONSOLIDATION;
    process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off';
    try {
      const disp = callHelper({ tmp, sessionDir, ticketId, statePath }, depsForDisposition(kind, ticketId));
      assert.equal(disp.action, 'continue', `${kind} fall_through yields continue`);
      const state = readState(statePath);
      assert.equal(state.detached_worker, null, `${kind} clears the arm`);
      // Dead-clean must NOT auto-Fail — that is the wedge path's job.
      const tf = readFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf-8');
      assert.doesNotMatch(tf, /status:\s*["']?Failed["']?/, `${kind} does not auto-Fail the ticket`);
    } finally {
      if (prev === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION;
      else process.env.PICKLE_RECOVERY_CONSOLIDATION = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('single-spawn invariant: every dead-worker disposition clears the arm so no re-spawn', () => {
  // The poll branch sits AFTER the !state.detached_worker-guarded spawn branch; the
  // helper continue/break fires BEFORE the live-poll body. Clearing the arm on every
  // outcome is what guarantees exactly-once spawn — assert it across all six.
  for (const kind of ['committed-done', 'already_terminal', 'ff-reattached', 'archived-todo', 'clean_tree', 'error']) {
    const ticketId = `inv${kind.replace(/[^a-z]/g, '').slice(0, 7)}`;
    const status = kind === 'already_terminal' ? 'Done' : 'In Progress';
    const { tmp, sessionDir, statePath } = makeSession(ticketId, status);
    const prev = process.env.PICKLE_RECOVERY_CONSOLIDATION;
    process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off';
    try {
      callHelper({ tmp, sessionDir, ticketId, statePath }, depsForDisposition(kind, ticketId));
      assert.equal(readState(statePath).detached_worker, null, `${kind} clears the arm (single-spawn invariant)`);
    } finally {
      if (prev === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION;
      else process.env.PICKLE_RECOVERY_CONSOLIDATION = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
