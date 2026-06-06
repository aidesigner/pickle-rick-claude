// @tier: fast
//
// R-ORSR-2: RecoveryController ordered ladder. The "scripted worker" is the set of
// injected adapter results (evidence / armed-gate / commit / remediator / plan).
// Covers:
//   INV-NO-SINGLE-ITER-PARK   — gate-passing uncommitted tree → advanced (commit-and-continue).
//   INV-RECOVERY-LADDER       — dirty→advanced; converged-plan→execute-converged-plan; zero→fall_through.
//   INV-LADDER-RUNG-FAILURE   — commit blocked → fix-forward-trivial, ledger records the failure.
//   INV-RUNG-ERROR-CONTAINED  — a rung that throws → failed attempt, never advanced.
//   INV-FIX-FORWARD-BOUND     — remediator spawned at most M=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../services/recovery-controller.js');

/**
 * Build a scripted deps object. Adapter behaviors come from `behavior` overrides;
 * call counts are tracked by wrappers so a test's behavior override never silently
 * disables the counter.
 */
function scriptDeps(behavior = {}) {
  const attempts = [];
  const calls = { armedGate: 0, commit: 0, remediator: 0, plan: 0 };
  const b = {
    iteration: 7,
    ticketId: 'tkt-abc',
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: false }),
    commitAndFlipDone: () => ({ ok: false }),
    spawnRemediator: () => false,
    log: () => {},
    ...behavior,
  };
  const deps = {
    iteration: b.iteration,
    ticketId: b.ticketId,
    maxRemediatorSpawns: behavior.maxRemediatorSpawns,
    assessEvidence: b.assessEvidence,
    runArmedGate: () => { calls.armedGate += 1; return b.runArmedGate(); },
    commitAndFlipDone: () => { calls.commit += 1; return b.commitAndFlipDone(); },
    spawnRemediator: () => { calls.remediator += 1; return b.spawnRemediator(); },
    appendAttempt: behavior.appendAttempt ?? ((a) => attempts.push(a)),
    log: b.log,
  };
  if (behavior.executeConvergedPlan) {
    deps.executeConvergedPlan = () => { calls.plan += 1; return behavior.executeConvergedPlan(); };
  }
  return { deps, attempts, calls };
}

test('INV-NO-SINGLE-ITER-PARK: dirty tree + armed gate green + commit ok → advanced(commit-and-continue)', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: true }),
    commitAndFlipDone: () => ({ ok: true, sha: 'deadbeef' }),
  });
  const out = runRecoveryLadder(deps);
  assert.deepEqual(out, { kind: 'advanced', strategy: 'commit-and-continue', sha: 'deadbeef' });
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0], {
    strategy: 'commit-and-continue', outcome: 'success', reason: attempts[0].reason, iteration: 7,
  });
});

test('INV-RECOVERY-LADDER: converged plan + no diff → execute-converged-plan advanced', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: true, noWorkProduced: false }),
    executeConvergedPlan: () => ({ ok: true }),
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'advanced');
  assert.equal(out.strategy, 'execute-converged-plan');
  assert.equal(attempts.at(-1).strategy, 'execute-converged-plan');
  assert.equal(attempts.at(-1).outcome, 'success');
});

test('INV-RECOVERY-LADDER: converged plan but R-ORSR-3 executor not wired → records failed, escalates', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: true, noWorkProduced: false }),
    // executeConvergedPlan omitted (R-ORSR-3 absent)
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'exhausted');
  const planAttempt = attempts.find(a => a.strategy === 'execute-converged-plan');
  assert.ok(planAttempt && planAttempt.outcome === 'failed');
  assert.match(planAttempt.reason, /R-ORSR-3/);
});

test('INV-RECOVERY-LADDER: zero output → fall_through (existing Failed-flip path)', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: false, noWorkProduced: true }),
  });
  const out = runRecoveryLadder(deps);
  assert.deepEqual(out, { kind: 'fall_through', reason: 'no_work_produced' });
  assert.equal(attempts.at(-1).strategy, 'auto-split');
});

