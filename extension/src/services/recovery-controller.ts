/**
 * R-ORSR-2 — RecoveryController: the spine of the B-ORSR recovery state machine.
 *
 * Replaces the "stalled iteration → terminal park" edge with an ordered strategy
 * ladder. On a stalled/failed iteration the runner runs the ladder and only emits
 * a terminal (`recovery_exhausted`, from R-ORSR-1) after the ladder is exhausted —
 * the babysitter's playbook, made native (PRD: B-ORSR, approach #1).
 *
 * The controller is dependency-injected: every side-effect (armed gate, commit,
 * remediator spawn, converged-plan execution, ledger append) is a callback. This
 * keeps the invariants testable with a scripted worker — the tests script the
 * evidence and adapter results without real subprocesses — and keeps the runtime
 * wiring (mux-runner.ts) the sole owner of the concrete adapters, including the
 * R-PEDC guard/clear Done-flip pair.
 */
import type { RecoveryAttempt } from '../types/index.js';

/** Ordered ladder rungs (PRD B-ORSR §Solution). */
export type RecoveryStrategy =
  | 'commit-and-continue'
  | 'fix-forward-trivial'
  | 'execute-converged-plan'
  | 'auto-split'
  | 'escalate';

/**
 * The ladder's verdict for the caller:
 * - `advanced`     — a rung recovered; the ticket was committed/flipped Done or its
 *                    converged plan executed. Caller continues the loop (no park).
 * - `fall_through` — genuine zero-output (`no_work_produced`); caller proceeds to the
 *                    EXISTING `oversized_no_progress` / terminal Failed-flip (auto-split
 *                    is down-scoped: no runtime decomposition — follow-up R-ONPD-FU).
 * - `exhausted`    — N distinct strategies were attempted and failed; caller emits the
 *                    honest terminal `recovery_exhausted` (NOT `closer_handoff_terminal`).
 */
export type RecoveryOutcome =
  | { kind: 'advanced'; strategy: RecoveryStrategy; sha?: string }
  | { kind: 'fall_through'; reason: string }
  | { kind: 'exhausted'; reason: string };

/** Evidence the runner already has on a stalled iteration (tree, plan, output). */
export interface RecoveryEvidence {
  /** Uncommitted changes exist in the working tree. */
  treeDirty: boolean;
  /** An approved plan + artifacts exist but no diff landed (R-ORSR-3 domain). */
  planConvergedUncommitted: boolean;
  /** Genuinely zero output at timeout (no tree delta, no plan). */
  noWorkProduced: boolean;
}

export interface RecoveryDeps {
  iteration: number;
  ticketId: string;
  /** Read the current recovery evidence (tree/plan/output). */
  assessEvidence: () => RecoveryEvidence;
  /**
   * Run the ARMED whole-repo gate. MUST ignore `flags.skip_quality_gates_reason`
   * and consume the real whole-repo result (R-ORSR-6) — never a skip-flagged green.
   */
  runArmedGate: () => { ok: boolean };
  /**
   * Commit the dirty tree and flip the ticket Done with an auto `completion_commit`,
   * routed through the R-PEDC guard/clear pair. Adapter owns atomicity: it must NOT
   * leave an orphaned half-commit on failure. Returns `{ok:false}` when blocked
   * (e.g. the R-WSRC config-protection hook refused the commit).
   */
  commitAndFlipDone: () => { ok: boolean; sha?: string };
  /** Spawn the existing gate remediator once. Returns true when it exited ok. */
  spawnRemediator: () => boolean;
  /** R-ORSR-3 seam: execute the converged plan as atomic per-finding commits. */
  executeConvergedPlan?: () => { ok: boolean };
  /** Append one entry to `state.recovery_attempts[]`. */
  appendAttempt: (attempt: RecoveryAttempt) => void;
  log: (msg: string) => void;
  /** fix-forward-trivial bound (M). Default 1. */
  maxRemediatorSpawns?: number;
}

/**
 * Run the ordered recovery ladder. Each rung is attempted at most once per call and
 * appends a `RecoveryAttempt` to the ledger on every outcome. A rung whose adapter
 * throws records a `failed` attempt and the ladder advances — a throw can never
 * yield `advanced`, so no orphaned half-commit can ride to Done (INV-RUNG-ERROR-CONTAINED).
 */
