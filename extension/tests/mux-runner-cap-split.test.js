// @tier: fast
// R-CNAR-1 part 2 regression — global max_iterations and per-ticket
// current_ticket_max_iterations must fire INDEPENDENTLY.
//
// Pre-fix (the bug): applyTicketTierBudget overwrote state.max_iterations
// with the per-ticket tier value. The cap-check then conflated global cap
// with per-ticket budget — operator's global cap was silently truncated to
// the smallest tier ceiling encountered, and the pipeline exited at the
// per-ticket budget regardless of how much global runway remained.
//
// Post-fix invariant: state.max_iterations is preserved across
// applyTicketTierBudget calls (global cap), and state.current_ticket_max_iterations
// holds the tier ceiling. Cap-check exits on whichever fires first:
//   (a) per-ticket: budgetIter >= state.current_ticket_max_iterations
//   (b) global:     state.iteration >= state.max_iterations
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyTicketTierBudget } from '../bin/mux-runner.js';

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cap-split-')));
}

function writeTicket(sessionDir, id, tier) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: ${id}`, 'title: Cap split fixture', 'status: Todo', 'order: 1'];
  if (tier) fm.push(`complexity_tier: ${tier}`);
  fm.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), fm.join('\n'));
}

function freshState(ticketId, overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 0,
    max_iterations: 60,         // operator-set global cap
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'cap-split test',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: '',
    ...overrides,
  };
}

test('cap-split: applyTicketTierBudget preserves operator global state.max_iterations', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'small');   // small tier → 10 iter ceiling per R-CNAR-1
    const state = freshState('t1');
    assert.equal(state.max_iterations, 60, 'precondition: operator set global to 60');

    applyTicketTierBudget(state, root);

    // Bug pre-fix: state.max_iterations would be 10 (small-tier value) here.
    assert.equal(state.max_iterations, 60, 'global cap MUST be preserved');
    assert.equal(state.current_ticket_max_iterations, 10, 'per-ticket cache reflects small-tier');
    assert.equal(state.current_ticket_tier, 'small');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: switching tier mid-session does NOT mutate global cap', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'large');     // large → 60 iter
    writeTicket(root, 't2', 'trivial');   // trivial → 5 iter
    const state = freshState('t1', { max_iterations: 200 });

    applyTicketTierBudget(state, root);
    assert.equal(state.max_iterations, 200, 'after large: global preserved');
    assert.equal(state.current_ticket_max_iterations, 60);

    // Simulate ticket transition (mux-runner.runIteration update-state.js path
    // clears these on ticket change; replicate that explicitly).
    state.current_ticket = 't2';
    delete state.current_ticket_tier;
    delete state.current_ticket_max_iterations;
    delete state.current_ticket_worker_timeout_seconds;
    delete state.current_ticket_budget_start_iteration;

    applyTicketTierBudget(state, root);
    assert.equal(state.max_iterations, 200, 'after trivial: global STILL preserved');
    assert.equal(state.current_ticket_max_iterations, 5, 'per-ticket cache shrunk to trivial-tier');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: per-ticket cache populated even when no global cap is set', () => {
  // Edge case: operator launches with state.max_iterations === 0 (no global cap).
  // The per-ticket cache MUST still populate so the per-ticket cap-check at
  // mux-runner.ts can fire.
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'medium');
    const state = freshState('t1', { max_iterations: 0 });

    applyTicketTierBudget(state, root);

    assert.equal(state.max_iterations, 0, 'operator-set 0 preserved');
    assert.equal(state.current_ticket_max_iterations, 30, 'per-ticket medium-tier cache set');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: worker_timeout_seconds remains per-ticket (unchanged behavior)', () => {
  // The fix preserves worker_timeout_seconds being overwritten per-ticket-tier
  // because spawn-morty.ts and friends consume it as the per-spawn worker
  // budget. Documenting that this is the deliberate carve-out from the fix.
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'large');
    const state = freshState('t1', { worker_timeout_seconds: 99 });

    applyTicketTierBudget(state, root);

    assert.equal(state.worker_timeout_seconds, 80 * 60, 'large-tier per-spawn timeout written');
    assert.equal(state.current_ticket_worker_timeout_seconds, 80 * 60, 'and cached');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
