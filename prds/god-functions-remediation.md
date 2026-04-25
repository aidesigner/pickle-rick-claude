# PRD: God Function Remediation

## Problem

A four-team audit of `extension/src/` identified **13 god functions** across 11 files —
functions exceeding 80 LOC, cyclomatic complexity > 10, or mixing 4+ unrelated
responsibilities. Four are severe (300+ LOC). They concentrate the riskiest control
flow in the system (orchestrators, hook handlers, subprocess spawners) and resist
unit testing because every responsibility must be set up before any single branch
can be exercised.

Concrete consequences observed in audit:

- `_emitDot` (dot-builder.ts:1237-2261) — 905 LOC, ~48 branches, emits 5 distinct
  pipeline topologies in one method.
- `main` in `mux-runner.ts:814-1382` — 460 LOC, ~66 branches, 411-line `while(true)`
  loop with 5+ nesting levels mixing rate-limit state machine, circuit breaker,
  ticket lifecycle, and signal handling.
- `main` in `microverse-runner.ts:452-1015` — 563 LOC interleaving rate-limit
  polling, metric measurement, regression rollback, stall detection in a single
  loop body.
- `main` in `stop-hook.ts:44-376` — 330 LOC classifying 8 different completion
  token types with state mutations scattered throughout.

These functions are the primary blockers cited in past debugging sessions for
why incidents took multiple iterations to root-cause.

## Goals

1. No function in `extension/src/` exceeds **120 LOC** (statements, excluding blanks/comments).
2. No function in `extension/src/` exceeds **cyclomatic complexity 15**.
3. Each extracted helper is independently testable — `node --test` covers the
   helper directly, not only via its parent.
4. Behavior is preserved: full lint + test gate (`npx tsc --noEmit && npx eslint
   src/ --max-warnings=-1 && npx tsc && npm test`) passes after each ticket.
5. Refactor commits do not change the deployed `~/.claude/pickle-rick/` runtime
   contract: hook decisions remain `"approve"`/`"block"`, state.json schema
   unchanged, CLI args unchanged.

## Non-Goals

- No new features. No new commands. No prompt-template changes.
- Not refactoring files under the threshold (e.g., state-manager.ts, metrics-utils.ts).
- Not touching deployed `.js` files directly — source-only changes per
  `pickle-rick-claude/CLAUDE.md`.
- Not introducing dependency injection frameworks, class hierarchies, or
  plugin architectures. Extracted helpers are plain functions.

## Tickets

Each ticket is atomic: one god function → one PR. Ordered by severity / blast radius.

---

### T1 — Split `_emitDot` in dot-builder.ts

**File**: `extension/src/services/dot-builder.ts:1237-2261`
**Current**: 905 LOC, ~48 branches, emits 5 pipeline topologies inline.

**Extract**:
- `_emitConvergenceTopology()` — lines 1576-1750 (v8 body + post-chain)
- `_emitSequentialPhases()` — lines 1752-2128 (phase loop, docOnly, convergence check)
- `_emitMicroverseLoop()` — lines 2136-2168
- `_emitReviewRatchet()` — lines 2170-2189
- `_emitFanOutTopology()` and `_emitCompetingTopology()` — corresponding inline blocks

**Acceptance criteria**:
- `_emitDot` body ≤ 120 LOC after split.
- Each extracted helper ≤ 200 LOC (some topology emitters are inherently large
  string templates; relax cap, but enforce single responsibility).
- Existing dot-builder tests pass unchanged.
- New tests: invoke each helper with a minimal builder and assert output contains
  the expected node IDs and edges.
- `grep -c '^  _emit' src/services/dot-builder.ts` ≥ 6.

---

### T2 — Split `main()` in mux-runner.ts

**File**: `extension/src/bin/mux-runner.ts:814-1382`
**Current**: 460 LOC, ~66 branches, 411-line monolithic loop.

