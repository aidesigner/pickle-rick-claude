# PRD: Szechuan-Sauce LLM Judge Non-Deterministic Scoring → False-Stall (P1)

**Status**: Bug PRD (2026-05-09) — `metric.type === 'llm'` szechuan-sauce sessions stall on the convergence floor even when real slop is being removed every iteration.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**:
- `prds/szechuan-sauce-codex-judge-model-mismatch.md` — judge spawn model mismatch on `--backend codex` (different failure: silent BestScore=0 false-convergence). THIS PRD addresses a *different* failure mode under the same metric path: spurious *stalls* when the judge runs successfully but emits non-stable counts.
- `prds/anatomy-park-judge-unreachable-on-worker-convergence.md` — judge unreachable on worker-mode anatomy-park. Same `microverse-runner` family but different code path; not duplicated here.
- `prds/convergence-toolchain-gates.md` / `prds/convergence-v8-topology.md` — broader convergence design context. THIS PRD is a concrete bug under the v8 topology.
**Triggering session**: `2026-05-09-92dbdff2` — `/szechuan-sauce --backend codex packages/api/src/lib/appraisal-pipeline` post-anatomy-park cleanup on `loanlight-api@gregory/1025-appraisal-epic`. Iteration 9 / 50, 8 commits landed, score stuck at 5 for 4 consecutive iterations (stall_counter 4/5).

---

## Severity: P1

- **Convergence-blocking**: stall_counter increments on `held` even when commits are demonstrably removing real principle violations — a single more `held` triggers `stall_limit` exit, ending a session that's still making progress. False-stall is the symmetric failure to false-convergence (already covered in the codex-judge-model-mismatch PRD).
- **Misleading the operator**: `microverse.json.convergence.history` shows score=5 four times in a row with `classification: "held"` and `failure_class: "no_progress"` — but the actual content of those 5 violations is *different every iteration* (see Evidence below). The operator looking at the score has no signal that the worker is making progress.
- **Wastes worker effort**: every iteration after the score plateau still costs an LLM judge invocation (~5–10min per iteration) and codex worker call, with no convergence credit. Over a 50-iteration ceiling this can burn hours of budget on a "stalled" loop that's actually fixing things.
- **Cannot be worked around with stall_limit tuning**: raising `stall_limit` defers the exit but doesn't fix the underlying signal — at some point the score still plateaus at the LLM's natural N-violations-per-fresh-scan floor and the loop stalls anyway.

---

## Symptom (observed)

`/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-09-92dbdff2/microverse.json` after iter 8:

```json
{
  "convergence": {
    "stall_limit": 5,
    "stall_counter": 4,
    "history": [
      { "iteration": 2, "score": 8, "classification": "improved", "description": "improved: 8 vs 22" },
      { "iteration": 3, "score": 6, "classification": "improved", "description": "improved: 6 vs 8" },
      { "iteration": 4, "score": 5, "classification": "improved", "description": "improved: 5 vs 6" },
      { "iteration": 5, "score": 5, "classification": "held", "description": "held: 5 vs 5" },
      { "iteration": 6, "score": 5, "classification": "held", "description": "held: 5 vs 5" },
      { "iteration": 7, "score": 5, "classification": "held", "description": "held: 5 vs 5" },
      { "iteration": 8, "score": 5, "classification": "held", "description": "held: 5 vs 5" }
    ]
  },
  "failure_history": [
    { "iteration": 7, "failure_class": "no_progress", "description": "held: 5 vs 5" },
    { "iteration": 8, "failure_class": "no_progress", "description": "held: 5 vs 5" }
  ],
  "convergence_target": 0,
  "baseline_score": 22
}
```

Meanwhile, the actual commits during the "held" plateau (iters 5–8):

```
708a1645d  szechuan-sauce: Observability — structure agentic strategy failure logging
89d10639b  szechuan-sauce: Observability — use Nest logger in stale cleanup
b09312bff  szechuan-sauce: Observability — use Nest logger in OCR preprocessor
2fbd16489  szechuan-sauce: Observability — structure agentic verbose logging
```

Each of these is a real fix that closes a specific principle violation (CLAUDE.md "never `console.*`" mandate). Yet the score does not budge.

The underlying contradiction surfaces when the iteration `metric_value` raw text is inspected:

| Iter | Score | Five violations the judge actually listed |
|------|-------|--------------------------------------------|
| 5 | 5 | ensemble-voter dead code, duplicate cost constants, console.* in ocr-preprocessor, console.* in stale-cleanup, console.* in agentic-orchestrator |
| 6 | 5 | ensemble-voter dead code, duplicate cost constants, **extractSalesCompPage god function**, **detectBinaryChoice large function**, **findCompColumnAnchors large function** |
| 7 | 5 | (terse — judge emitted only "5") |
| 8 | 5 | ensemble-voter dead code, duplicate cost constants, **getLineItems duplicated across 4 generators**, **SectionAnchor interface duplicated in 4 files**, **SOURCE_BONUS_MID no-op branch** |

Iter 5 and iter 6 share two violations and disagree on three. Iter 8 has only two of iter 5's five and three entirely new ones. By iter 8 the worker has fixed *all three* `console.*` violations the iter-5 judge listed — yet the score is the same.

The judge is doing fresh scans with non-deterministic 5-violation cap. The numerical score happens to plateau at 5 because the codebase has more than 5 candidate violations at any time and the LLM tends to surface the most visible 5 on each fresh read.

---

## Root Cause

### Code path

`extension/src/bin/microverse-runner.ts:1145-1186` — `buildJudgePrompt` constructs the LLM judge prompt with:

1. The goal text (`"Number of coding principle violations (lower is better)"`)
2. The scoring-reference path (`szechuan-sauce-principles.md`)
3. The target code path
4. Previous iteration history as **one-line score summaries**: `"- Iteration N: score=X action=accept — improved: X vs Y"`
5. Instruction: `"Score the current state against the goal. Output ONLY a single integer or decimal number on the LAST line."`

The judge is given **no stable violation IDs**, no "what was fixed since last iteration," and no instruction to consider "are these the SAME violations I named last time?" It does a fresh code read and emits a count.

`extension/src/services/microverse-state.ts:143-160` — `compareMetric` is purely numeric:

```ts
if ((direction ?? 'higher') === 'lower') {
  if (current < previous - tolerance) return 'improved';
  if (current > previous + tolerance) return 'regressed';
  return 'held';
}
```

This is correct for deterministic metrics (LOC, coverage %). It composes badly with a non-deterministic LLM judge whose 5-violation output is content-mutable but count-stable on any non-trivial codebase.

### Why iter 4 was the last `improved`

The first 3 iterations clear obvious slop (god function, mass `console.*` removal, dead modules). Each removal drops the visible-candidate count enough that the LLM judge's "pick 5" heuristic returns 8 → 6 → 5. From iter 5 onward the codebase still has well more than 5 P2/P3 violations available — the judge picks 5 different ones each time, score plateaus at 5, `compareMetric` returns `held` every time.

### Why anatomy-park does NOT have this bug

`anatomy-park.json` (the worker-managed convergence file) maintains a **stable, IDed `findings_history` per subsystem**. Convergence is *per-subsystem `consecutive_clean: 2`* — i.e., two passes that found ZERO findings on that subsystem — not a numerical count comparison. New finding emergence and old finding resolution are tracked structurally, with stable IDs of the form `<subsystem>-<date>-<slug>`.

szechuan-sauce uses the LLM-judge metric path (`metric.type === 'llm'`) which has none of that structure.

---

## Acceptance Criteria

R-SLLJ-1 (P1, R-MUST): `microverse.json.convergence.history[i].classification` MUST reflect *actual progress* on the principle-violation set, not just numerical equality of scores. When the worker has resolved at least one violation that was named in `convergence.history[i-1]` AND has not introduced any new violation, the classification MUST be `improved` even if the *count* of violations the judge surfaces this iteration equals the previous count.

R-SLLJ-2 (P1, R-MUST): when `metric.type === 'llm'`, the judge MUST receive a stable violation ledger or equivalent diff-aware context — not just a one-line `score=N` summary of prior iterations. At minimum, the prompt must include the prior iteration's full violation list so the judge can answer "are these the SAME?" deterministically.

R-SLLJ-3 (P1, R-MUST): false-stall regression test — given a fixture `microverse.json` whose `metric_value` text shows different content but same numeric score for N≥3 consecutive iterations, the runner's stall logic MUST NOT increment `stall_counter` when at least one prior-listed violation has been resolved by intervening commits. Today this triggers a stall every time.

R-SLLJ-4 (P2, R-SHOULD): convergence history MUST persist a structured violation list per iteration — stable IDs, file:line references, principle name, confidence — not just the raw judge text. Today only `metric_value: <raw judge output>` is captured, which means downstream tooling (citadel, /pickle-status) cannot detect "same N, different content" themselves.

