---
title: P2 — B-PIPE-LAUNCH-FRICTION bundle — anatomy/szechuan silent-skip, scope-resolver grep-loop, pickle-pipeline doc drift
status: Queued (P2)
filed: 2026-05-18
priority: P2
type: bug-cluster
code: R-PLF
bundle: B-PIPE-LAUNCH-FRICTION
related:
  - prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md  # operator-authored bug report; this PRD is its decomposition
  - prds/p1-pipeline-fix-bundle-2026-05-18.md  # B-PIPE-FIX — sibling bundle. Bug #48 R-PCFG folds into R-PIPE-2 (phase_no_progress); NOT duplicated here.
  - extension/src/services/scope-resolver.ts
  - extension/src/bin/anatomy-park.ts
  - extension/src/bin/szechuan-sauce.ts
  - extension/src/bin/pipeline-runner.ts
  - extension/.claude/commands/pickle-pipeline.md
findings_closed:
  - "#49 R-PSSS — anatomy-park/szechuan-sauce silent phase-skip"
  - "#50 R-SRGT — scope-resolver grep timeout loop on empty diff"
  - "#51 R-PPSD — pickle-pipeline.md skill prompt docs deprecated skip flag names"
findings_folded_elsewhere:
  - "#48 R-PCFG — folds into B-PIPE-FIX R-PIPE-2 (phase_no_progress exit_reason). Do NOT add a separate ticket here."
ship_strategy: |
  Ship as v1.75.7 after B-PIPE-FIX (v1.75.6) lands, OR co-ship into v1.75.6
  if operator wants release-train economy. R-PPSD-1 (doc-only) can land at
  any time independently — does not need bundle gating.
---

# R-PLF — Pipeline launch friction bundle

