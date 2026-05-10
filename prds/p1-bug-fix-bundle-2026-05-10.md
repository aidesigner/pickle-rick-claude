---
title: P1+P2+P3 — Bug-fix bundle 2026-05-10 (szechuan judge non-determinism + citadel conformance core wiring + monitor dashboard mode-swap)
status: Draft
filed: 2026-05-10
priority: P1 (mixed P1 + P2 + P3; closer ships v1.73.1)
type: bug-bundle
composes:
  - prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md   # Section B — Open Finding #17 (P1)
  - prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md            # Section C — Open Finding #14 (P2)
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md   # Section D — Open Finding #15 (P3)
related:
  - prds/p1-bug-fix-bundle-2026-05-08-mega.md   # predecessor — shipped 11/11 sections + closer (v1.73.0)
  - prds/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md  # R-PRJT — shipped post-mega via standalone pickle (commit 0fdf3ed4); deploy in HEAD as of 2026-05-10
  - prds/MASTER_PLAN.md   # post-bundle bookkeeping target
backend_constraint: claude
refine: true
unattended: true
---

# PRD — Bug-Fix Bundle 2026-05-10

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

The 2026-05-08-mega bundle session `2026-05-09-7ff82595` shipped 11/11 pickle-phase tickets (closer commit `fd6f8e18`, v1.73.0) and converged anatomy-park with 9 HIGH commits, but its szechuan-sauce phase aborted on `judge_timeout` after 1h30m — only one DRY commit (`e14ca028` extract `isRecord`) landed before the abort. That abort filed Open Finding #16 (`R-PRJT-1..7` — pipeline-runner aborts on `judge_timeout` despite R-MJCP-4 spec claim that finalize-gate should run), which shipped standalone post-mega via `0fdf3ed4` and is deployed at HEAD.

Three Open Findings remain after that work:

- **#17 (P1, NEW)** — `metric.type === 'llm'` szechuan-sauce sessions stall on the convergence floor even when commits are demonstrably removing real principle violations every iteration. Discovered in active session `2026-05-09-92dbdff2` against `loanlight-api` appraisal pipeline: score history iter 2→8 went `8→6→5→5→5→5→5` with classifications `improved → improved → improved → held → held → held → held`; `stall_counter: 4/5` despite 4 real Observability fixes landing in iters 5–8 (different violations, same numeric score). Root cause: `buildJudgePrompt` (`microverse-runner.ts:1145–1186`) gives the LLM judge no stable violation IDs and no diff-aware context — only one-line prior scores; the judge does a fresh code scan each iteration and outputs the count of ~5 most-prominent violations it sees. `compareMetric` (`microverse-state.ts:143–160`) is purely numeric. Sister to Finding #13 (R-MJCP) and Finding #16 (R-PRJT) — same `microverse-runner.ts` file, same metric-path family, three bugs in three sessions in three days. **PRD: `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md`** (R-SLLJ-1..8). Severity P1 — convergence-blocking, misleads operator, burns iteration budget over a 50-iteration ceiling. Recommended fix: Option C (incremental, ~1–2d) — extend judge prompt with prior_violations list + structured `{resolved, new, remaining}` output; Option A (durable, ~1wk) tracked as follow-up.

- **#14 (P2, NEW)** — Citadel PRD-conformance core (T3 AC scorecard, T4 dead-entry, T6 trap-door coverage, T8 state-machine) not surfacing in live `citadel_report.json`. The mega bundle's Phase 2/4 citadel ran in 1.3s and produced 1 LOW informational finding + ZERO conformance findings, despite the bundle declaring ~60 ACs and 4+ trap-door entries that should have been cross-referenced against the diff. Analyzer modules exist on disk (`ac-coverage-scorecard.ts` 10.9K, `allowlist-dead-entry-detector.ts` 11.2K, `state-transition-audit.ts` 5.8K) but are not invoked by `audit-runner.ts`; T6 trap-door analyzer module appears to be missing entirely. `prd-parser` does not walk `composes:` frontmatter chain — it sees only the bundle PRD's inline ACs, not the ~50 lifted-by-reference. Result: citadel signed off on Sections B (R-CCPL) and C (R-SCJM) of the mega bundle without machinery to notice that the closing commits did not reference R-CCPL/R-SCJM keystones; protection there was luck (Sections B/C work was already in HEAD from prior session), not citadel. **PRD: `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`** (R-CCNW-1..8). Severity P2 (not pipeline-killer; citadel still earns its diff-hygiene + divergence-reconciliation safety-net value); climbs to P1 if any future bundle ships an AC-violating change citadel was nominally responsible for catching.