R-SLLJ-5 (P2, R-SHOULD): `gap_analysis.md` is already maintained by the szechuan-sauce worker (per `.claude/commands/szechuan-sauce.md` Override 3 step 5). The judge SHOULD consume `gap_analysis.md` as ground truth and only re-validate items the worker claims to have resolved, instead of doing a blind fresh scan. This collapses non-determinism by trusting the audit trail the worker is already keeping.

R-SLLJ-6 (P3, R-MAY): operator-facing diagnostic — `/pickle-status` should surface "score plateau but content drift detected" as a distinct status from "true stall." Today both look identical.

R-SLLJ-7 (P1, R-MUST): documentation — `prds/convergence-v8-topology.md` and `extension/src/services/microverse-state.ts` JSDoc on `compareMetric` MUST note that `metric.type === 'llm'` requires a content-stable judge prompt and that bare numerical comparison is unsafe for that metric class.

R-SLLJ-8 (P2, R-SHOULD): trap door — when the fix lands, add a trap-door entry under `extension/src/bin/CLAUDE.md` recording the invariant "LLM-judge metric stalls require content-aware comparison, not numerical equality" with a regression-test reference.

---

## Fix Options (for design discussion)

**Option A — Stable violation ledger (cleanest)**:
Add `violations: { id, file, line, principle, severity, confidence, first_seen_iteration }[]` to `microverse.json`. Judge prompt includes prior list with IDs; judge is instructed to (a) reuse IDs for surviving violations and (b) emit new IDs only for genuinely new findings. `classification = "improved"` if the new ID set is a strict subset of the old; `held` only if the ID set is identical; `regressed` if any new IDs appear without subset reduction.

**Option B — Trust gap_analysis.md (cheapest)**:
The worker already maintains `gap_analysis.md` with violations and removes resolved ones (Override 3 step 5 in `.claude/commands/szechuan-sauce.md`). Have the judge count violations in `gap_analysis.md` instead of fresh-scanning. Risks: trusts the worker not to lie about resolution. Mitigations: judge spot-checks 2 random "resolved" entries against current code.

**Option C — Diff-aware comparison (incremental)**:
Keep current judge but extend the prompt to receive `prior_violations: <full list>` and instruct the judge to output `{resolved: [...], new: [...], remaining: [...]}` JSON. Compute classification from set ops on those three lists. Numerical score becomes `len(remaining) + len(new)`.

**Recommendation**: Option C as a stop-gap (1–2 days), Option A as the durable fix (1 week). Option B is dangerous to ship alone — needs the spot-check guard.

---

## Verification

When R-SLLJ-1..3 land, replay the 2026-05-09-92dbdff2 transcript through `measureLlmMetricAttempt` and assert:
- iter 5: `classification: "improved"` (resolved one of iter-4's listed violations) — NOT `held`
- iter 6, 7, 8: `classification: "improved"` whenever a previously-listed violation is gone
- `stall_counter: 0` throughout the iter 5–8 plateau
- `failure_history: []` (no `no_progress` entries)

A regression-fixture session with the four iter 5–8 metric_value blocks pre-baked will be added under `tests/fixtures/false-stall-content-drift/`.

---

## Out of Scope

- The codex-judge-model-mismatch issue (`prds/szechuan-sauce-codex-judge-model-mismatch.md`) is a different code path. This PRD assumes the judge runs successfully; that PRD addresses the case where it cannot run at all on `--backend codex`. Both must be fixed.
- Anatomy-park's worker-managed convergence is unaffected and provides the structural template (per-subsystem `consecutive_clean`) that Option A would emulate.
- Compound-rule judging, multi-target szechuan-sauce sessions, or coverage-metric szechuan-sauce variants — out of scope; this PRD addresses the LLM-judge metric path only.

---

## Session Notes

Discovered while monitoring `2026-05-09-92dbdff2` after operator question "I do think the scoring might have a bug." Operator's instinct was correct: the loop showed 8 progress commits with score frozen at 5. Confirmed by reading raw `metric_value` strings in `convergence.history[]` and observing different violations listed each iteration despite identical scores. Loop is currently mid-iteration 9 — will likely hit `stall_counter == 5` and false-stall before iter 50 if not interrupted.

Recommended interim mitigation while this PRD is open: raise `stall_limit` from 5 → 15 for LLM-judge szechuan-sauce sessions to defer false-stall. This is not a fix, only a delay.