**Author**: pickle-rick autonomous session 2026-05-18 PM, decomposing operator-authored bug report.
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`
**HEAD at filing**: `611b2625`

## Symptom cluster

Operator launched `/pickle-pipeline --refine --scope branch` on `loanlight-api` for LOA-701 (Reducto bounding boxes) on 2026-05-18. Session `2026-05-18-6108815e`. The launch surfaced **four distinct pipeline-launch friction bugs** (full operator report at `prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md`):

| # | Code | Symptom | Severity |
|---|---|---|---|
| 48 | R-PCFG | runner logs `Phase pickle completed successfully` immediately after `Phase pickle exited with code 1`; final pipeline can report `succeeded` with 0 workers spawned | S2 — observability false-green |
| 49 | R-PSSS | anatomy-park / szechuan-sauce silently skip when scope filter excludes all subsystems (doc-only diff); no operator-visible WARN | S2 — observability silent-skip |
| 50 | R-SRGT | scope-resolver import walk loops on `grep timeout / ETIMEDOUT` when branch diff is empty | S3 — UX + wall-clock waste |
| 51 | R-PPSD | `/pickle-pipeline` skill prompt documents deprecated `skip_readiness_reason` + `skip_ticket_audit_reason`; unified `skip_quality_gates_reason` (R-QGSK partial-ship `b2ddf584`) is undocumented | S3 — doc drift, 5-min fix |

**#48 R-PCFG folds into B-PIPE-FIX R-PIPE-2** — the `phase_no_progress` exit_reason gate at `extension/src/bin/pipeline-runner.ts` is structurally the same fix (count Done tickets + commits before claiming success). This PRD does NOT duplicate that ticket; it cross-references B-PIPE-FIX and tracks the remaining three findings.

## Cost

Concrete operator cost from session `2026-05-18-6108815e`:
- First launch died at 1m 8s (readiness halt + scope-resolver grep timeout spam).
- Second launch's pickle phase ran 1.5 seconds with 0 worker spawns (ticket-audit halt), then runner falsely logged `Phase pickle completed successfully`.
- anatomy-park silently skipped phase. szechuan-sauce ran no-op against doc-only diff.
- 13 tickets remained Todo. Operator had to read raw logs to discover the failure mode.

Structural cost: any operator launching with `--scope branch` and an empty or doc-only diff hits this cluster. Will recur on every doc-first PRD workflow until B-PLF ships.

## Atomic ticket scope

### R-PSSS-1 (small, ≤30m) — anatomy-park emit top-level WARN on empty-scope skip

**Files to modify**:
- `extension/src/bin/anatomy-park.ts` — locate the `setup returned false` path (the `scope filter excluded all subsystems` branch). Before returning false, emit a top-level WARN that surfaces in `${SESSION_ROOT}/anatomy-park-runner.log` AND `${SESSION_ROOT}/state.json.activity`:
  ```
  ⚠ anatomy-park did not run: scope=<mode> produced 0 in-scope subsystems.
    Branch diff contained: <comma-list of file paths>
    Hint: this phase inspects code subsystems; doc-only diffs do not qualify.
  ```
- Add `anatomy_park_empty_scope_skip` to `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts`) + `extension/src/types/activity-events.schema.json` (per R-PDD-oneOf 5-touchpoint).

**Acceptance**:
- Fixture: launch anatomy-park on a fixture session where branch diff is `docs/foo.md` only → log line + activity event present; phase still skipped (no false-positive run).
- Schema-conformance test passes.

### R-PSSS-2 (small, ≤30m) — szechuan-sauce emit top-level WARN on empty-scope skip

**Files to modify**:
- `extension/src/bin/szechuan-sauce.ts` — symmetric fix to R-PSSS-1. Same WARN template, same activity event family (`szechuan_sauce_empty_scope_skip`).
- Register the event in schema + types as in R-PSSS-1.

**Acceptance**:
- Same shape as R-PSSS-1 with szechuan-sauce-specific fixture.

### R-PSSS-3 (small, ≤30m) — pipeline-status.json distinguish skip dispositions

**Files to modify**:
- `extension/src/bin/pipeline-runner.ts` — extend `pipeline-status.json` per-phase record to include `skip_reason` (string enum: `"empty_scope"`, `"config_disabled"`, `"prerequisite_failed"`, `null`) alongside the existing `"skipped" / "succeeded" / "failed"` status. When anatomy-park / szechuan-sauce emit empty-scope WARN, runner sets `skip_reason: "empty_scope"`.
- Final pipeline report line (`Phases:` summary) renders e.g. `anatomy-park ⏭ (empty scope)` instead of generic `anatomy-park ⏭`.

**Acceptance**:
- Integration fixture: doc-only diff → `pipeline-status.json` records `phases.anatomy_park.skip_reason: "empty_scope"`.
- Final report distinguishes empty-scope skip from config-disabled skip.

### R-SRGT-1 (small, ≤30m) — scope-resolver short-circuit import walk on empty initial diff

**Files to modify**:
- `extension/src/services/scope-resolver.ts` — locate the 2-pass walk (build initial file set from `git diff` → "import walk" expand via grep). When initial file set is empty:
  ```typescript
  if (initialFileSet.size === 0) {
    log.info('scope-resolver: empty initial diff; skipping import walk');
    return { allowed: [], scope_resolved_at: new Date().toISOString() };
  }
  ```
  No grep, no subprocess, no retries.

**Acceptance**:
- Unit test: scope-resolver invoked with empty diff → returns `allowed=[]` in <100ms, no grep subprocess spawn observed via instrumented mock.

### R-SRGT-2 (small, ≤30m) — scope-resolver grep timeout caps

**Files to modify**:
- `extension/src/services/scope-resolver.ts` — even when initial diff is non-empty, add defensive caps on grep import-walk:
  - Per-grep timeout: 5s (currently unbounded / inherits default).
  - Total retry cap: 3 attempts per grep target; on exceed, log `scope-resolver: grep retry exhausted target=<path>; abandoning walk for this target` and continue (do NOT abort whole walk).
  - Total walk wall-clock cap: 60s. Exceed → log + return partial allowlist.

**Acceptance**:
- Unit test with a deliberately-slow grep mock asserts the 5s/3-retry/60s caps fire correctly.
- Integration regression: empty-diff case still completes in <100ms (R-SRGT-1 path); non-empty case completes <60s.

### R-PPSD-1 (small, ≤15m, DOC-ONLY) — pickle-pipeline.md unified skip flag docs

**Files to modify**:
- `extension/.claude/commands/pickle-pipeline.md` § "Skip-flag overrides" — replace the legacy-only doc block:

  **Before** (currently in skill prompt):
  > Set `state.flags.skip_readiness_reason` … or `state.flags.skip_ticket_audit_reason` …

  **After**:
  > If pipeline launch halts at a quality gate, edit `${SESSION_ROOT}/state.json` and add:
  > ```json
  > "flags": { "skip_quality_gates_reason": "<reason string>" }
  > ```
  > This unified flag (R-QGSK-2, `b2ddf584`) covers both readiness AND ticket-audit gates.
  >
  > **Legacy**: `skip_readiness_reason` and `skip_ticket_audit_reason` are still honored but emit a deprecation warning. Migrate to the unified flag.

- Also update `extension/.claude/commands/pickle-tmux.md` § "Skip-flag overrides" if it has the same drift.

**Acceptance**:
- `grep "skip_quality_gates_reason" extension/.claude/commands/pickle-pipeline.md` returns a hit.
- `grep "skip_readiness_reason" extension/.claude/commands/pickle-pipeline.md | grep -i "legacy"` returns a hit (showing it's documented as legacy).

**Note**: This ticket is DOC-ONLY and can ship independently of the rest of the bundle. R-PPSD-1 is safe to land at any time, including before B-PLF closes.

## Hardening (1)

### T-HARDEN-PLF-TESTS (small, ≤30m) — integration tests for empty-diff / doc-only-diff launch

**Files to modify**:
- `extension/tests/integration/pipeline-launch-friction.test.js` (new file).

**Coverage**:
1. Fixture: branch with 0 commits ahead → scope-resolver returns empty allowlist in <100ms; pipeline-status.json records `pickle.skip_reason: "empty_scope"` if applicable.
2. Fixture: branch with `docs/foo.md` only → anatomy-park emits `anatomy_park_empty_scope_skip` activity event; final report distinguishes skip type.
3. Fixture: branch with intentionally-slow grep target → scope-resolver R-SRGT-2 caps fire correctly.

**Acceptance**:
- All three test cases pass under `npm run test:integration`.

## Closer (1)

### C-PLF-CLOSER [manager] (small, ≤30m) — bundle ship

**Conditional on B-PIPE-FIX ship strategy**:
- **Option A** (release-train economy): co-ship as v1.75.6 alongside B-PIPE-FIX. Then C-PIPE-CLOSER does the version bump + release work for both bundles together.
- **Option B** (separate release): bump v1.75.6 → v1.75.7, rebuild, install.sh parity, release notes, MASTER_PLAN update.

Operator picks Option A or B at ship time. Default: B (lower coupling).

Common closer work either way:
- `cd extension && npx tsc` rebuild compiled mirrors.
- `bash install.sh` parity check (manager-only).
- Full release-gate audit (`npx tsc --noEmit && npx eslint && audit-* && test:fast && test:integration`).
- Commit + push.
- Update `prds/MASTER_PLAN.md`: mark findings #49 / #50 / #51 closed; B-PIPE-LAUNCH-FRICTION row → Shipped.

## Acceptance criteria (bundle-level)

| ID | Criterion | Evidence |
|---|---|---|
| AC-PLF-01 | anatomy-park emits top-level WARN + activity event on empty-scope skip | log line + jq on state.json.activity |
| AC-PLF-02 | szechuan-sauce emits top-level WARN + activity event on empty-scope skip | symmetric to AC-PLF-01 |
| AC-PLF-03 | pipeline-status.json records `skip_reason` per phase; final report renders disposition | jq + grep on report |
| AC-PLF-04 | scope-resolver short-circuits on empty diff (<100ms, no grep spawn) | unit test + instrumentation |
| AC-PLF-05 | scope-resolver grep cap (5s / 3 retries / 60s total) fires correctly | unit test |
| AC-PLF-06 | `/pickle-pipeline` skill prompt documents `skip_quality_gates_reason` as primary; legacy flags clearly labeled | grep + manual read |
| AC-PLF-07 | Integration test suite covers all three launch-friction fixtures | npm run test:integration |
| AC-PLF-CLOSER | Bundle shipped (v1.75.6 co-ship OR v1.75.7); MASTER_PLAN findings #49/#50/#51 closed | git log + gh release view + MASTER_PLAN diff |

## Out of scope

- **#48 R-PCFG** — folds into B-PIPE-FIX R-PIPE-2. Ships there.
- **Forward-create gate UX improvements** — separate problem (R-FRA / R-RTRC-7 → B-QSRC bundle).
- **Ticket-audit gate operator hints** — separate (`audit-ticket-bundle` belongs to a different gate family).
- **Subsystem registry expansion** (e.g., teach anatomy-park to inspect docs) — explicitly out; the WARN approach makes the silent-skip operator-visible without expanding subsystem coverage.

## Implementation strategy

**Pickle-friendly bundle** — unlike B-PIPE-FIX, this bundle does NOT modify the runner contract or worker prompts in ways that block pipeline self-hosting. Safe to ship via `/pickle-tmux` once B-PIPE-FIX R-PIPE-1 (max-turns 400) lands.

**Recommended order**:
1. B-PIPE-FIX completes (R-PIPE-1 verdict + R-PIPE-2/3/4 + closer).
2. B-PLF runs via `/pickle-tmux` on the same v1.75.6 base.
3. Operator picks co-ship (A) or separate release (B) at C-PLF-CLOSER time.

## Post-validation gaps

1. Watch one real operator launch with `--scope branch` against a doc-only branch — confirm anatomy/szechuan WARN surfaces visibly (not buried in DEBUG).
2. Confirm scope-resolver R-SRGT-1 short-circuit doesn't accidentally collapse legitimate "first commit gives 1 file but import walk finds 50" cases. The short-circuit is gated on EMPTY initial diff only.
3. Verify `skip_quality_gates_reason` documentation lands and a future operator session uses it without hitting the deprecation warning.

## Related findings / bundles

- **B-PIPE-FIX (R-PIPE-1..4 + hardening + closer)** — sibling bundle; R-PIPE-2 covers Bug #48 R-PCFG (the false `Phase pickle completed successfully` log). This bundle covers the other three friction bugs.
- **R-QGSK (B-QSRC residual)** — R-PPSD-1 documents the unified skip flag that R-QGSK-2 already shipped at `b2ddf584`. Doc-only catch-up; no runtime work.
- **R-FRA / R-RTRC-7** — operator-observed gate friction sits adjacent to this bundle (readiness gate exited 2 on legitimate forward-create symbols). Separate problem; tracked under B-QSRC.

## Bundle sizing

- 6 atomic + 1 hardening + 1 closer = 8 tickets.
- Tier mix: 6 small + 1 small + 1 small = all small-tier (≤30m each). Total worker effort ≤4h.
- R-PPSD-1 (15min doc-only) can land independently / first.
- No refinement required — bundle is small enough to ship from this PRD directly.