- **#15 (P3, NEW)** — Monitor dashboard pane (1.0) frozen on pickle-phase template after pipeline transitions to anatomy-park or szechuan-sauce. Discovered in active session `2026-05-09-7ff82595` after pickle phase ended at 16:35 UTC. Monitor process is alive and polling, worker-output panes (1.1, 1.3) update live with anatomy-park's bash/edit calls — only the structured dashboard is stale (template bound at boot to `mode=pickle` and never re-binds). Operator-visible symptom: dashboard reads "11 tickets done / closer shipped" forever despite anatomy-park having shipped 8+ HIGH commits. Pane 1.2 ticket pointer also stuck on a pickle-phase ticket hash long after that ticket closed; pane 1.2 also emits indefinite `Warning: no stdin data received in 3s` because the pickle-phase manager exited and the producer is gone. **PRD: `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`** (R-MDS-1..8). Severity P3 (cosmetic dashboard staleness, structured state files are correct); climbs to P2 if any operator relies on the dashboard for cancel/continue decisions without spot-checking `state.json` / `pipeline-status.json` / `microverse-runner.log`.

This bundle composes 3 fix sections + bootstrap + closer into a single `/pickle-pipeline --backend claude` run with refinement enabled. Refinement is **on** because R-CCNW (Section C) is the largest scope (~250 LOC, 8 R-codes spanning audit-runner wiring, prd-parser composes:-walk, project-shape detection, trap-door analyzer build, and regression test) and benefits from atomic-ticket decomposition; the other two are crisp enough that quick-refine would suffice but the bundle picks one mode for predictability.

## Backend constraint

`backend_constraint: claude`. None of the three findings are backend-routing bugs. Codex-spark backend has unrelated open issues (codex classifier prompt leak shipped in mega Slot G; codex-manager empty queue spin still draft); claude is the proven path for v1.73.x bundle work.

## Refinement: ENABLED

`refine: true`. Refinement team produces atomic tickets per R-code from the three composed source PRDs (24 R-codes total: R-SLLJ-1..8 + R-CCNW-1..8 + R-MDS-1..8) plus bundle-level R-codes for bootstrap and closer. Expected output: ~26–30 atomic tickets after refinement. Skip risk if refinement is disabled: R-CCNW likely lands as 1 mega-ticket and risks scope-bleed into adjacent analyzer modules.

## Per-section disposition table — R-BUNDLE-DISPO-2026-05-10

| Section | Source | R-codes | Severity | Disposition | Notes |
|---|---|---|---|---|---|
| A | (bundle bootstrap) | R-A-01..03 | bookkeeping | IMPLEMENT | scope.json + bundle session marker + pre-flight assertions |
| B | `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md` | R-SLLJ-1..8 | **P1** | IMPLEMENT (Option C) | Extend `buildJudgePrompt` with prior_violations + `{resolved, new, remaining}` structured output; update `compareMetric` to use set-ops on violation IDs; raise `stall_limit` 5→15 for LLM-judge metric path until durable Option A lands |
| C | `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md` | R-CCNW-1..8 | **P2** | IMPLEMENT | Wire T3/T4/T8 in `audit-runner.ts`; build T6 trap-door coverage analyzer; teach `prd-parser` to walk `composes:`; project-shape detection for inert sections; regression test asserting all analyzers invoked |
| D | `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md` | R-MDS-1..8 | **P3** | IMPLEMENT | Phase-boundary `respawnMonitorWindowForMode` hook in `pipeline-runner.ts`; `monitor.js --mode <name>` per-mode template dispatch; defense-in-depth tick re-check; new `renderMicroverseDashboard` template; pane 1.2 ticket→subsystem swap |
| E | (bundle closer) | R-CLOSER-1..3 | bookkeeping | IMPLEMENT | Bump `extension/package.json` 1.73.0 → 1.73.1; full release gate; deploy via `bash install.sh`; update MASTER_PLAN to mark Findings #14/#15/#17 closed |

## Pre-flight — REQUIRED before launch

Pickle-pipeline launcher (Step 0 of `pickle-pipeline.md`) MUST verify:

1. **Working tree clean.** `git status` returns empty — uncommitted changes from a prior session would race with refinement and worker commits.
2. **No active sessions.** `jq -r '.active' ~/.local/share/pickle-rick/sessions/*/state.json | sort -u` returns only `false`. Active sessions block scope.json writes and stop-hook signaling.
3. **HEAD on `main`.** `git rev-parse --abbrev-ref HEAD` returns `main`. Bundle is local-only mode; branching is operator-deferred.
4. **v1.73.0 deployed.** `md5sum extension/services/state-manager.js ~/.claude/pickle-rick/extension/services/state-manager.js` matches; same for `bin/pipeline-runner.js`. R-PRJT runtime must be live so szechuan-sauce phase 4 in this same bundle's downstream pipeline doesn't hit the same abort that filed Finding #16.
5. **Source PRDs present.** All three `composes:` paths resolve to readable files. Bundle aborts before refinement if any is missing.
6. **No partial-state markers.** `~/.local/share/pickle-rick/sessions/2026-05-10-*/` does not exist (no prior failed run of this same bundle).

## Section A — Bundle bootstrap *(FIRST)*

| AC | Description |
|---|---|
| **R-A-01** | Bundle session writes `scope.json` to `<session>/scope.json` with `mode: branch`, `allowed_paths: ["extension/src/", "extension/tests/", "extension/CLAUDE.md", "prds/MASTER_PLAN.md", "prds/p1-bug-fix-bundle-2026-05-10.md"]`, `subsystems: ["bin", "lib", "services", "types"]`. Citadel and anatomy-park downstream phases consume this. |
| **R-A-02** | `pipeline.json` records `bundle_id: 2026-05-10`, `composes: [<3 paths>]`, `backend: claude`, `refine: true`, `unattended: true`, `expected_version_after: 1.73.1`. |
| **R-A-03** | Pre-flight assertion: bundle PRD's `composes:` frontmatter chain resolves; each composed PRD declares R-codes in the form `R-<KEY>-<N>`; refinement manifest later confirms 24+ R-codes covered (8 per source + bundle bootstrap + closer). |

## Section B — Open Finding #17 — Szechuan-sauce LLM judge non-determinism *(SECOND — P1, ship first)*

Lifted from `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md` Option C scope. R-SLLJ-1..8 keystones inherited verbatim. Key tickets after refinement:

| AC | Description |
|---|---|
| **R-SLLJ-1** | Extend `buildJudgePrompt` (`microverse-runner.ts:1145–1186`) to accept `priorViolations: ViolationLedger[]` and emit them in the prompt with stable IDs; new prompt section "Prior violations (DO NOT re-report unless still present)" lists each. |
| **R-SLLJ-2** | Judge structured-output schema upgraded: `{ score: number, violations: { id: string, severity: 'high'|'med'|'low', description: string }[], resolved: string[], new: string[], remaining: string[] }`. Backwards-compatible: when judge emits old shape, classifier infers `resolved=[]`, `new=current`, `remaining=[]` and logs `judge_legacy_shape_inferred`. |
| **R-SLLJ-3** | New `microverse.json.violation_ledger: { id, first_seen_iter, last_seen_iter, severity, description }[]` accumulates judge output across iterations; ID generation deterministic (slug from path:line:rule + hash suffix). |
| **R-SLLJ-4** | `compareMetric` (`microverse-state.ts:143–160`) gains a set-ops branch: when both `current` and `previous` carry `violation_ids` arrays, `improved` requires `|resolved| > 0` AND `|new ∩ remaining| === 0`; pure numeric comparison preserved as fallback when ledger absent. |
| **R-SLLJ-5** | `stall_limit` for LLM-judge szechuan-sauce sessions raised 5→15 in `microverse-runner.ts` (or pulled from settings); guarded by `metric.type === 'llm'` check; non-LLM paths unaffected. |
| **R-SLLJ-6** | New activity event quartet `judge_violation_ledger_advanced` with `{ resolved_count, new_count, remaining_count, ledger_size }`: types union + JSON Schema oneOf + payload fixture + count-assertion bumped (current 30 → 31). |
| **R-SLLJ-7** | Trap-door entry pinned in `extension/CLAUDE.md`: "INVARIANT: LLM-judge szechuan-sauce sessions MUST consume `microverse.json.violation_ledger` when present; falling back to pure-numeric `compareMetric` when ledger exists is a regression. ENFORCE: `microverse-state.test.js#compareMetric_set_ops_branch`. BREAKS: false-stall reproduction from session 2026-05-09-92dbdff2." |
| **R-SLLJ-8** | Regression test `microverse-llm-judge-non-determinism-recovery.test.js`: 4 cases — (a) numeric stall + ledger shows `resolved>0, new=0` → classified `improved`; (b) numeric improve + ledger shows `new>resolved` → classified `regressed`; (c) legacy judge shape → `judge_legacy_shape_inferred` event + numeric fallback; (d) `metric.type !== 'llm'` → pure numeric path unchanged. |