**Extract**:
- `validateStartupState(state, statePath)` ← lines 877-906
- `setupSignalHandlers(statePath, log)` ← lines 847-861
- `processRateLimitCycle(...)` ← lines 1071-1150 (API limit detection, wait, sleep, wake cleanup)
- `processIterationOutcome(...)` ← lines 1188-1344 (CB recording + completion branching)
- `applyTimeoutCounter(...)` ← lines 1153-1186 (already exists as a pure function;
  inline logic must call it instead of duplicating)
- `shouldExitMainLoop(state, ctx)` ← lines 948-999 (exit gates)

**Acceptance criteria**:
- `main` body ≤ 120 LOC.
- Inner `while(true)` loop body ≤ 80 LOC after extractions.
- New tests: `processRateLimitCycle` and `processIterationOutcome` covered by
  unit tests with mocked state; assert state transitions for at least
  rate-limited / completed / timeout / circuit-open paths.
- Existing `extension/tests/mux-runner-pending-guard.test.js` still passes.

---

### T3 — Split `main()` in microverse-runner.ts

**File**: `extension/src/bin/microverse-runner.ts:452-1015`
**Current**: 563 LOC, ~25 branches, two phases interleaved.

**Extract**:
- `executeGapAnalysis()` — gap_analysis phase + baseline measurement + status transition
- `executeMainLoop()` — extract the 327-line `while` loop into its own async fn
- `handleRateLimit()` ← lines 715-774
- `measureAndClassifyIteration()` ← lines 856-970 (metric measurement, comparison,
  failure classification, recovery injection)

**Acceptance criteria**:
- `main` body ≤ 120 LOC.
- `executeMainLoop` body ≤ 200 LOC (still iterative but flat).
- New tests: `measureAndClassifyIteration` exercised with synthetic baselines
  for at least improved / regressed / unchanged cases.
- `microverse-state.ts` schema unchanged.

---

### T4 — Split `main()` in spawn-morty.ts

**File**: `extension/src/bin/spawn-morty.ts:31-408`
**Current**: 377 LOC, ~20 branches.

**Extract**:
- `parseAndValidateArgs()` ← lines 32-68
- `resolveEffectiveTimeout()` ← lines 96-139 (clamp from parent state + wall clock)
- `buildWorkerPrompt()` ← lines 164-222 (model selection + prompt assembly + GitNexus injection)
- `runWorkerProcess()` ← lines 224-407 (spawn, pipe, escalating timeouts, completion Promise)

**Acceptance criteria**:
- `main` body ≤ 80 LOC.
- `runWorkerProcess` body ≤ 150 LOC; nested `finalize` closure also extracted to
  module-private function.
- Behavior preserved: SIGTERM → SIGKILL escalation, hang guard, log-flush
  guardian all still fire under the same conditions.
- Existing `spawn-morty` tests pass; add unit test for `resolveEffectiveTimeout`
  covering wall-clock clamp.

---

### T5 — Split `main()` in stop-hook.ts

**File**: `extension/src/hooks/handlers/stop-hook.ts:44-376`
**Current**: 330 LOC, ~28 branches, classifies 8 token types inline.

**Extract**:
- `detectCompletionTokens(transcript)` — returns a discriminated-union result for
  the 8 token types
- `enforceRateLimitGate(state, transcript)` — rate-limit pattern detection
- `enforceLimits(state)` — iteration + time-budget checks
- `detectDegenerateResponse(state, transcript)` — degenerate counter logic
- `classifyDecision(...)` — single function that returns `"approve"` or `"block"`

**Acceptance criteria**:
- `main` body ≤ 80 LOC.
- Hook contract preserved: only `"approve"` or `"block"` returned (per
  `pickle-rick-claude/CLAUDE.md` Required Patterns).
- All `detectCompletionTokens` branches have direct unit tests.
- `extension/tests/activity-logger.test.js` and any stop-hook tests still pass.

---

### T6 — Split `main()` in spawn-refinement-team.ts

