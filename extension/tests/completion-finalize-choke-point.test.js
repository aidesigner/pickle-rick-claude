// @tier: fast
//
// B-GROUND2 WS1 (ce5d1cc8): ONE parametrized matrix for the single completion /
// phase-graduation choke point.
//   - the pure proportional gate `graduationDecision` over the boundary table.
//   - the `finalizeIfTrulyComplete` authority: graduate vs refuse (fail-closed),
//     single-fire (exactly one exit_reason write).
// Plus the forward-protection lint over BOTH source seams:
//   - the finalize seam: `finalizeIfTrulyComplete(` wired in mux-runner.ts AND
//     pipeline-runner.ts; no raw `finalizeTerminalState(... exitReason:'completed'|'success')`
//     in either file (the 18th synthetic unrouted finalize fails the predicate).
//   - the phase-graduate seam: the three former guards' `exitCode !== 0` early-return
//     is GONE and the unified `maybeStampPhaseGraduation` delegates to `graduationDecision`.
//
// MUST remain ONE parametrized file — do NOT fan out per seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { graduationDecision, finalizeIfTrulyComplete } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.join(__dirname, '..', 'src', 'bin', 'mux-runner.ts');
const PIPE_SRC = path.join(__dirname, '..', 'src', 'bin', 'pipeline-runner.ts');

// ---------------------------------------------------------------------------
// The proportional gate boundary table (from Test Expectations).
// ---------------------------------------------------------------------------

// counts: { doneCount, commitCount, pendingCount, ticketCount }
const GATE_CASES = [
  { name: '24done/24 (clean) -> graduate', counts: { doneCount: 24, commitCount: 0, pendingCount: 0, ticketCount: 24 }, expect: { decision: 'graduate' } },
  { name: '24done/24 (breaker) -> graduate (decision by-invariant on counts, not exitCode)', counts: { doneCount: 24, commitCount: 0, pendingCount: 0, ticketCount: 24 }, expect: { decision: 'graduate' } },
  { name: '47done/49 +2skip (clean) -> graduate (pendingCount==0)', counts: { doneCount: 47, commitCount: 0, pendingCount: 0, ticketCount: 49 }, expect: { decision: 'graduate' } },
  { name: '0done/22skip/2todo of 24 -> HALT (skip-dampen trap)', counts: { doneCount: 0, commitCount: 0, pendingCount: 2, ticketCount: 24 }, expect: { decision: 'halt', reason: 'phase_no_progress' } },
  { name: '10done/24 (breaker) -> HALT pipeline_phase_incomplete', counts: { doneCount: 10, commitCount: 0, pendingCount: 14, ticketCount: 24 }, expect: { decision: 'halt', reason: 'pipeline_phase_incomplete' } },
  { name: '23done/24 (breaker) -> HALT', counts: { doneCount: 23, commitCount: 0, pendingCount: 1, ticketCount: 24 }, expect: { decision: 'halt', reason: 'pipeline_phase_incomplete' } },
  { name: 'ticketCount==0 -> graduate (carve-out)', counts: { doneCount: 0, commitCount: 0, pendingCount: 0, ticketCount: 0 }, expect: { decision: 'graduate' } },
];

describe('graduationDecision — proportional gate boundary table', () => {
  for (const c of GATE_CASES) {
    it(c.name, () => {
      const out = graduationDecision(c.counts);
      assert.equal(out.decision, c.expect.decision);
      if (c.expect.decision === 'halt') { assert.equal(out.reason, c.expect.reason); }
    });
  }

  it('never keys on the bare pendingCount/ticketCount ratio (commit-only progress with pending still halts)', () => {
    // 0 done but commits landed + pending remain -> partial progress -> pipeline_phase_incomplete,
    // NOT graduate (a ratio gate would graduate at 2/24).
    const out = graduationDecision({ doneCount: 0, commitCount: 3, pendingCount: 2, ticketCount: 24 });
    assert.deepEqual(out, { decision: 'halt', reason: 'pipeline_phase_incomplete' });
  });

  it('(47 done, 2 Todo) clean-vs-breaker each have the same asserted outcome (decision is by-invariant)', () => {
    // pendingCount==2 (not 0): both clean and breaker HALT — the decision does NOT depend on exit code.
    const counts = { doneCount: 47, commitCount: 0, pendingCount: 2, ticketCount: 49 };
    assert.deepEqual(graduationDecision(counts), { decision: 'halt', reason: 'pipeline_phase_incomplete' });
  });
});

// ---------------------------------------------------------------------------
// finalizeIfTrulyComplete — authority: graduate / refuse / fail-closed / single-fire.
// ---------------------------------------------------------------------------

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-choke-'));
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

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