export function runRecoveryLadder(deps: RecoveryDeps): RecoveryOutcome {
  const maxSpawns = Number.isInteger(deps.maxRemediatorSpawns) && (deps.maxRemediatorSpawns as number) >= 0
    ? (deps.maxRemediatorSpawns as number)
    : 1;
  let remediatorSpawns = 0;

  const record = (strategy: RecoveryStrategy, outcome: 'success' | 'failed', reason: string): void => {
    try {
      deps.appendAttempt({ strategy, outcome, reason, iteration: deps.iteration });
    } catch { /* ledger append is best-effort — never block recovery on a state write */ }
  };

  let evidence: RecoveryEvidence;
  try {
    evidence = deps.assessEvidence();
  } catch (err) {
    record('escalate', 'failed', `evidence assessment threw: ${errText(err)}`);
    return { kind: 'exhausted', reason: 'evidence_unreadable' };
  }

  // Rung 1 — commit-and-continue: dirty tree + ARMED gate passes → commit, flip Done.
  if (evidence.treeDirty) {
    try {
      if (deps.runArmedGate().ok) {
        const r = deps.commitAndFlipDone();
        if (r.ok) {
          record('commit-and-continue', 'success', `committed gate-passing tree for ${deps.ticketId}`);
          deps.log(`recovery: commit-and-continue advanced ${deps.ticketId}${r.sha ? ` (${r.sha})` : ''}`);
          return { kind: 'advanced', strategy: 'commit-and-continue', sha: r.sha };
        }
        // INV-LADDER-RUNG-FAILURE: commit blocked (e.g. config-protection hook) →
        // record + fall through to fix-forward-trivial, NOT to a terminal.
        record('commit-and-continue', 'failed', `armed gate passed but commit was blocked for ${deps.ticketId}`);
      }
      // gate red — not a commit-and-continue case; fix-forward-trivial owns it.
    } catch (err) {
      record('commit-and-continue', 'failed', `commit-and-continue threw: ${errText(err)}`);
    }

    // Rung 2 — fix-forward-trivial: spawn the remediator (bounded), re-gate, retry commit.
    if (remediatorSpawns < maxSpawns) {
      try {
        remediatorSpawns += 1;
        const remediated = deps.spawnRemediator();
        if (remediated && deps.runArmedGate().ok) {
          const r = deps.commitAndFlipDone();
          if (r.ok) {
            record('fix-forward-trivial', 'success', `remediated + committed ${deps.ticketId}`);
            deps.log(`recovery: fix-forward-trivial advanced ${deps.ticketId}${r.sha ? ` (${r.sha})` : ''}`);
            return { kind: 'advanced', strategy: 'fix-forward-trivial', sha: r.sha };
          }
          record('fix-forward-trivial', 'failed', `remediated + gate green but commit still blocked for ${deps.ticketId}`);
        } else {
          record('fix-forward-trivial', 'failed', `remediator ${remediated ? 're-gate still red' : 'failed'} for ${deps.ticketId}`);
        }
      } catch (err) {
        record('fix-forward-trivial', 'failed', `fix-forward-trivial threw: ${errText(err)}`);
      }
    } else {
      deps.log(`recovery: fix-forward-trivial bound (M=${maxSpawns}) reached for ${deps.ticketId}`);
    }
  }

  // Rung 3 — execute-converged-plan: approved plan + artifacts, no diff (R-ORSR-3 seam).
  if (evidence.planConvergedUncommitted) {
    if (deps.executeConvergedPlan) {
      try {
        const r = deps.executeConvergedPlan();
        if (r.ok) {
          record('execute-converged-plan', 'success', `executed converged plan for ${deps.ticketId}`);
          deps.log(`recovery: execute-converged-plan advanced ${deps.ticketId}`);
          return { kind: 'advanced', strategy: 'execute-converged-plan' };
        }
        record('execute-converged-plan', 'failed', `converged-plan execution returned not-ok for ${deps.ticketId}`);
      } catch (err) {
        record('execute-converged-plan', 'failed', `execute-converged-plan threw: ${errText(err)}`);
      }
    } else {
      // R-ORSR-3 (e8f46d84) owns the executor contract; until it lands, record the
      // attempt and fall down the ladder rather than parking.
      record('execute-converged-plan', 'failed', 'R-ORSR-3 converged-plan executor not wired yet');
    }
  }

  // Rung 4 — auto-split (DOWN-SCOPED): genuine zero-output → fall through to the
  // EXISTING oversized_no_progress / terminal Failed-flip. True runtime decomposition
  // is a follow-up (R-ONPD-FU).
  if (evidence.noWorkProduced) {
    record('auto-split', 'failed', 'no_work_produced — falling through to existing oversized_no_progress Failed-flip');
    return { kind: 'fall_through', reason: 'no_work_produced' };
  }

  // Rung 5 — escalate: the ladder is exhausted. Honest terminal.
  record('escalate', 'failed', 'recovery ladder exhausted without a recoverable signal');
  return { kind: 'exhausted', reason: 'ladder_exhausted' };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