**File**: `extension/src/bin/spawn-refinement-team.ts:389-711`
**Current**: 322 LOC, ~15 branches.

**Extract**:
- `parseAndValidateArgs()` ← lines 390-406
- `loadRefinementSettings()` ← lines 414-432
- `orchestrateCycles()` ← lines 544-648 (multi-cycle loop, spinner, archive)
- `writeManifestAtomic()` ← lines 668-699

**Acceptance criteria**:
- `main` body ≤ 80 LOC.
- Manifest write atomicity preserved (temp file + rename).
- New unit test for `writeManifestAtomic` asserts no partial file on simulated
  write failure.

---

### T7 — Split `main()` in pipeline-runner.ts

**File**: `extension/src/bin/pipeline-runner.ts:644-956`
**Current**: 312 LOC, ~28 branches, three near-duplicate phase blocks.

**Extract**:
- `setupPhase(phase, config)` — factory returning phase-specific setup fn + command template
- `executePhaseRunner(phase, command, env)` ← lines 791-842 spawn pattern
- `postPhaseCleanup(phase, sessionDir)` — `cleanPhaseArtifacts` + archive + PRD write
- `updatePipelineStatus(...)` — already exists; ensure all inline call-sites use it

**Acceptance criteria**:
- `main` body ≤ 100 LOC.
- The three phase blocks (pickle / anatomy-park / szechuan-sauce) collapse to a
  single dispatch driven by `setupPhase`.
- Pipeline status JSON schema unchanged.
- E2E: dry-run pipeline (no actual spawn) executes all three phases without
  error.

---

### T8 — Split `main()` in setup.ts

**File**: `extension/src/bin/setup.ts:18-316`
**Current**: 298 LOC, ~22 branches.

**Extract**:
- `parseArguments(argv)` — 13-flag parsing loop
- `handleResumeSession(args)` — resume-specific state logic
- `initializeNewSession(args)` — new session creation + dir layout
- `displaySetupSummary(session)` — output panel rendering

**Acceptance criteria**:
- `main` body ≤ 80 LOC.
- state.json schema unchanged.
- Unit tests: `parseArguments` exercised for resume / reset / paused flag combinations.

---

### T9 — Split `main()` in jar-runner.ts

**File**: `extension/src/bin/jar-runner.ts:194-373`
**Current**: 146 LOC, ~21 branches; three near-duplicate guard-skip blocks.

**Extract**:
- `validateTaskIntegrity(taskDir, meta)` ← lines 285-316 (PRD hash, path traversal)
- `handleTaskEnoent(result, tasks, currentTaskId)` ← lines 335-355
- `skipTaskWithReason(meta, reason)` — collapse the three repeated guard-skip
  blocks (lines 268-274, 276-282, 292-296)

**Acceptance criteria**:
- `main` body ≤ 100 LOC.
- The three guard-skip patterns reduced to single-line calls.
- Unit test for `validateTaskIntegrity` covers happy path + hash mismatch + path traversal.

---

### T10 — Split `build()` in dot-builder.ts

**File**: `extension/src/services/dot-builder.ts:1102-1209`
**Current**: 109 LOC, ~17 branches, orchestrates 13 preflight + 16 structural validators.

**Extract**:
- `_validatePreflightSpecs()` ← lines 1110-1129
- `_validateConvergenceSpec()` ← lines 1132-1173 (predicate, model diversity, collisions)
- `_runStructuralRules()` ← lines 1182-1206

**Acceptance criteria**:
- `build` body ≤ 60 LOC.
- BuildResult shape unchanged; existing dot-builder tests pass.
- Each extracted validator independently invokable.

---

### T11 — Split `fromSpec()` in dot-builder.ts

**File**: `extension/src/services/dot-builder.ts:942-1010`
**Current**: 69 LOC, ~22 branches (high density).

