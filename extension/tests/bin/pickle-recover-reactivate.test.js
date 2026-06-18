// @tier: fast
//
// AC-R-RESH-3 (#122-AC2): `pickle-recover --reactivate` un-terminalize subcommand.
//
// Proves:
//   (a) a terminal {active:false, step:'completed'} session with >=1 Todo reactivates atomically to
//       {active:true, step:'research', exit_reason:null, current_ticket:<lowest runnable Todo>} via
//       the single injected StateManager seam, emitting exactly one recovery event.
//   (b) a terminal all-Done session REFUSES: non-zero exit, no state write, no event, clear message.
//   (c) `--reactivate --plan` is a dry-run: prints the intended transition, writes nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, runRecover } from '../../bin/pickle-recover.js';

const SESSION_DIR = '/tmp/fake-session-reactivate';

// A session driven to terminal completion while Todo tickets remain (the bug this command fixes).
const TERMINAL_STATE = {
  active: false,
  step: 'completed',
  exit_reason: 'completed',
  working_dir: '/repo',
  start_commit: 'base1234',
  current_ticket: null,
};

/** Injectable RecoverDeps that records state writes + events + logs (coverage-test pattern). */
function makeDeps(overrides = {}) {
  const rec = { stateWrites: [], events: [], logs: [] };
  const deps = {
    readState: () => overrides.state ?? TERMINAL_STATE,
    updateState: (statePath, mutator) => {
      // Seed the mutator target from the terminal state so the recorded `after` is the full result.
      const s = {
        active: false,
        step: 'completed',
        exit_reason: 'completed',
        current_ticket: null,
      };
      mutator(s);
      rec.stateWrites.push({ statePath, after: s });
    },
    resolveSessionPath: () => overrides.sessionDir ?? SESSION_DIR,
    collectTickets: () => overrides.tickets ?? [
      { id: 't2', order: 20 },
      { id: 't1', order: 10 },
    ],
    ticketStatus: () => overrides.ticketStatus ?? 'Todo',
    salvage: () => ({ disposition: 'no-op' }),
    reattach: () => ({ detected: false, recovered: false, action: 'none' }),
    setTicketTodo: () => {},
    emit: (transition) => { rec.events.push(transition); },
    log: (msg) => { rec.logs.push(msg); },
    ...(overrides.deps ?? {}),
  };
  return { deps, rec };
}

describe('pickle-recover --reactivate (AC-R-RESH-3)', () => {
  it('(a) terminal session + >=1 Todo -> {active:true, step:research, exit_reason:null, current_ticket:<lowest Todo>}', () => {
    const { deps, rec } = makeDeps();
    const result = runRecover({ subcommand: 'reactivate', ticketArg: null, plan: false }, '/repo', deps);

    assert.equal(result.code, 0, 'reactivate succeeds');
    assert.equal(rec.stateWrites.length, 1, 'exactly one StateManager.update');
    assert.deepEqual(rec.stateWrites[0].after, {
      active: true,
      step: 'research',
      exit_reason: null,
      current_ticket: 't1', // lowest order among the Todo tickets
    });
    assert.equal(rec.events.length, 1, 'exactly one recovery event');
    assert.equal(rec.events[0].subcommand, 'reactivate');
    assert.equal(rec.events[0].disposition, 'reactivated');
    assert.equal(rec.events[0].ticket, 't1');
  });

  it('(b) terminal all-Done session refuses: non-zero exit, no write, no event, clear message', () => {
    const { deps, rec } = makeDeps({ ticketStatus: 'Done' });
    const result = runRecover({ subcommand: 'reactivate', ticketArg: null, plan: false }, '/repo', deps);

    assert.notEqual(result.code, 0, 'refusal exits non-zero');
    assert.equal(result.transition, null, 'no transition on refusal');
    assert.equal(rec.stateWrites.length, 0, 'no state write on refusal');
    assert.equal(rec.events.length, 0, 'no event on refusal');
    assert.ok(
      rec.logs.some((m) => /all-Done|no runnable Todo/i.test(m)),
      'refusal message names the all-Done / no-runnable-Todo cause',
    );
  });

  it('(c) --reactivate --plan is a dry-run: prints the intended transition, writes nothing', () => {
    const { deps, rec } = makeDeps();
    const result = runRecover({ subcommand: 'reactivate', ticketArg: null, plan: true }, '/repo', deps);

    assert.equal(result.code, 0);
    assert.equal(result.transition, null, '--plan returns no transition');
    assert.equal(rec.stateWrites.length, 0, '--plan performs no state write');
    assert.equal(rec.events.length, 0, '--plan emits no event');
    assert.ok(
      rec.logs.some((m) => /\[plan\]/.test(m) && /active:true/.test(m) && /step:'research'/.test(m)),
      '--plan log names the intended {active:true, step:research} transition',
    );
  });

  it('(c2) --reactivate --plan on an all-Done session previews a REFUSE, still writes nothing', () => {
    const { deps, rec } = makeDeps({ ticketStatus: 'Done' });
    const result = runRecover({ subcommand: 'reactivate', ticketArg: null, plan: true }, '/repo', deps);

    assert.equal(result.code, 0, '--plan never refuses');
    assert.equal(rec.stateWrites.length, 0);
    assert.equal(rec.events.length, 0);
    assert.ok(rec.logs.some((m) => /\[plan\]/.test(m) && /REFUSE/i.test(m)));
  });

  it('parseArgs recognizes --reactivate and --reactivate --plan', () => {
    assert.deepEqual(parseArgs(['--reactivate']), { subcommand: 'reactivate', ticketArg: null, plan: false });
    assert.deepEqual(parseArgs(['--reactivate', '--plan']), { subcommand: 'reactivate', ticketArg: null, plan: true });
    assert.throws(() => parseArgs(['--reactivate', '--resume-from-todo']), /only one subcommand/);
  });
});
