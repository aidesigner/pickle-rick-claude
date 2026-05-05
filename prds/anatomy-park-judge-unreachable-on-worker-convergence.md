# PRD: `validateWorkerConvergenceHistory` Returns `judge_unreachable` After Successful Worker-Managed Convergence (anatomy-park, szechuan-sauce)

**Status**: Bug PRD (2026-05-05) — production-blocking for any `/pickle-pipeline` run that includes anatomy-park or szechuan-sauce. Reproduced live during `pipeline-2026-05-04-8aecd4c7` (`/pickle-pipeline` over `INCOME_EXPANSION_FIX_PRD.md` in `loanlight-api-income-expansion`).
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `anatomy-park-finalizer-history-crash.md` (shipped v1.63.0, T1). Same root cause class — code that assumes `mvState.convergence.history` is populated under worker-managed convergence — different code path.

---

## Problem

`microverse-runner.js:validateWorkerConvergenceHistory()` (lines 447–474) is invoked from `handleWorkerManagedIteration()` (line 521) **after** the worker has signaled `converged: true` in its convergence file. The guard requires:

```js
const history = currentMv.convergence?.history?.filter(Boolean) ?? [];
const hasEnoughHistory = history.length >= requiredHistoryLength;
const hasScoredHistory = history.some(entry => entry.score !== null && entry.score !== undefined);
if (hasEnoughHistory && hasScoredHistory) return null;
```

For worker-managed phases (anatomy-park, szechuan-sauce) the metric type is `'none'` and the runner explicitly logs `Baseline measurement skipped — metric type 'none' has no measurement branch`. Nothing populates `mvState.convergence.history`. The guard's invariant cannot be satisfied. Result:

- `history.length === 0` and `hasScoredHistory === false`
- guard returns `{ converged: false, reason: 'judge unreachable: ...', exitReason: 'judge_unreachable' }`
- `handleWorkerManagedIteration()` returns `converged: false` despite the worker writing `converged: true`
- microverse-runner reaches max iterations (or stalls) and exits 1
- `pipeline-runner.js` sees the non-zero exit and aborts subsequent phases (`Phase anatomy-park failed (exit 1) — stopping pipeline`)
- **Szechuan-sauce never runs.**

The work was correct: the worker recorded 2 clean iterations, `consecutive_clean=3`, `converged: true`, 0 trap doors. The orchestrator threw it away.

### Live evidence (`pipeline-2026-05-04-8aecd4c7`)

`anatomy-park.json`:
```json
{
  "subsystems": ["packages"],
  "consecutive_clean": { "packages": 3 },
  "converged": true,
  "reason": "Confirmed across two iterations. ... no trap doors pending."
}
```

`microverse-runner.log`:
```
[02:10:24] Baseline measurement skipped — metric type 'none' has no measurement branch
[02:11:43] [anatomy-park] initialized per-iteration gate baseline (captured 4 pre-existing failure(s))
[02:11:43] --- Iteration 2 ---
[02:15:38] Iteration 2 — worker convergence signaled; running per-iteration gate before exit
[02:15:38] Iteration 2 — judge unreachable: convergence history length 0/1, scored=false
```

`pipeline-runner.log`:
```
[02:15:39] Phase anatomy-park exited with code 1
[02:15:39] Phase anatomy-park failed (exit 1) — stopping pipeline
[02:15:39] Pipeline finished: 2/4 phases, 186m 21s
```

---

## Root cause

The same architectural assumption that produced `anatomy-park-finalizer-history-crash` (shipped v1.63.0) reappeared in a guard added afterwards. Worker-managed convergence intentionally bypasses the `metric` track — the worker is the judge — but `validateWorkerConvergenceHistory` was written as if `convergence.history` is universally populated.

Two facts about the runtime that the guard ignores:

1. **Metric type `'none'`** disables `measureMetric()` entirely. Nothing writes to `convergence.history`. This is documented behavior, not a bug to compensate for.
2. **The worker's convergence file** (`anatomy-park.json` / `szechuan-sauce.json`) is the authoritative judge for worker-mode phases. It already encodes the audit trail (`findings_history`, `consecutive_clean`, `pass_counts`).

The guard belongs to the metric track, not the worker track.

---

## Fix

Skip `validateWorkerConvergenceHistory` when the microverse `metric_type` is `'none'` (or, equivalently, when the phase is one of the worker-managed phases). The worker's own convergence file is the source of truth — if it says `converged: true`, the orchestrator must honor it.

### Implementation outline (`extension/src/bin/microverse-runner.ts`)