## Section C — Open Finding #14 — Citadel conformance core wiring *(THIRD — P2)*

Lifted from `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`. R-CCNW-1..8 keystones inherited verbatim. Key tickets after refinement:

| AC | Description |
|---|---|
| **R-CCNW-1** | Diagnostic script `extension/scripts/audit-citadel-wiring.js` that imports each analyzer module under `extension/src/audit/` and asserts each is referenced in `audit-runner.ts`. Used as pre-flight in bundle session and as standalone gate. Output JSON `{ analyzer: string, wired: boolean, file_size_bytes: number }[]`. |
| **R-CCNW-2** | Wire T3 (`ac-coverage-scorecard`), T4 (`allowlist-dead-entry-detector`), T8 (`state-transition-audit`) in `audit-runner.ts`. Each emits a section under `citadel_report.sections` with `{ findings: [], skipped: false }` on clean run; `skipped: 'project_shape_mismatch'` if applicable. |
| **R-CCNW-3** | Build T6 trap-door-coverage analyzer (`extension/src/audit/trap-door-coverage-audit.ts`): walks `extension/CLAUDE.md` ENFORCE refs, validates each ENFORCE points to an actual test file/case; emits findings for orphan ENFORCE refs (test missing) and orphan tests (ENFORCE missing). Wired in `audit-runner.ts`. |
| **R-CCNW-4** | `prd-parser` (`extension/src/audit/prd-parser.ts` or wherever the parser lives — discovery-time) walks `composes:` frontmatter chain when present: bundle PRD's `composes: [path1, path2, ...]` → recursively parse each composed PRD's R-codes/ACs and merge into the bundle's effective AC set. R-codes from composed PRDs visible to T3/T4 conformance checks. Cycle detection (a PRD that composes itself transitively → throw). |
| **R-CCNW-5** | Project-shape detection: `audit-runner.ts` detects project shape (Node CLI vs React frontend vs NestJS API vs Python) before invoking analyzers. Inert analyzers (e.g. `frontend_prop_drift` on a Node CLI) emit `{ skipped: 'project_shape_mismatch', reason: 'no React detected' }` rather than empty `findings: []`. Project-shape signal logged once per run. |
| **R-CCNW-6** | `rule-set-invariant-audit.ts` (T10.8) updated to recognize the project's INVARIANT/BREAKS/ENFORCE trap-door triple shape, not just generic invariant declarations. Counts ENFORCE refs as declarations; emits 0 findings on clean trap-door catalog instead of `0 declarations` warning. |
| **R-CCNW-7** | Regression test `citadel-analyzer-wiring.test.js`: asserts every `.ts` module under `extension/src/audit/` (excluding helpers/types) appears in `audit-runner.ts`'s import list AND is invoked at least once during a synthetic citadel run against a minimal fixture project. Trap-door-style — fails if a future analyzer is added but not wired. |
| **R-CCNW-8** | Trap-door entry pinned in `extension/CLAUDE.md`: "INVARIANT: Every analyzer module in `extension/src/audit/` MUST be imported and invoked by `audit-runner.ts`. ENFORCE: `audit/citadel-analyzer-wiring.test.js`. BREAKS: silent-skip class observed in mega bundle session 2026-05-09-7ff82595 where T3/T4/T6/T8 analyzers existed on disk but never ran." |

## Section D — Open Finding #15 — Monitor dashboard mode swap *(FOURTH — P3)*

Lifted from `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`. R-MDS-1..8 keystones inherited verbatim. Key tickets after refinement:

| AC | Description |
|---|---|
| **R-MDS-1** | `pipeline-runner.ts` invokes `respawnMonitorWindowForMode(sessionDir, phase)` at every non-citadel phase boundary (pickle→citadel skipped because citadel reuses pickle template; pickle→anatomy-park, anatomy-park→szechuan-sauce, szechuan-sauce→exit all trigger). New helper at `extension/src/lib/monitor-respawn.ts`. |
| **R-MDS-2** | `monitor.js --mode <pickle|microverse>` dispatches per-mode render template. CLI arg propagates to `renderDashboard` which switches on mode. Backwards-compatible: missing `--mode` defaults to `pickle`. |
| **R-MDS-3** | Defense-in-depth: monitor re-checks `state.step` every render tick (2s); when `state.step` changes from a pickle-class step to a microverse-class step (or vice versa) and current `mode` mismatches, monitor swaps template inline without process restart. Prevents stale-template race when phase-boundary respawn fires after a tick. |
| **R-MDS-4** | New `renderMicroverseDashboard` template displays: Subsystems (rotating list with `consecutive_clean` counter), Convergence (iter N/cap, last 5 metric values + classifications), Stall (`stall_counter/stall_limit`), Metric Trend (sparkline). Source: `microverse.json` + `convergence.history`. |
| **R-MDS-5** | Pane 1.2 ticket pointer swaps `▸ <ticket-hash>` (pickle phase) → `▸ <subsystem-name>` (microverse phase). Producer for pane 1.2 stdin: `morty-watcher.js` in pickle, new `subsystem-watcher.js` in microverse. |
| **R-MDS-6** | Pane 1.2 stale-stdin warning suppressed when producer exits cleanly (e.g. pickle-phase manager done). New state field `state.monitor_panes[2].producer_done: true` triggers "Producer complete" message instead of `Warning: no stdin data received in 3s`. |
| **R-MDS-7** | Trap-door entry pinned at `extension/src/bin/pipeline-runner.ts:phase-transition` invariant in `extension/CLAUDE.md`: "INVARIANT: Phase boundaries that change `state.step` from a pickle-class to microverse-class step (or vice versa) MUST trigger `respawnMonitorWindowForMode`. ENFORCE: `monitor-mode-swap.test.js`. BREAKS: dashboard freeze observed in mega bundle session 2026-05-09-7ff82595." |
| **R-MDS-8** | Regression test `monitor-mode-swap.test.js`: simulates phase transition by writing `state.step: 'anatomy-park'` to a fixture session and asserts (a) `respawnMonitorWindowForMode` is invoked with `mode='microverse'`; (b) defense-in-depth tick re-check independently swaps mode within 2s; (c) `renderMicroverseDashboard` template renders Subsystems/Convergence/Stall/Metric Trend sections; (d) pane 1.2 stale-stdin warning is suppressed when producer exits. |

## Section E — Closer *(FIFTH — version bump + deploy parity)*

| AC | Description |
|---|---|
| **R-CLOSER-1** | Bump `extension/package.json` version `1.73.0` → `1.73.1` (patch — three fixes, no breaking changes; mixed P1/P2/P3). Commit `chore: bump version to 1.73.1`. |
| **R-CLOSER-2** | Run full release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Failure blocks closer; closer commit must occur on green gate. |
| **R-CLOSER-3** | Deploy via `bash install.sh`; verify md5 parity for `state-manager.js`, `pipeline-runner.js`, `microverse-runner.js`, `microverse-state.js`, `audit-runner.js` (5 most-trafficked). Update `prds/MASTER_PLAN.md` to mark Findings #14, #15, #17 closed; record bundle commit range; bump trap-door audit count. |

## Risk Register

| ID | Risk | Likelihood | Mitigation |
|---|---|---|---|
| **R1** | Section B (R-SLLJ) Option C only — durable Option A (full violation ledger) deferred; future P1 may surface if Option C's prior_violations prompt context still permits judge drift | Medium | Closer mentions Option A as queued follow-up; new R-SLLJ-3 ledger in `microverse.json` is the substrate Option A would build on |
| **R2** | R-CCNW-3 builds new T6 analyzer module from scratch — risk of incomplete coverage of trap-door triple shape variants | Medium | Refinement directive: T6 must scan all current ENFORCE refs in `extension/CLAUDE.md` (130+ as of HEAD) and validate each; miss-rate must be 0 on clean run |
| **R3** | R-CCNW-4 (composes:-walk) cycle-detection edge cases (PRD A composes B composes A) | Low | Cycle detection mandatory in spec; regression fixture includes a synthetic A→B→A loop |
| **R4** | R-MDS-1 phase-boundary respawn timing race with monitor's existing 2s tick | Low | R-MDS-3 defense-in-depth tick re-check covers the race; both layers shipped |
| **R5** | Refinement enabled (`refine: true`) — risk of over-refinement spawning >40 tickets and burning iteration budget | Low | Refinement directive caps tickets at ~30; bundle's R-codes are 24 + bootstrap + closer; manifest review at refinement-end gate |
| **R6** | Anatomy-park or szechuan-sauce phase aborts mid-bundle (judge_unreachable, baseline_unmeasurable) | Low | R-PRJT (deployed) handles `judge_timeout`; remaining unrecoverable classes correctly route to no-finalize-gate; bundle pickle phase must complete before downstream phases run |

