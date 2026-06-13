// @tier: fast
//
// W2.R0 AC-R0-COVERAGE / AC-R0-HOOKSAFE / AC-R0-ONE-TRANSITION / AC-R0-CLIGUARD.
//
// Proves:
//   1. Each of W3's 4 salvage dispositions (commit+Done / archive+Todo /
//      ff-reattach / reset-Todo) maps to exactly one pickle-recover subcommand,
//      and each subcommand calls the SHARED primitive (never inline git).
//   2. All state writes go through the injected StateManager seam; `--plan`
//      performs NO write and emits NO event.
//   3. A single real invocation performs exactly ONE transition and emits
//      exactly ONE recovery event.
//   4. The CLI guard uses `path.basename(process.argv[1]) === 'pickle-recover.js'`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  runRecover,
  selectLowestRunnableTodo,
} from '../bin/pickle-recover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(__dirname, '../src/bin/pickle-recover.ts');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf-8');

const SESSION_DIR = '/tmp/fake-session-2026';
const RECOVERY_STATE = { exit_reason: 'recovery_exhausted', working_dir: '/repo', start_commit: 'base1234', current_ticket: 't1' };

/** Build an injectable RecoverDeps that records every primitive call + state write + event. */
function makeDeps(overrides = {}) {
  const rec = {
    stateWrites: [],
    events: [],
    salvageCalls: [],
    reattachCalls: [],
    setTodoCalls: [],
    logs: [],
  };
  const deps = {
    readState: () => overrides.state ?? RECOVERY_STATE,
    updateState: (statePath, mutator) => {
      const s = { current_ticket: 't1', exit_reason: 'recovery_exhausted' };
      mutator(s);
      rec.stateWrites.push({ statePath, after: s });
    },
    resolveSessionPath: () => overrides.sessionDir ?? SESSION_DIR,
    collectTickets: () => overrides.tickets ?? [
      { id: 't2', order: 20 },
      { id: 't1', order: 10 },
    ],
    ticketStatus: () => overrides.ticketStatus ?? 'Todo',
    salvage: (input, salvageDeps) => {
      rec.salvageCalls.push({ input, hasDeps: !!salvageDeps });
      return overrides.salvageOutcome ?? { disposition: 'committed-done', sha: 'deadbee', reason: 'gate_passing_committed' };
    },
    reattach: (input) => {
      rec.reattachCalls.push(input);
      return overrides.reattach ?? { detected: true, recovered: true, action: 'ff_reattached' };
    },
    setTicketTodo: (ticketId, sessionDir) => { rec.setTodoCalls.push({ ticketId, sessionDir }); },
    emit: (transition) => { rec.events.push(transition); },
    log: (msg) => { rec.logs.push(msg); },
    ...(overrides.deps ?? {}),
  };
  return { deps, rec };
}

// The 4 W3 dispositions and the subcommand that owns each.
const DISPOSITION_COVERAGE = [
  { disposition: 'committed-done', subcommand: 'salvage', primitive: 'salvage' },
  { disposition: 'archived-todo', subcommand: 'reset-ticket', primitive: 'salvage' },
  { disposition: 'ff-reattach', subcommand: 'reattach-orphan', primitive: 'reattach' },
  { disposition: 'reset-Todo', subcommand: 'resume-from-todo', primitive: 'reattach' },
];

describe('pickle-recover AC-R0-COVERAGE: disposition -> subcommand -> shared primitive', () => {
  for (const { disposition, subcommand, primitive } of DISPOSITION_COVERAGE) {
    it(`${disposition} maps to --${subcommand} which calls the ${primitive} primitive`, () => {
      const ticketArg = subcommand === 'salvage' || subcommand === 'reset-ticket' ? 't1' : null;
      const { deps, rec } = makeDeps();
      const result = runRecover({ subcommand, ticketArg, plan: false }, '/repo', deps);
      assert.equal(result.code, 0);
      if (primitive === 'salvage') {
        assert.equal(rec.salvageCalls.length, 1, 'exactly one salvageTicket call');
        assert.equal(rec.reattachCalls.length, 0, 'no reattach call');
      } else {
        assert.equal(rec.reattachCalls.length, 1, 'exactly one detectAndRecoverHeadRegression call');
      }
    });
  }

  it('reset-ticket forces the archived-todo (archive + reset-Todo) salvage branch with injected deps', () => {
    const { deps, rec } = makeDeps({ salvageOutcome: { disposition: 'archived-todo', archived: true, reason: 'gate_failing_archived' } });
    const result = runRecover({ subcommand: 'reset-ticket', ticketArg: 't1', plan: false }, '/repo', deps);
    assert.equal(result.code, 0);
    assert.equal(rec.salvageCalls.length, 1);
    assert.equal(rec.salvageCalls[0].hasDeps, true, 'reset-ticket passes a forced-gate SalvageDeps');
    assert.equal(result.transition.disposition, 'archived-todo');
  });
});