**Extract**:
- `_parsePhases(raw)` ← lines 961-966
- `_parseConvergenceSpec(raw)` ← lines 985-1007 (15-field unmarshaling)

**Acceptance criteria**:
- `fromSpec` body ≤ 40 LOC.
- Parse helpers tolerate the same null/missing-field cases as before
  (assert via existing fixtures).

---

### T12 — Split `ensureMonitorWindow()` in pickle-utils.ts

**File**: `extension/src/services/pickle-utils.ts:749-848`
**Current**: 99 LOC, ~14 branches, 5 spawnSync paths.

**Extract**:
- `getSessionName()` — tmux session resolution
- `checkAndRecreateWindow()` — existing window validation + kill on mode mismatch
- `createMonitorWindow()` — script invocation + mode stamping
- `readWindowMode()` — already exists at lines 851-860; keep.

**Acceptance criteria**:
- `ensureMonitorWindow` body ≤ 50 LOC.
- All 5 spawnSync error paths still log with the same prefix.
- Manual smoke test: kill monitor window, re-run mux-runner, window comes back.

---

### T13 — Tighten `findImporters()` in scope-resolver.ts

**File**: `extension/src/services/scope-resolver.ts:630-662`
**Current**: 33 LOC; small but mixes rg + grep + parsing + dedup.

**Extract**:
- `_runRgImportWalk()` ← lines 638-647
- `_runGrepImportWalk()` ← lines 649-659

**Acceptance criteria**:
- `findImporters` body ≤ 20 LOC.
- Failure modes distinguishable in logs (rg fail / grep fail / both fail / timeout).
- Existing scope-resolver tests pass.

## Approach

1. One ticket = one PR. No batching.
2. Each PR runs the full gate: `npx tsc --noEmit && npx eslint src/
   --max-warnings=-1 && npx tsc && npm test`.
3. Extracted helpers stay in the same file unless reuse demands a new module.
   The audit is about cohesion, not file count.
4. Helpers are module-private (not exported) unless tested externally; in that
   case export and add to the file's public surface section.
5. Tests added for extracted helpers must be true unit tests — no subprocess
   spawning, no real fs writes outside `os.tmpdir()`.
6. After each PR: bump patch version per `pickle-rick-claude/CLAUDE.md`
   versioning rules (refactor = patch).

## Acceptance Criteria (epic-level, machine-checkable)

After all 13 tickets land:

- `find extension/src -name '*.ts' -exec awk '/^(async )?function|^  (private )?(async )?[a-zA-Z_]+\\(/{n=NR; name=$0} END{}' {} \\;`
  shows zero functions over 120 LOC.
- ESLint complexity rule (`complexity: ["error", 15]`) added to
  `extension/.eslintrc` and the codebase passes it clean.
- Test count (per `npm test`) is **strictly greater** than the pre-refactor
  baseline — every extraction must come with at least one new unit test.
- `git log --oneline | grep -c 'refactor(god-fn)'` ≥ 13.

## Risks

| Risk | Mitigation |
|---|---|
| Behavior drift in mux-runner's rate-limit loop | Snapshot test: feed recorded transcripts through `processRateLimitCycle` and assert state transitions match pre-refactor recording |
| stop-hook returns wrong decision after split | Cover all 8 token types with explicit unit tests; CI fails if any decision branch lacks a test |
| dot-builder topology emission produces different DOT output | Golden-file tests: capture current `_emitDot` output for representative specs, assert byte-equal after refactor |
| Iteration ordering changes in microverse main loop | Record state.json mutations across a full convergence cycle pre-refactor; assert identical sequence post-refactor |

## Out of Scope

- Refactoring `state-manager.ts`, `metrics-utils.ts`, or any file the audit cleared.
- Performance work (these refactors are cohesion-focused, not perf).
- Changes to `pickle_settings.json` defaults or hook contracts.
- Documentation updates beyond the `README.md` rule already in
  `pickle-rick-claude/CLAUDE.md` (no commands added/removed → no doc churn).