## Pre-flight checklist (operator runs before launch)

1. `git status` clean (no uncommitted changes — including this bundle PRD must be committed before launch)
2. `jq -r '.active' ~/.local/share/pickle-rick/sessions/*/state.json | sort -u` returns only `false`
3. `git rev-parse --abbrev-ref HEAD` returns `main`
4. `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` returns clean
5. v1.73.0 md5 parity confirmed — `md5sum extension/services/state-manager.js ~/.claude/pickle-rick/extension/services/state-manager.js extension/bin/pipeline-runner.js ~/.claude/pickle-rick/extension/bin/pipeline-runner.js` shows matching pairs
6. `prds/p1-bug-fix-bundle-2026-05-10.md` (this PRD) is committed
7. All three composed PRDs are committed and resolve from `composes:` paths

## Launch command

```bash
/pickle-pipeline prds/p1-bug-fix-bundle-2026-05-10.md --backend claude
```

(`--backend claude` is redundant with `backend_constraint: claude` in frontmatter but explicit at the launch line is preferred. Refinement runs in Step 0 of the skill before tmux launches; no separate `/pickle-refine-prd` invocation.)

## Refinement directives (for the refinement team in Step 0)

1. **Atomic tickets per R-code.** Each R-SLLJ-N / R-CCNW-N / R-MDS-N maps to exactly one ticket. Bundle bootstrap (R-A-01..03) and closer (R-CLOSER-1..3) collapse to single tickets each. Expected output: ~26–28 tickets.
2. **Section ordering preserved.** Pickle phase ships Section A → Section B → Section C → Section D → Section E in order. R-SLLJ ships before R-CCNW because it's the only P1; closer waits for all sections green.
3. **No cross-section ticket mergers.** A ticket that touches both `audit-runner.ts` (R-CCNW) and `monitor.js` (R-MDS) is split — these are distinct subsystems and separate tickets.
4. **Test-first per ticket.** Each implementation ticket pairs with a regression test ticket where the source PRD specifies one (R-SLLJ-8, R-CCNW-7, R-MDS-8). Test ticket may ship in same commit as the implementation ticket if completion-commit contract supports it.
5. **Trap-door tickets ship with implementation.** R-SLLJ-7, R-CCNW-8, R-MDS-7 each pin a trap-door entry in `extension/CLAUDE.md`; the ENFORCE ref in each entry must point to an actual test file/case the implementation ticket creates. Commit-order: test → trap-door → implementation, or all in one atomic commit.

## Post-bundle bookkeeping (closer's R-CLOSER-3)

- Update `prds/MASTER_PLAN.md`:
  - Mark Open Findings #14, #15, #17 **CLOSED**
  - Record bundle commit range (`<bootstrap-sha>..<closer-sha>`) and v1.73.1 deploy
  - Update trap-door audit count (current 130+ ENFORCE refs at HEAD; bump for the 3 new entries from R-SLLJ-7, R-CCNW-8, R-MDS-7)
- Note in MASTER_PLAN active queue: R-SLLJ Option A (durable violation ledger) queued as future P2 follow-up
- Activity event count assertion bumped 30 → 31 (one new event from R-SLLJ-6 `judge_violation_ledger_advanced`); fixtures present
- v1.73.1 tag deferred per local-only mode policy; v1.71.0 tag still latest pushed

## Cross-references

- **Predecessor**: `prds/p1-bug-fix-bundle-2026-05-08-mega.md` — shipped 11/11 sections + closer at `fd6f8e18` (v1.73.0); closed Findings #11, #12, #13, #16
- **Sibling family** (3 bugs in same `microverse-runner.ts` metric-path family across 3 sessions in 3 days):
  - Finding #13 R-MJCP — closed mega Section J (`6851f41f`)
  - Finding #16 R-PRJT — closed standalone (`0fdf3ed4`) post-mega
  - Finding #17 R-SLLJ — **THIS bundle Section B**
- **Future follow-up**: R-SLLJ Option A (durable violation ledger w/ stable IDs persisted to `microverse.json`) — file standalone PRD when Option C ships, queue as future P2

## Session Notes (post-run; appended by closer)

(empty — closer fills in)