describe('pickle-recover AC-R0-COVERAGE: no inline git, shared-primitive imports', () => {
  it('source contains NO inline git invocation', () => {
    assert.doesNotMatch(SOURCE, /spawnSync\(\s*['"]git['"]/, 'no spawnSync git');
    assert.doesNotMatch(SOURCE, /execFileSync\(\s*['"]git['"]/, 'no execFileSync git');
    assert.doesNotMatch(SOURCE, /execSync\(\s*['"]git/, 'no execSync git');
  });

  it('source imports the three shared primitives', () => {
    assert.match(SOURCE, /import\s*\{[^}]*salvageTicket[^}]*\}\s*from\s*['"]\.\.\/lib\/salvage-ticket\.js['"]/);
    assert.match(SOURCE, /import\s*\{[^}]*reconcileTicketTruth[^}]*\}\s*from\s*['"]\.\.\/lib\/reconcile-ticket-truth\.js['"]/);
    assert.match(SOURCE, /import\s*\{[^}]*detectAndRecoverHeadRegression[^}]*\}\s*from\s*['"]\.\/mux-runner\.js['"]/);
  });
});

describe('pickle-recover AC-R0-HOOKSAFE: state writes + --plan dry-run', () => {
  it('real resume-from-todo writes state ONLY through the injected StateManager seam', () => {
    const { deps, rec } = makeDeps();
    runRecover({ subcommand: 'resume-from-todo', ticketArg: null, plan: false }, '/repo', deps);
    assert.equal(rec.stateWrites.length, 1, 'exactly one StateManager.update');
    assert.equal(rec.stateWrites[0].after.current_ticket, null, 'current_ticket cleared');
    assert.equal(rec.stateWrites[0].after.exit_reason, null, 'recovery_exhausted cleared');
  });

  it('--plan performs NO state write and emits NO event', () => {
    for (const { subcommand } of DISPOSITION_COVERAGE) {
      const ticketArg = subcommand === 'salvage' || subcommand === 'reset-ticket' ? 't1' : null;
      const { deps, rec } = makeDeps();
      const result = runRecover({ subcommand, ticketArg, plan: true }, '/repo', deps);
      assert.equal(result.code, 0);
      assert.equal(result.transition, null, '--plan returns no transition');
      assert.equal(rec.stateWrites.length, 0, `${subcommand} --plan: no state write`);
      assert.equal(rec.events.length, 0, `${subcommand} --plan: no event`);
      assert.equal(rec.salvageCalls.length, 0, `${subcommand} --plan: no salvage`);
      assert.equal(rec.reattachCalls.length, 0, `${subcommand} --plan: no reattach`);
      assert.equal(rec.setTodoCalls.length, 0, `${subcommand} --plan: no frontmatter write`);
    }
  });

  it('--plan is permitted on a non-recovery_exhausted session (no refusal, no write)', () => {
    const { deps, rec } = makeDeps({ state: { exit_reason: 'limit', working_dir: '/repo', current_ticket: null } });
    const result = runRecover({ subcommand: 'salvage', ticketArg: 't1', plan: true }, '/repo', deps);
    assert.equal(result.code, 0);
    assert.equal(rec.stateWrites.length, 0);
    assert.equal(rec.events.length, 0);
  });
});

describe('pickle-recover refusal: non-recovery_exhausted without --plan', () => {
  it('refuses and performs no transition / no event', () => {
    const { deps, rec } = makeDeps({ state: { exit_reason: 'limit', working_dir: '/repo', current_ticket: null } });
    const result = runRecover({ subcommand: 'salvage', ticketArg: 't1', plan: false }, '/repo', deps);
    assert.equal(result.code, 1);
    assert.equal(result.transition, null);
    assert.equal(rec.events.length, 0);
    assert.equal(rec.salvageCalls.length, 0);
  });
});

describe('pickle-recover AC-R0-ONE-TRANSITION: exactly one event per real invocation', () => {
  for (const { subcommand } of DISPOSITION_COVERAGE) {
    it(`${subcommand} emits exactly one operator_recovery_transition`, () => {
      const ticketArg = subcommand === 'salvage' || subcommand === 'reset-ticket' ? 't1' : null;
      const { deps, rec } = makeDeps();
      runRecover({ subcommand, ticketArg, plan: false }, '/repo', deps);
      assert.equal(rec.events.length, 1, 'exactly one event');
      assert.equal(rec.events[0].subcommand, subcommand);
    });
  }
});

describe('pickle-recover selectLowestRunnableTodo', () => {
  it('picks the lowest-order runnable ticket', () => {
    const { deps } = makeDeps();
    assert.equal(selectLowestRunnableTodo(SESSION_DIR, deps), 't1');
  });

  it('returns null when no runnable tickets exist', () => {
    const { deps } = makeDeps({ ticketStatus: 'Done' });
    assert.equal(selectLowestRunnableTodo(SESSION_DIR, deps), null);
  });
});

describe('pickle-recover parseArgs', () => {
  it('parses each subcommand and --plan', () => {
    assert.deepEqual(parseArgs(['--resume-from-todo']), { subcommand: 'resume-from-todo', ticketArg: null, plan: false });
    assert.deepEqual(parseArgs(['--reattach-orphan', '--plan']), { subcommand: 'reattach-orphan', ticketArg: null, plan: true });
    assert.deepEqual(parseArgs(['--salvage', 't9']), { subcommand: 'salvage', ticketArg: 't9', plan: false });
    assert.deepEqual(parseArgs(['--reset-ticket', 'abc']), { subcommand: 'reset-ticket', ticketArg: 'abc', plan: false });
  });

  it('rejects missing subcommand, double subcommand, and value-less ticket flags', () => {
    assert.throws(() => parseArgs([]), /subcommand is required/);
    assert.throws(() => parseArgs(['--salvage']), /requires a ticket id/);
    assert.throws(() => parseArgs(['--salvage', '--plan']), /requires a ticket id/);
    assert.throws(() => parseArgs(['--resume-from-todo', '--reattach-orphan']), /only one subcommand/);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });
});

describe('pickle-recover AC-R0-CLIGUARD', () => {
  it('uses the exact basename CLI guard', () => {
    assert.match(SOURCE, /if \(process\.argv\[1\] && path\.basename\(process\.argv\[1\]\) === 'pickle-recover\.js'\)/);
  });
});