describe('finalizeIfTrulyComplete — authority', () => {
  it('graduates a truly-complete bundle (pendingCount==0): finalizes terminal state', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(
      statePath,
      () => ({ doneCount: 3, commitCount: 0, pendingCount: 0, ticketCount: 3 }),
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, true);
    const s = readState(statePath);
    assert.equal(s.active, false);
    assert.equal(s.step, 'completed');
    assert.equal(s.current_ticket, null);
    assert.equal(s.exit_reason, 'completed');
  });

  it('REFUSES with pending tickets — stamps the incomplete reason, no terminal step', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(
      statePath,
      () => ({ doneCount: 1, commitCount: 0, pendingCount: 2, ticketCount: 3 }),
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, false);
    assert.equal(r.reason, 'pipeline_phase_incomplete');
    const s = readState(statePath);
    assert.equal(s.active, true, 'must NOT deactivate on refusal');
    assert.equal(s.current_ticket, 't1', 'must NOT null current_ticket on refusal');
    assert.equal(s.exit_reason, 'pipeline_phase_incomplete');
  });

  it('fail-closed: a THROWING scan yields no finalize and stamps pipeline_phase_incomplete', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(
      statePath,
      () => { throw new Error('scan exploded'); },
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, false);
    assert.equal(r.reason, 'pipeline_phase_incomplete');
    const s = readState(statePath);
    assert.equal(s.active, true);
    assert.equal(s.exit_reason, 'pipeline_phase_incomplete');
  });

  it('fail-closed: a null scan (empty-where-roster-expected) refuses', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(
      statePath,
      () => null,
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, false);
    assert.equal(r.reason, 'pipeline_phase_incomplete');
    assert.equal(readState(statePath).exit_reason, 'pipeline_phase_incomplete');
  });

  it('ticketCount==0 carve-out graduates (never-decomposed session)', () => {
    const { statePath } = makeState();
    const r = finalizeIfTrulyComplete(
      statePath,
      () => ({ doneCount: 0, commitCount: 0, pendingCount: 0, ticketCount: 0 }),
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(r.finalized, true);
    assert.equal(readState(statePath).active, false);
  });

  it('single-fire: clean exit + pending stamps exactly ONE exit_reason (scan invoked once)', () => {
    const { statePath } = makeState();
    let scanCount = 0;
    finalizeIfTrulyComplete(
      statePath,
      () => { scanCount += 1; return { doneCount: 1, commitCount: 0, pendingCount: 1, ticketCount: 2 }; },
      { step: 'completed', exitReason: 'completed' },
    );
    assert.equal(scanCount, 1, 'scan probe must be invoked exactly once');
    assert.equal(readState(statePath).exit_reason, 'pipeline_phase_incomplete');
  });
});

// ---------------------------------------------------------------------------
// Forward-protection lint — BOTH the finalize seam and the phase-graduate seam.
// ---------------------------------------------------------------------------

function readSrc(p) {
  return fs.readFileSync(p, 'utf-8');
}

/** Multi-line-aware: capture each finalizeTerminalState( call to its balanced close paren. */
function finalizeCalls(src) {
  const out = [];
  const re = /finalizeTerminalState\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') { depth += 1; }
      else if (c === ')') { depth -= 1; }
      i += 1;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

const COMPLETION_FINALIZE_RE = /exitReason:\s*["'](completed|success)["']/;

describe('forward-protection lint — finalize seam', () => {
  it('finalizeIfTrulyComplete is wired in BOTH mux-runner.ts and pipeline-runner.ts', () => {
    assert.match(readSrc(MUX_SRC), /finalizeIfTrulyComplete\s*\(/, 'mux-runner must call the authority');
    assert.match(readSrc(PIPE_SRC), /finalizeIfTrulyComplete\s*\(/, 'pipeline-runner must call the authority');
  });

  it('no raw finalizeTerminalState with a completion exitReason survives in mux/pipeline', () => {
    for (const [name, p] of [['mux-runner.ts', MUX_SRC], ['pipeline-runner.ts', PIPE_SRC]]) {
      for (const call of finalizeCalls(readSrc(p))) {
        assert.ok(!COMPLETION_FINALIZE_RE.test(call),
          `${name} has a raw completion finalize that must route through finalizeIfTrulyComplete: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  });

  it('a NEW synthetic unrouted completion finalize fails the lint predicate (default-deny)', () => {
    const synthetic = "finalizeTerminalState(statePath, { step: 'completed', exitReason: 'completed' });";
    assert.ok(COMPLETION_FINALIZE_RE.test(synthetic),
      'the 18th synthetic unrouted finalize must trip the completion-finalize predicate');
    // And the real sources do NOT trip it (proves the predicate is not vacuous).
    for (const p of [MUX_SRC, PIPE_SRC]) {
      const tripped = finalizeCalls(readSrc(p)).some(c => COMPLETION_FINALIZE_RE.test(c));
      assert.equal(tripped, false);
    }
  });
});

describe('forward-protection lint — phase-graduate seam', () => {
  it('the three former guards collapsed into one delegating gate (maybeStampPhaseGraduation)', () => {
    const src = readSrc(PIPE_SRC);
    assert.match(src, /function maybeStampPhaseGraduation\(/, 'the unified gate must exist');
    // The retired per-seam guards must be gone.
    assert.ok(!/function maybeStampPhaseNoProgress\(/.test(src), 'maybeStampPhaseNoProgress must be collapsed');
    assert.ok(!/function maybeStampPhaseIncompleteTickets\(/.test(src), 'maybeStampPhaseIncompleteTickets must be collapsed');
    assert.ok(!/function maybeStampPicklePendingTickets\(/.test(src), 'maybeStampPicklePendingTickets must be collapsed');
  });

  it('the byte-identical exitCode!==0 early-return is GONE (R-DPMC-2 bypass closed)', () => {
    const src = readSrc(PIPE_SRC);
    // The literal bypass pattern that opened all three guards.
    assert.ok(!/rawPhase !== 'pickle' \|\| exitCode !== 0\) return null;/.test(src),
      'the exitCode!==0 early-return must be lifted out of the phase-exit guards');
  });

  it('the unified gate delegates to graduationDecision (single proportional gate)', () => {
    const src = readSrc(PIPE_SRC);
    assert.match(src, /graduationDecision\(/, 'the gate must delegate to the shared proportional predicate');
  });
});