test('INV-LADDER-RUNG-FAILURE: gate green but commit blocked → falls through to fix-forward, both attempts recorded', async () => {
  const { runRecoveryLadder } = await load();
  let commitCalls = 0;
  const { deps, attempts, calls } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: true }),
    commitAndFlipDone: () => { commitCalls += 1; return { ok: false }; }, // blocked by config-protection hook
    spawnRemediator: () => true,
  });
  const out = runRecoveryLadder(deps);
  // commit blocked twice (rung1 + rung2 retry), remediator fired once, then escalate.
  assert.equal(out.kind, 'exhausted');
  assert.equal(calls.remediator, 1, 'fix-forward must spawn the remediator');
  const strategies = attempts.map(a => a.strategy);
  assert.ok(strategies.includes('commit-and-continue'), 'commit-and-continue failure appended');
  assert.ok(strategies.includes('fix-forward-trivial'), 'fix-forward-trivial failure appended');
  const cc = attempts.find(a => a.strategy === 'commit-and-continue');
  assert.equal(cc.outcome, 'failed');
  assert.match(cc.reason, /commit was blocked/);
});

test('INV-LADDER-RUNG-FAILURE: fix-forward remediation succeeds on 2nd gate → advanced', async () => {
  const { runRecoveryLadder } = await load();
  let gateCalls = 0;
  const { deps, calls } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => { gateCalls += 1; return { ok: gateCalls >= 2 }; }, // red, then green after remediation
    commitAndFlipDone: () => ({ ok: true, sha: 'cafef00d' }),
    spawnRemediator: () => true,
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'advanced');
  assert.equal(out.strategy, 'fix-forward-trivial');
  assert.equal(out.sha, 'cafef00d');
  assert.equal(calls.remediator, 1);
});

test('INV-FIX-FORWARD-BOUND: remediator spawned at most M=1 across the ladder', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, calls } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: false }), // never green → remediator can't fix it
    spawnRemediator: () => true,
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'exhausted');
  assert.equal(calls.remediator, 1, 'fix-forward-trivial must spawn at most M=1');
});

test('INV-FIX-FORWARD-BOUND: maxRemediatorSpawns=0 disables the remediator spawn', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, calls } = scriptDeps({
    maxRemediatorSpawns: 0,
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: false }),
    spawnRemediator: () => true,
  });
  runRecoveryLadder(deps);
  assert.equal(calls.remediator, 0);
});

test('INV-RUNG-ERROR-CONTAINED: a throwing commit adapter records failed and never advances', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: true }),
    commitAndFlipDone: () => { throw new Error('half-commit boom'); },
    spawnRemediator: () => false,
  });
  const out = runRecoveryLadder(deps);
  assert.notEqual(out.kind, 'advanced', 'a thrown rung must never yield advanced');
  const cc = attempts.find(a => a.strategy === 'commit-and-continue');
  assert.equal(cc.outcome, 'failed');
  assert.match(cc.reason, /threw/);
});

test('INV-RUNG-ERROR-CONTAINED: a throwing executeConvergedPlan is contained', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: true, noWorkProduced: false }),
    executeConvergedPlan: () => { throw new Error('plan boom'); },
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'exhausted');
  const p = attempts.find(a => a.strategy === 'execute-converged-plan');
  assert.equal(p.outcome, 'failed');
  assert.match(p.reason, /threw/);
});

test('escalate: no recoverable evidence → exhausted with one escalate attempt', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps(); // all-false evidence by default
  const out = runRecoveryLadder(deps);
  assert.deepEqual(out, { kind: 'exhausted', reason: 'ladder_exhausted' });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].strategy, 'escalate');
});

test('evidence assessment throwing is contained → exhausted(evidence_unreadable)', async () => {
  const { runRecoveryLadder } = await load();
  const { deps, attempts } = scriptDeps({
    assessEvidence: () => { throw new Error('cannot read tree'); },
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'exhausted');
  assert.equal(out.reason, 'evidence_unreadable');
  assert.equal(attempts[0].strategy, 'escalate');
});

test('ledger append failure is best-effort (does not abort the ladder)', async () => {
  const { runRecoveryLadder } = await load();
  const { deps } = scriptDeps({
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => ({ ok: true }),
    commitAndFlipDone: () => ({ ok: true, sha: 'abc1234' }),
    appendAttempt: () => { throw new Error('state write failed'); },
  });
  const out = runRecoveryLadder(deps);
  assert.equal(out.kind, 'advanced'); // recovery still advances despite ledger write failure
});
