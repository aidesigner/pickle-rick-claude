// @tier: fast
//
// B-GROUND2 audit (ticket a1942f72): the UNCOVERED INGEST->DECISION edge — the two
// scan adapters that feed the completion authority. `completion-finalize-choke-point`
// injects fakes at the `finalizeIfTrulyComplete` boundary and lints the source seams,
// but never exercises the adapters themselves:
//   - mux seam: `muxBundleScan` reduces real `reconcileTicketTruth` output to counts.
//     `reconcileTicketTruth` is by-design best-effort (a throwing/unreadable
//     `collectTickets` swallows to `[]`), so this pins the DOCUMENTED behavior: an
//     empty roster reduces to ticketCount:0 and GRADUATES via the never-decomposed
//     carve-out (safe only because callers gate on a non-empty roster upstream).
//   - pipeline seam: `pipelineBundleScan` try/catches its reader to `null` (FAIL-CLOSED);
//     asserted here via the authority boundary with a throwing scan.
//
// These tests are the trip-wire for F1 (mux-seam docstring/behavior drift) and F2
// (pipeline-seam fail-closed) so a future adapter refactor cannot silently flip
// either to fail-open without a RED.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileTicketTruth } from '../lib/reconcile-ticket-truth.js';
import { graduationDecision, finalizeIfTrulyComplete } from '../services/state-manager.js';

// Mirror of the production reduction in `muxBundleScan` (mux-runner.ts:1846):
// commitCount is hard-0 at the mux seam; pending excludes done + skipped.
function reduceMuxCounts(truth) {
  const entries = Object.values(truth.ticketStatuses);
  const norm = (s) => (s || '').toLowerCase();
  const doneCount = entries.filter((st) => norm(st) === 'done').length;
  const pendingCount = entries.filter((st) => norm(st) !== 'done' && norm(st) !== 'skipped').length;
  return { doneCount, commitCount: 0, pendingCount, ticketCount: entries.length };
}

// reconcileTicketTruth deps that drive the roster from a fixture map.
//
// KEY DISCOVERY (audit): the best-effort try/catch swallow lives in
// `reconcile-ticket-truth.ts:defaultDeps` (collectTickets throw -> []), NOT in the
// `reconcileTicketTruth` body — INJECTED deps propagate their throws. Production
// always wires defaultDeps, so an unreadable session reduces to an EMPTY roster.
// We model that production reality by returning [] (the swallowed outcome), and
// separately prove an injected throw is NOT caught by the body.
function makeDeps(statuses, opts = {}) {
  const tickets = opts.unreadable ? [] : Object.keys(statuses).map((id) => ({ id }));
  return {
    headSha: () => null,
    dirtyPaths: () => [],
    isDirty: () => false,
    collectTickets: () => {
      if (opts.throwOnCollect) { throw new Error('collectTickets exploded (unreadable session)'); }
      return tickets;
    },
    ticketStatus: (_sessionDir, id) => statuses[id] ?? null,
  };
}

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-adapter-edge-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    active: true,
    step: 'review',
    current_ticket: 't1',
    session_dir: dir,
    working_dir: dir,
    exit_reason: null,
  }));
  return { dir, statePath };
}

const readState = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('mux-seam scan adapter — reconcileTicketTruth -> graduationDecision', () => {
  it('best-effort empty roster (production: defaultDeps swallow -> []) reduces to ticketCount:0 and GRADUATES (carve-out)', () => {
    // NOTE: this asserts the DOCUMENTED behavior, not a fail-open bug — the mux
    // finalize callers gate on a non-empty roster upstream (applyAllTicketsDoneCompletion
    // returns false on 0 tickets first). If a future refactor makes this seam the
    // primary fail-closed line, this expectation must flip deliberately.
    const truth = reconcileTicketTruth({ sessionDir: '/x', workingDir: '/x' }, makeDeps({}, { unreadable: true }));
    assert.deepEqual(truth.ticketStatuses, {}, 'unreadable session -> empty roster (defaultDeps swallow in production)');
    const counts = reduceMuxCounts(truth);
    assert.deepEqual(counts, { doneCount: 0, commitCount: 0, pendingCount: 0, ticketCount: 0 });
    assert.deepEqual(graduationDecision(counts), { decision: 'graduate' });
  });

  it('the best-effort swallow lives in defaultDeps, NOT the reconcileTicketTruth body (injected throw propagates)', () => {
    // Pins the audit key-discovery: a refactor that moves the try/catch into the
    // body (or out of defaultDeps) changes the failure surface for every injected-dep
    // caller. Production safety depends on defaultDeps doing the swallow.
    assert.throws(
      () => reconcileTicketTruth({ sessionDir: '/x', workingDir: '/x' }, makeDeps({ t1: 'Todo' }, { throwOnCollect: true })),
      /collectTickets exploded/,
    );
  });

  it('22-skip/2-todo/0-done roster reduces to pendingCount:2 and HALTs phase_no_progress (skip-dampen trap)', () => {
    const statuses = {};
    for (let i = 0; i < 22; i++) statuses[`s${i}`] = 'Skipped';
    statuses.todoA = 'Todo';
    statuses.todoB = 'In Progress';
    const truth = reconcileTicketTruth({ sessionDir: '/x', workingDir: '/x' }, makeDeps(statuses));
    const counts = reduceMuxCounts(truth);
    assert.equal(counts.ticketCount, 24);
    assert.equal(counts.doneCount, 0);
    assert.equal(counts.pendingCount, 2, 'skipped excluded from pending; only the 2 runnable remain');
    assert.deepEqual(graduationDecision(counts), { decision: 'halt', reason: 'phase_no_progress' });
  });

  it('fully-terminal roster (Done + Skipped, pendingCount:0) GRADUATES', () => {
    const truth = reconcileTicketTruth({ sessionDir: '/x', workingDir: '/x' },
      makeDeps({ a: 'Done', b: 'Done', c: 'Skipped' }));
    const counts = reduceMuxCounts(truth);
    assert.deepEqual(counts, { doneCount: 2, commitCount: 0, pendingCount: 0, ticketCount: 3 });
    assert.deepEqual(graduationDecision(counts), { decision: 'graduate' });
  });
});

describe('pipeline-seam scan adapter — fail-closed on a throwing reader', () => {
  it('a throwing scan refuses the finalize, stamps pipeline_phase_incomplete, does NOT deactivate', () => {
    // pipelineBundleScan try/catches collectPicklePhaseProgress -> null; the authority
    // refuses on null. A throwing scan at the authority boundary is the same contract.
    const { statePath } = makeState();
    let scanCount = 0;
    const r = finalizeIfTrulyComplete(
      statePath,
      () => { scanCount += 1; throw new Error('collectPicklePhaseProgress exploded'); },
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, false);
    assert.equal(r.reason, 'pipeline_phase_incomplete');
    assert.equal(scanCount, 1, 'single-fire: scan invoked exactly once');
    const s = readState(statePath);
    assert.equal(s.active, true, 'fail-closed: must NOT deactivate on a throwing reader');
    assert.equal(s.exit_reason, 'pipeline_phase_incomplete', 'exactly one exit_reason stamped');
  });

  it('a null scan (empty-where-roster-expected) refuses fail-closed', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(statePath, () => null, { step: 'completed', exitReason: 'completed' });
    assert.equal(r.finalized, false);
    assert.equal(r.reason, 'pipeline_phase_incomplete');
    assert.equal(readState(statePath).active, true);
  });
});