```ts
// Before line 521 in handleWorkerManagedIteration():
if (converged) {
  const metricType = currentMv.metric?.type ?? currentMv.metric_type ?? 'none';
  if (metricType === 'none') {
    // Worker-managed phase: convergence file is authoritative; skip the metric-track guard.
    return { currentMv, converged: true, reason };
  }
  const guardResult = validateWorkerConvergenceHistory({ ... });
  if (guardResult) return { currentMv, ...guardResult };
}
```

Alternative gate: pin the guard to a known set of metric-mode microverse phases via an explicit allowlist (`['perf', 'coverage', 'lint']`) rather than excluding `'none'`. Either is acceptable; the test contract is identical.

---

## Acceptance Criteria (machine-checkable)

| ID | Criterion | Verify |
|----|-----------|--------|
| AC1 | When `metric_type === 'none'` and worker writes `converged: true`, `handleWorkerManagedIteration` returns `converged: true` | unit spec `validateWorkerConvergenceHistory skips on metric_type=none` passes |
| AC2 | When `metric_type === 'perf'` and `convergence.history` is empty after worker convergence, the existing `judge_unreachable` guard still fires | unit spec `validateWorkerConvergenceHistory still guards metric mode` passes |
| AC3 | Anatomy-park completes with exit 0 when the worker writes `converged: true` and 2+ clean iterations | integration spec replays a fixture matching `pipeline-2026-05-04-8aecd4c7/anatomy-park.json` and asserts exit 0 |
| AC4 | Szechuan-sauce phase runs in the pipeline-e2e fixture after anatomy-park converges | `tests/integration/pipeline-e2e.test.js` asserts `pipeline-status.json.completed_phases === 4` |
| AC5 | Existing finalizer-history guard still passes (regression check on the v1.63.0 sibling fix) | `tests/microverse-runner.test.js` and `tests/services/convergence-gate.test.js` green |
| AC6 | The `judge_unreachable` activity-log event still fires for legitimate metric-mode failures (not over-suppressed) | unit spec assertions on `logActivityFn.calls` for metric-mode case |

---

## Trap doors / known traps

1. **`metric_type` source-of-truth drift.** The microverse object exposes both `metric.type` (newer schema) and a top-level `metric_type` (older fixtures). The guard must read both with a deterministic precedence — recommend `currentMv.metric?.type ?? currentMv.metric_type ?? 'none'`.
2. **Default of `'none'`.** If `metric` is missing entirely, the safest default is `'none'` (worker-managed). Any phase running in metric mode sets it explicitly.
3. **Activity-log event parity.** Tests in `tests/services/activity-logger-gate-payload.test.js` may assert `judge_unreachable` is emitted on the original failure path. Update those tests so the worker-mode skip does NOT emit `judge_unreachable` — that event must remain a real-failure signal.
4. **Per-iteration gate independence.** The per-iteration gate hook (`runPerIterationGateHook`) runs before this guard and sets `iteration_regressions`. The fix must NOT skip the gate hook — only the post-hook history check. The order in `handleWorkerManagedIteration` already runs the hook first; preserve that.
5. **Phase-runner downstream.** `pipeline-runner.js:phase anatomy-park exited with code N` decides pipeline halt on `code !== 0`. Confirm the runner's exit code path returns 0 on legitimate worker convergence after the fix — test by inspecting `process.exitCode` at end of `runConvergenceLoop()` (microverse-runner.js).

---

## Verification commands (post-fix)

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
npm test -- tests/microverse-runner.test.js
npm test -- tests/services/convergence-gate.test.js
npm test -- tests/integration/pipeline-e2e.test.js
npm test -- tests/anatomy-park-scope.test.js
bash install.sh
# Then re-run the failed pipeline (or a fixture replay):
node "$HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js" \
  /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-04-8aecd4c7
# Expect: 4/4 phases completed, exit 0.
```

---

## Out of scope

- Refactoring the metric-track / worker-track split into clearly separated files (the right long-term fix; out of scope for this hotfix).
- Persisting a synthetic `convergence.history` entry from the worker's `findings_history` (not necessary; only delays the inevitable conflation).
- Backporting to older deployed versions — fix-forward via `bash install.sh`.

---

## Related

- `anatomy-park-finalizer-history-crash.md` (shipped v1.63.0, T1) — direct sibling.
- `microverse-runner-stall-resilience.md` (shipped v1.63.0, T5).
- `anatomy-park-followups.md` Sub-fix A+C (shipped v1.63.0, T6+T2).
