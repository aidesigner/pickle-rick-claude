# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Last updated**: 2026-05-09 PM — Open Finding #15 added (monitor pane 1.0 dashboard freezes on pickle-phase Tickets/Active/Circuit template after pipeline transitions to anatomy-park; PID still alive, panes 1.1/1.3 worker-output streams update live, but structured dashboard is stale; pane 1.2 ticket pointer also stuck on a pickle-phase ticket hash, P3). PRD: `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md` (R-MDS-1..8). **Queued in next bundle as slot #8**. 2026-05-09 PM — Open Finding #14 added (citadel PRD-conformance core T3/T4/T6/T8 not surfacing in live `citadel_report.json` — analyzer modules ship but report shows only 7 sections; for our bundle's ~60 ACs and 4+ trap-door entries, citadel returned 0 conformance findings without checking, P2). PRD: `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md` (R-CCNW-1..8). **Queued in next bundle as slot #7**. Pipeline `2026-05-09-7ff82595` STILL ACTIVE — Phase 3/4 (anatomy-park) iteration 11+/100; 7 anatomy-park HIGH commits shipped beyond pickle phase (`51968214` log-activity gate_payload, `98f41b14` check-scope-diff worker_edit_outside_scope emission, `1aa2dd42` install.sh install_sh_parity_check, `e10c1695` ticket_audit_failed schema-conformance, `a5672fa3` time_cap_disabled_default schema-conformance, `9cde5ffb` worker_partial_lifecycle_exit schema-conformance, `7c497b88` subtool_backend_override CLI parity); szechuan-sauce phase 4/4 queued. Bundle pickle phase: **2026-05-08-mega bundle session `2026-05-09-7ff82595` SHIPPED 11/11 tickets** (Sections A–K + closer). Bundle commit range `ef3b2855..6851f41f` (10 commits). v1.73.0 deployed via `bash install.sh --closer-context`; md5-parity 5/5 OK. **→ closes Open Findings #11, #12, #13, #16**; Open Finding #5 ⚠️ DEFERRED (audit script + JSON report + 5 follow-up DRAFT PRDs landed by Section G; CLAUDE.md content authoring deferred to P3 follow-ups). Slot G (R-CCPL) and Slot H (R-SCJM) shipped. Slot K (R-PJV) DIAGNOSE-only (artifacts + activity event + trap-door; fix follow-up `prds/p1-pkgjson-revert-auto-update.md` filed). Slot L (R-SED) DROP — components named in PRD never existed at HEAD (cron sampler stripped at `c2ec3cf1`); disposition flipped IMPLEMENT → DROP, audit-ticket-bundle exemption verified. Trap-door audit count grew by ENFORCE refs across Sections D/E/F/G/H/J. **2026-05-08 PM** — Open Finding #13 added (microverse judge-CLI probe misclassifies `ETIMEDOUT` as `judge_cli_missing`; 50ms probe timeout + boolean error path drops 30+ min of converged work via no-finalize-gate hard exit, P1). PRD: `prds/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` (R-MJCP-1..8). **Queued in next bundle as slot #6**. Triggering session: `2026-05-08-33d10614` (LOA-763 shadow-audit-diff pipeline) — anatomy-park converged green at 33m03s with 7 CRITICAL fixes shipped, then szechuan-sauce died at attempts:0 inside its baseline probe; `spawnSync claude ETIMEDOUT` was the underlying error, classifier collapsed it to `judge_cli_missing`, pipeline-runner.ts:1670 honored that as no-finalize-gate. 2026-05-08 PM — Open Finding #12 added (`/pickle-pipeline` skill has no scope auto-inference; safety-prompt + mid-flight `lock-scope.js` recovery action proposed, P2). **Queued in next bundle as slot #5** (P1/P2 — deferred slots G/H/I/J + Finding #12) per "bugs first, scope second" working rule. 2026-05-08 PM — Open Finding #11 added (anatomy-park worker edits bypass `scope.json` at fix time, P2). 2026-05-08 AM (~125 commits ahead of origin/main, **v1.72.2 installed locally**; v1.71.0 tag still on `8d09c503`. NOT pushed, NOT released to GitHub — local-only mode. **2026-05-07-deferred-slots bundle session `2026-05-08-d6f98b66` SHIPPED Phase 1 (pickle): 5/5 tickets** (Slots D/E/K/L + Closer); Phase 2 (citadel) wrote 1 informational finding; **Phase 3 (anatomy-park) FAILED** at iteration 1, 4m25s in, on a NEW pipeline-killer class — `convergence-gate.runGate({mode:'baseline'})` silently skips the baseline write when `detectProjectType(workingDir) === null`. Repo root has no `package.json` (only `extension/package.json`), so the gate emits `gate_skipped {reason:'no_project_type_detected'}` and returns success without writing `gate/baseline.json` — the trap-door at `microverse-runner.ts:capturePerIterationGateBaseline` correctly catches the missing file and throws. Phase 4 (szechuan-sauce) never ran. PRD filed: `prds/p1-anatomy-park-detectproject-null-skips-baseline.md`. Open Finding #7 re-opens — `b0f5ceca`'s stale-baseline deferral does NOT cover the fresh-init silent-skip class. Trap-door audit count 113 → 121 (+8 ENFORCE refs from Slots D/E/K/L). Open Findings #1, #3, #4 Closed by the bundle; #5 still PARTIAL; #7 RE-OPEN; #10 NEW.

**Bootstrap for new sessions**: read `CONTEXT_2026-05-07.md` first (supersedes `CONTEXT_2026-05-06.md`).

This file is **operational** — it tells the next coding agent what to work on. Historical narrative lives in:
- `docs/codex-prompt-design-notes.md` — codex-backend prompt-design lessons (FM-1..FM-4, literalism, scope confusion)
- Per-PRD `## Post-Validation Gaps` and `## Session Notes` sections — incident detail and validation results
- `git log` + release notes — release-by-release shipped detail

---

## 🛑 Working Rules (read before queueing work)

1. **Bugs first, scope second.** Open bugs in PRDs and master-plan queue slots must be drained before any feature/expansion work is queued. Bundle assembly **must** pull from open-bug lists first; new feature PRDs are deferred until the open-bug count is below an explicit threshold (current ceiling: **≤ 3 P1/P2 bugs open**, counted against the Active Queue + Active PRD Index). Override requires an operator-stated reason recorded in the queue row (e.g., "feature unblocks customer X" or "bug class needs the new infrastructure to land first") — silent prioritization of features over open bugs is not allowed.
2. **Worker tickets must run the lint + typecheck gate before completion-commit.** Workers commit code with the `completion_commit:` contract, but multiple sessions (incl. `pipeline-e0834dcd` 2026-05-06) have shipped tickets that left ESLint and/or `tsc --noEmit` red — caught only when the operator ran the release gate later. Worker prompts must include `npx eslint src/ --max-warnings=-1 && npx tsc --noEmit` ahead of the completion commit; failure blocks the commit. Until that lands, treat post-pipeline lint sweeps as **expected debt**, not optional polish.

---

## 📅 2026-05-07 PM status (post-Theme-A + post-hardening)

- **v1.72.2 installed locally** (`da43416f` 2026-05-07 PM). v1.71.0 tag on `8d09c503` still latest tag; v1.72.x not tagged because we skipped past a stale deployed v1.72.0 left by an earlier session. NOT pushed; ~100 commits ahead of `origin/main`.
- **2026-05-07-deferred-slots bundle session `2026-05-08-d6f98b66` SHIPPED** the 4 remaining slots + closer (Slots A/G/H were already shipped on `main` from a prior session). Slot D (`187aa589` R-ICP-3+4 setup.js cap persistence), Slot E (`2f4369c4` R-ICP-1+2 mux-runner cap-exit code 3 + pipeline halt), Slot K (`ce578369` R-ICM-1..3 install.sh chmod glob + post-install verify), Slot L (`1c3e4c27` R-APBS-1..3 anatomy-park /bin/ regression). Trap-door audit count 113 → 121 (+8 ENFORCE refs across the 4 slots). Bundle-level closer ran `bash install.sh` parity check (5/5 md5 match between source and deployed; deployed sync deferred because another active session was holding `~/.claude/pickle-rick/`). **→ closes Open Findings #1, #3, #4** (see updated table below).
- **Theme A pipeline `pipeline-be6e9179` SHIPPED 9/9 sections** in 3h 02m on `--backend claude` (PRD `prds/p1-bug-fix-bundle-theme-a-refinement-quality.md`). Zero `MANAGER_PERSISTENT_HALLUCINATION` — the backend swap from the planned `codex` paid off. Section commits:
  - `910846c6` §A — refinement analyst path verification (R-TAQ-1)
  - `7215c29b` + `bf045c61` §B — 7-class defect-audit scanner (R-TAQ-2/3/6)
  - `8ad72a2f` §C — cross-doc naming drift detector (R-TAQ-5/7)
  - `138f90a1` §D — worker silent-exit log flush + partial-lifecycle (R-WSE-1..4 + RC-2 fold)
  - `27db9d25` §F — failure-mode checklist in pickle-refine-prd skill (R-TAQ-4)
  - `a70db8f0` §G — phantom-Done filesystem watcher + completion-commit-hash (R-ICP-5/6) **→ closes Open Finding #2**
  - `751f979c` §H — audit regression fixtures + backfill validation (AC-TAQ-02/05/06)
  - `691899f1` §I — refinement-manifest schema extension (`ticket_quality_warnings`, R-TAQ-7)
  - `3574159d` §L — `/pickle-standup` quality + accuracy (R-PSU-1..5) **→ closes Open Finding #6**
  - `15e51fb8` — bonus anatomy-park CRITICAL: bin purge cache wrong root (landed in pipeline's anatomy-park phase before it bailed)
  Pipeline's anatomy-park phase bailed at iter 1 on the same baseline-staleness class as the standalone anatomy-park earlier today; szechuan-sauce never ran.
- **Post-Theme-A hardening sweep** (operator-driven, 12 commits):
  - `1a5cce3d` refactor(spawn-morty): extract pickValidEffort (lint-debt, complexity 16→14)
  - `556a8ec0` docs(trap-door): split R-CNAR-1 (2031 chars → 3 entries) + retry-ticket multi-triple (1 entry → 2)
  - `de556802` test(activity-logger): VALID_ACTIVITY_EVENTS count 108→112
  - `f50da717` test(cancel): align fixtures with R-SHB-6 prune semantics
  - `e6edbf29` + `ad38e946` + `cce050c7` + `e55f094f` test: orphan-tmp full-state-snapshot fix across 14 test files (backend-spawn, finalize-gate, circuit-breaker, doc-cross-reference, iteration-outcome, jar-codex, microverse, monitor, pr-factory, refinement-watcher, standup, mux-runner, spawn-morty)
  - **`b0f5ceca` fix(microverse)**: defer stale-baseline refresh failures to post-commit recapture — addresses the recurring anatomy-park pipeline-killer ✅
  - **`cbce383a` fix(test:fast)**: cap concurrency at 8 to stop boundary-timeout fork-bomb (Node default = cores-1 = 23 on this box; tests with 5000ms/10000ms internal subprocess timeouts kept blowing them) ✅
  - **`67ae0348` fix(spawn-morty)**: reuse preloaded state to avoid redundant readdirSync hangs (~13s saved per worker spawn on macOS where `/var/folders/.../T` has 70k+ entries) ✅
  - **`246c81d4` + `da43416f`** chore: bump v1.72.1 → v1.72.2
  - test:fast result: **186 → ~10–15 expected** (Agent verified -22 boundary-class drop in their staged run)
- **Production gates: ALL GREEN** at `da43416f` — TypeScript clean, ESLint clean, trap-door audit clean (113 ENFORCE refs verified), phantom-Done audit clean, all targeted regression tests pass.
- **prior pipeline `pipeline-1d81a0bb`** still has 6 slots deferred from `prds/p1-bug-fix-bundle-2026-05-06.md` (G/H/I/J/K/L) — see "Active Queue" below.
- **Prior pipeline `pipeline-1d81a0bb`** (bundle `prds/p1-bug-fix-bundle-2026-05-06.md`): shipped 5/12 sections + slot E hidden, **6 deferred** (G/H/I/J/K/L). See "Active Queue" below — these remain the most-aged open bug class. Slot G is `MANAGER_PERSISTENT_HALLUCINATION` root cause; bailed twice this week. **Pivoting away from `--backend codex` for refinement-team-touching work** is the operational mitigation Theme A used successfully.
- **Standalone anatomy-park `2026-05-07-4ca7a746`** ended at iteration 21/50, did not converge. 21 fixes + 22 trap doors landed across `extension/src/{bin,hooks,lib,services,types}`. Three CRITICAL findings shipped on services (orphan-tmp recovery hardening). The pipeline-killer class that ended this run is now fixed via `b0f5ceca`.

## 🔥 Open findings (closed/open status — refreshed 2026-05-07 PM)

1. ~~**MANAGER_PERSISTENT_HALLUCINATION root cause unaddressed.**~~ ✅ **CLOSED** by 2026-05-07-deferred-slots bundle Slot G (R-CCPL-1..6 — see `prds/p1-bug-fix-bundle-2026-05-07-deferred-slots.md`). `extractAssistantContent` + `classifyCompletion` now distinguish prompt content from model response in codex plain-text logs (block-delimiter-driven detection); worker template substring-broken tokens prevent the prompt-leak class. Trap-door pinned in `extension/CLAUDE.md` (R-CCPL-4 / classifier).
2. ~~**Codex "Done by model" without commit.**~~ ✅ **CLOSED** by Theme A §G (`a70db8f0`) — phantom-Done filesystem watcher + completion-commit-hash requirement now enforced.
3. ~~**Anatomy-park scope gap on root `/bin/`.**~~ ✅ **CLOSED** by 2026-05-07-deferred-slots bundle Slot L (R-APBS-1..3, commit `1c3e4c27`). `discoverSubsystems` already enumerates repo-root `/bin/` when target=repoRoot and ≥3 source files are present (verified empirically: 4 .js files, fileCount=4). Regression locked in by `extension/tests/anatomy-park-resolveSubsystems-bin.test.js` (3 tests covering the source-extension threshold and the bin-discovery contract); trap-door pinned at `src/bin/pipeline-runner.ts` (R-APBS-1..3).
4. ~~**`install.sh` chmod block hand-maintained.**~~ ✅ **CLOSED** by 2026-05-07-deferred-slots bundle Slot K (R-ICM-1..3, commit `ce578369`). The hand-maintained chmod list (lines 401–437, 36 entries covering only ~26/49 `extension/bin/*.js`) is replaced with directory-glob `chmod +x "$EXTENSION_ROOT/extension/bin/"*.js`. Post-install verification loop (`R-ICM-2`) asserts every `extension/bin/*.js` + `dispatch.js` is executable; fail-loud on regression. The 4 chmod 600/700 entries (audit_file ×2, activity dir) preserved per `R-ICM-3` and verified post-install. Regression coverage: `extension/tests/integration/install-chmod-coverage.test.js`. Trap-door pinned at `install.sh (R-ICM-1 chmod glob)`.
5. **Subsystem CLAUDE.md drift.** *(PARTIAL)* anatomy-park created `extension/src/types/CLAUDE.md` from scratch; other subsystems may also be missing them. Audit the 5 subsystems under `extension/src/`.
6. ~~**`/pickle-standup` output quality + accuracy.**~~ ✅ **CLOSED** by Theme A §L (`3574159d`) — noise filter + commit-LOA scan + repo discovery.
7. **Recurring anatomy-park pipeline-killer (baseline staleness)** *(PARTIAL — stale-refresh class closed; fresh-init class re-opened)* — `b0f5ceca` defers stale-refresh failures to post-commit recapture, but explicitly leaves fresh-init failure as a hard throw (`microverse-runner.ts:683-684`). Open Finding #10 below is the newly-discovered fresh-init pipeline-killer.
8. **test:fast fork-bomb on multi-core boxes** *(NEWLY-CLOSED)* — `cbce383a` caps `--test-concurrency=8`. Subprocess-heavy tests no longer blow their internal 5000ms/10000ms timeouts under contention.
9. **spawn-morty redundant-readdir hang on macOS** *(NEWLY-CLOSED)* — `67ae0348` reuses preloaded state. Worker spawn now ~13s faster per invocation when temp dirs are large. Margin-watch follow-up: `assertBackendPreSpawn` still does one `_sm.read()`; cleanest cure is to bound `readRecoverableJsonObject`'s `readdirSync` cost in `recoverable-json.ts` (filter by literal tmp-prefix) — out of scope this session.
10. **anatomy-park gate baseline silently not written when workingDir lacks project-type marker** *(NEW — IN PROGRESS, FIX UNDERWAY)* — Discovered 2026-05-08 in session `2026-05-08-d6f98b66` Phase 3 failure. `convergence-gate.runGate({mode:'baseline', baselinePath, ...})` early-returns SUCCESS without writing `baselinePath` when `detectProjectType(workingDir) === null` (or when `cmdMap` is missing for the detected type). The trap-door at `microverse-runner.ts:capturePerIterationGateBaseline` correctly catches the missing file via `pathExists(baselinePath)` and throws. This bites repos where the project lives in a subdirectory (e.g. `extension/package.json`) and the operator targets the repo root. Class is **fresh-init failure**, NOT stale-refresh, so `b0f5ceca` does NOT mitigate. **PRD: `prds/p1-anatomy-park-detectproject-null-skips-baseline.md`** (R-APBN-1..5). Fix is underway via agent team — convergence-gate's `!projectType` and `!cmdMap` early-return paths must write an empty-but-valid baseline file (status=`green`, checks=`[]`, failures=`[]`, project_type=null) so the iteration loop proceeds; existing `gate_skipped` activity event preserved for observability.
11. **anatomy-park worker edits bypass `scope.json:allowed_paths` at fix time** *(NEW — OPEN)* — Discovered 2026-05-08 in session `2026-05-08-5d60b760` (operator: anatomy-park `--backend codex --scope branch --scope-base origin/main` against `loanlight-api/packages/api/src/lib/appraisal-pipeline/`). `scope.json` is consumed only at *discovery* time (`filterBySubsystem` reduces the subsystem rotation) and at *gate-baseline failure attribution* time (`check-gate.js --allowed-paths-file`). It is NOT consulted between worker-edit and `git commit`. Across 14 fix iterations the worker leaked 1/14 commits (`fe927181a`) past the allowlist — `comparison/compute-differences.ts` fix correctly required updating a downstream consumer test in `packages/api/src/modules/portal-appraisal/portal-appraisal.service.spec.ts`, but the worker silently committed it with no `worker_edit_outside_scope` activity event. Sister gap to RC-2 of `prds/anatomy-park-szechuan-monorepo-missed-detection-gap.md` (which addresses *discovery-time* scope flattening — same branch's prior 2026-04-28 anatomy-park run produced 30+ `anatomy-park: packages — …` commits because no `--scope` was set; this PRD addresses the symptom that persists even WITH `--scope`). **PRD: `prds/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`** (R-APWS-1..7). Fix: F1 ship `extension/bin/check-scope-diff.js` worker preflight, F2 add `worker_edit_outside_scope` activity event + `/pickle-status` surfacing, F3 anatomy-park.md Phase 2 step 4.5 — worker MUST run preflight before `git commit` when `scope.json` exists, MUST surface cross-scope coupling as a finding rather than committing it. Severity P2 (data-loss class is operator confusion, not pipeline-killer) — the leak in 5d60b760 was a correct downstream test update, not a wrong edit; the gap is **lack of paper trail**, not bad worker behavior.
12. **`/pickle-pipeline` skill has no scope auto-inference — strong branch/subset signals silently ignored** *(NEW — OPEN)* — Discovered 2026-05-08 in session `2026-05-08-33d10614` (operator: `/pickle-pipeline docs/prd-shadow-audit-equivalence-diff.md --skip-refine` for LOA-763). Operator kickoff message contained three explicit scope signals (named branch `gregory/loa-763-shadow-audit-diff-writer`, "Scope: API-only (no loanlight-integrations PR)", listed subset of deliverable surface) but the skill's Step 4 treats `scope`/`scope_base` as strictly literal-flag-only (no regex auto-inference clause analogous to the `--refine` clause in Step 0 rule 3). The skill therefore wrote a scopeless `pipeline.json` and `scope.json` was never created. Anatomy-park self-targeted to `shadow-audit-diff/` only because citadel's findings happened to all live there — pure luck. Szechuan-sauce, which does NOT consume citadel findings, was queued to run unscoped against the entire `packages/api/` tree. Operator caught the gap by asking "is it clearly scoped to this branch?". Recovery required SIGINT + manual patches across `pipeline.json`, `state.json` (`worker_timeout_seconds=0` validator-rejected, `step=completed` mis-set), `pipeline-status.json` (`status=failed, completed_phases=0` despite pickle + citadel having shipped), and a manual `monitor.js` respawn in tmux pane 0 (boundary watcher had already fired and would not re-fire until next phase transition). Six-step manual recovery — should be one command. **PRD: `prds/p2-pickle-pipeline-no-scope-auto-inference.md`** (R-PSAI-1..7). Severity P2 (UX/safety gap, not pipeline-killer); climbs to P1 if combined with an unscoped szechuan-sauce that ships out-of-scope commits, or any operator who launches and detaches without checking `scope.json`. Sister to Open Finding #11 (edit-time scope leak) and to `prds/anatomy-park-szechuan-monorepo-missed-detection-gap.md` RC-2 (discovery-time subsystem flattening) — same structural problem (scope under-applied) at three different lifecycle stages.
13. **Microverse judge-CLI availability probe misclassifies `ETIMEDOUT` as `judge_cli_missing` — pipeline-killer** *(NEW — OPEN, P1)* — Discovered 2026-05-08 in session `2026-05-08-33d10614` (LOA-763 shadow-audit-diff pipeline, same session as #12). Phase 2/2 (szechuan-sauce) baseline measurement died at iter 1 with `attempts: 0` — the 4-attempt backoff loop never ran because `probeJudgeCliAvailability` (`extension/src/bin/microverse-runner.ts:1354–1367`) short-circuited it. **Two compounding bugs:** (a) probe runs `claude --version` with `timeout: 50` *milliseconds* — below the macOS dyld+V8 cold-start floor (warm `claude --version` ≈ 120–250ms; cold under 33min-old pipeline contention can spike past 1s); (b) probe error path returns `{ ok: false }` for ANY error and the caller (`measureLlmMetricWithBackoff` lines 1378–1387) maps that uniformly to `exitReason: 'judge_cli_missing'`, even though `measureLlmMetricAttempt` (lines 1346–1349) already has a correct three-way classifier (`isMissingCliError(err) ? 'cli_missing' : /ETIMEDOUT/.test(msg) ? 'timeout' : 'failed'`) it does NOT consume. Smoking gun: `microverse-runner.log` literally records `ERROR: Could not measure LLM baseline (judge_cli_missing) after 0 attempt(s): spawnSync claude ETIMEDOUT` — the binary was present and started, just slow. `pipeline-runner.ts:1670` correctly treats `judge_cli_missing` as no-finalize-gate (no remediation cycles), but that contract is correct ONLY when the CLI is genuinely missing; here the misclassification is upstream and the runner faithfully amplifies it. **Blast radius:** 33m03s of anatomy-park convergence (7 CRITICAL fixes shipped: URLA / red-flags / doc-expiration heap-order leaks, naturalKey under-discrimination, watermark advance on shadow_only insert error, watermark advance past DISCOVERY_LIMIT tied boundary, watermark advance past unexpired-grace deferred row, orphan-detection LIMIT without SQL dedup) was on-disk but the pipeline ended `failed` and szechuan-sauce never measured baseline. Recurrence is timing-sensitive (cold-start under load) — **when, not if.** Sibling of slot 1r/1s `0d528507` (R-AJUR / R-MJU) which fixed the *measurement* path but not the *probe* path that runs ahead of it; same root-cause family as `67ae0348` (macOS slowness under load — `/var/folders/.../T` with 70k+ entries). **PRD: `prds/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md`** (R-MJCP-1..8). **Fix:** extract shared `classifyJudgeError` helper from line 1346–1349; refactor `probeJudgeCliAvailability` to return discriminated union (`'ok' | 'missing' | 'timeout' | 'failed'`); raise default probe timeout to 5000ms (configurable via `PICKLE_JUDGE_PROBE_TIMEOUT_MS`); only short-circuit `judge_cli_missing` for true ENOENT-class — let timeout-class fall through to the existing 4-attempt backoff loop which already returns `judge_timeout` correctly. No pipeline-runner changes (R-MJCP-4). Atomic single-file fix + regression test + trap-door, ~30–60 min worker time.

14. **Citadel PRD-conformance core (T3 AC scorecard, T4 dead-entry, T6 trap-door coverage, T8 state-machine) not surfacing in live report** *(NEW — OPEN, P2)* — Discovered 2026-05-09 in session `2026-05-09-7ff82595` (mega-bundle pipeline, citadel Phase 2/4). Citadel ran in 1.3s and produced 1 LOW informational finding (anatomy-park.json absent — sequencing artifact) and ZERO conformance findings, despite the bundle PRD declaring ~60 ACs (R-CCPL-1..6 + R-SCJM-1..6 + R-APWS-1..7 + R-PSAI-1..10 + R-RJR-1..3 + R-CMD-1..4 + R-PJV-1..6 + R-SED-1..7 + R-MJCP-1..8 + R-CLOSER-1..3 + R-A-01..03) and 4+ trap-door entries (R-CCPL-8, R-SCJM-5, R-APWS-6, R-MJCP-7) that should have been cross-referenced against the diff. Live `citadel_report.json` `sections` map: `sibling_auth_preconditions` (T9, inert — Node CLI), `frontend_prop_drift` (T10, inert — no React), `ac_shape` (T11.7 echo, 0 findings), `rule_set_invariants` (T10.8, 0 declarations — analyzer doesn't recognize the project's INVARIANT/BREAKS/ENFORCE trap-door triple shape), `diff_hygiene` (T10.9, 31 files scanned clean), `divergence_reconciliation` (T11, 16 tests scanned clean), `cross_phase` (T10.7, 1 LOW). **MISSING from report despite analyzer modules existing on disk:** `ac_coverage` (T3 — `ac-coverage-scorecard.ts` 10.9K), `allowlist_dead` (T4 — `allowlist-dead-entry-detector.ts` 11.2K), `endpoint_contract` (T5 — `endpoint-contract-conformance.ts` 10.3K, acceptable to skip but should emit `skipped: project_shape_mismatch`), `state_transitions` (T8 — `state-transition-audit.ts` 5.8K), and T6 trap-door coverage gate (no module file on disk; may not have shipped at all). Result: citadel signed off on Sections B (Slot G, ticket `f3bf3c86`) and C (Slot H, ticket `5f7192c4`) which closed with commits that don't reference R-CCPL or R-SCJM keystones — citadel had no machinery to notice. The bundle's protection here was luck (Sections B/C work was already in HEAD from prior session), not citadel. Severity P2 (not pipeline-killer; citadel still earns its diff-hygiene + divergence-reconciliation safety-net value); climbs to P1 if any future bundle ships an AC-violating change citadel was nominally responsible for catching. Sister to LOA-618 post-mortem origin (`prds/citadel.md:464` lists 8 issues citadel was built to catch; 6 of 8 map to T3/T4/T6 which don't fire today). **PRD: `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`** (R-CCNW-1..8). **Fix:** R-CCNW-1 diagnostic script confirms wiring delta; R-CCNW-2 imports + invokes T3/T4/T5/T8 in `audit-runner.ts`; R-CCNW-3 builds T6 trap-door-coverage analyzer if absent; R-CCNW-4 makes prd-parser walk `composes:` frontmatter chain (essential for bundle-PRD authoring shape — current parser sees only the bundle PRD's ~15 inline ACs, not the ~50 lifted-by-reference); R-CCNW-5 adds project-shape detection so inert sections emit `{ skipped: 'project_shape_mismatch', reason }` rather than empty arrays; R-CCNW-6 teaches `rule-set-invariant-audit.ts` the trap-door triple shape; R-CCNW-7 regression test asserts every analyzer module is invoked.

15. **Monitor dashboard pane frozen on pickle-phase template after pipeline transitions to anatomy-park / szechuan-sauce** *(NEW — OPEN, P3)* — Discovered 2026-05-09 PM in active session `2026-05-09-7ff82595` after pickle phase ended at 16:35 UTC. The 4-pane monitor that `pipeline-runner.ts` spawns at launch correctly renders pickle-phase state (Tickets / Active / Circuit / Metric Trend), but pane 1.0 freezes on that template after `state.step` transitions to `anatomy-park` (and presumably `szechuan-sauce`). Monitor process (PID 5837 in this session) is still alive and polling, but its render template was bound at boot to `mode=pickle` and never re-binds. Worker-output panes (1.1, 1.3) DO update live with anatomy-park's bash/edit calls — confirming the watcher infrastructure works; only the structured dashboard is stale. Pane 1.2 ticket pointer also stuck (`▸ 3941449a` — Section J's pickle ticket — long after that ticket closed). Pane 1.2 also emits `Warning: no stdin data received in 3s, …` indefinitely because the pickle-phase manager process exited and the pane's stdin producer is gone. Operator-visible symptom: dashboard reads "11 tickets done / closer shipped" forever despite anatomy-park having shipped 8+ HIGH commits beyond pickle phase. Climbs to P2 if any operator relies on the dashboard for cancel/continue decisions without spot-checking `state.json` / `pipeline-status.json` / `microverse-runner.log`. **PRD: `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`** (R-MDS-1..8). **Fix:** R-MDS-1 hook in `pipeline-runner.ts` invokes `respawnMonitorWindowForMode(sessionDir, phase)` at every non-citadel phase boundary; R-MDS-2 `monitor.js --mode <name>` dispatches per-mode render template; R-MDS-3 defense-in-depth: monitor re-checks `state.step` every render tick (2s) and swaps template when it changes; R-MDS-4 builds `renderMicroverseDashboard` (Subsystems / Convergence / Stall / Metric Trend from `microverse.json`); R-MDS-5 pane 1.2 swaps ticket pointer → subsystem pointer; R-MDS-6 drops the stale-stdin warning when producer is gone; R-MDS-7 trap-door pinned at `bin/pipeline-runner.ts:phase-transition`; R-MDS-8 regression test asserts mode swap. Sister to R-MWR (pane liveness, not content) and R-PSAI-5 (pane 0 watchdog). Atomic 2-file fix + 1 new render template + 1 regression test, ~2-3h worker time.

## ✅ Completed — quick-refine pipeline on bundle PRD (2026-05-06)

**Session `pipeline-e0834dcd`** (`/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-06-e0834dcd`) ran 9 atomic implementation tickets via `/pickle-pipeline --no-refine --backend codex`. Each ticket = 1 source PRD (slots 1o..1u + 1m + 1n + 1d + 1g residual), authored by 9 parallel `Agent` calls in ~2 min ("quick-refine" workflow validated this session — see `prds/p2-abbreviated-refine-command.md`). **All 9 pickle-phase tickets shipped 2026-05-06; the pipeline auto-cancelled before anatomy-park phase entered.** v1.71.0 tagged locally (44 commits ahead of `origin/main`), push deferred until further stability.

**Backend**: codex / `gpt-5.4` (switched from `gpt-5.3-codex-spark` after hitting usage limit; updated in `.codex/config.toml` + `pickle_settings.json` + `state.codex_model`).

**Bypass flags set** on this session for both readiness gate (R-RTRC-*) and ticket-audit gate (R-TAQ-3): forward-created references + agent-authored ticket lints are not blockers. All 9 tickets were post-reviewed by 9 parallel review agents that fixed path-drift, annotated `(created) by ticket <hash>` per R-RTRC-7, lifted ACs verbatim, and structurally cleaned.

| Order | ID | Slot | Status | Source PRD |
|------:|----|------|--------|-----------|
| 10 | `09969d52` | 1u | ✅ Done (`162c226f`, 2026-05-06) | `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` |
| 20 | `bb08867f` | 1t | ✅ Done (`723cb99c`, 2026-05-06) | `p2-remove-pipeline-wall-clock-time-cap.md` |
| 30 | `6e80b612` | 1r/1s | ✅ Done (`0d528507`, 2026-05-06) | `anatomy-park-judge-unreachable-on-worker-convergence.md` |
| 40 | `edae8fa8` | 1o | ✅ Done (`17a18a6c`, 2026-05-06) | `p1-worker-backend-split-from-manager.md` |
| 50 | `167fcaf9` | 1p | ✅ Done (`fef590ab`, 2026-05-06) | `p2-codex-spark-worker-completion-commit-contract-violation.md` |
| 60 | `6edd8868` | 1n | ✅ Done (`b917eac1`, 2026-05-06) | `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` |
| 70 | `1a11461c` | 1g | ✅ Done (`a8c4ecb5`, 2026-05-06) — **residual debt: trap-door doc still under-specified for R-CNAR-7** | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` (R-CNAR-7 residual) |
| 80 | `1e821336` | 1m | ✅ Done (`ea3cb135`, 2026-05-06) | `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` |
| 90 | `91601dd7` | 1d | ✅ Done (`9347af20`, 2026-05-06) — verified already green at HEAD, no code change needed | `p3-test-flakes-council-publish-and-scope-resolver.md` |

**Post-pipeline lint sweep**: the 9 tickets shipped 10 ESLint errors across 3 files (`microverse-runner.ts`, `spawn-morty.ts`, `backend-spawn.ts`). Cleaned up via helper extraction + dead-code removal before tagging v1.71.0. Workers do not run lint locally — captured as Working Rule #2 above.

**Quick-refine validated as fast-path**: the workflow spawned 9 parallel `Agent` calls, each authoring 1 ticket from 1 source PRD, in ~2 min wall-clock total. Recommended for batches of 5+ atomic tickets where each ticket = 1 source PRD. Spec at `prds/p2-abbreviated-refine-command.md`.

**Closer + release-gate explicitly DROPPED** — local-only scope; no `gh release create` push, no upstream tag publish. Carry-forwards from bundle 2026-05-04 (AC-TAQ-09, R-BUNDLE-1/2/DISPO-1, 5 Section H tickets) deferred to a later batch.

## ⏭️ Path A meta-bundle — partial, abandoned (2026-05-06 mid-day)

Briefly attempted: refinement of mega bundle PRD via `/pickle-refine-prd`. First pass produced 5 meta-tickets (PRD-shape fixes, not implementation). Path A ran 3 of 4 meta-tickets (`68d9c1bf`, `62b34588`, `0b16a707` + `48047f56`) before hitting fast-failure loops on the 4th (`e83118ff` skipped). Re-refinement after path A produced only 14 deduped tickets (~6 unique work areas), missing 5 of 9 source PRDs. Abandoned for the simpler quick-refine workflow above. Sessions `2026-05-05-b8465d85` and `2026-05-06-9dacd293` are deactivated; their refinement artifacts remain on disk for forensics.

## 🟢 Shipped post-v1.70.0 (2026-05-05 → 2026-05-06)

- **`244b4c51`** `chore: remove audit-canary-flip from gate sequence` — 2026-05-05. Stripped `bash scripts/audit-canary-flip.sh` from CLAUDE.md (×2), `extension/scripts/check-wired.sh`, `release-gate-parity.test.js`, `release-gate-wiring.test.js`, `.github/workflows/{ci,release}.yml`. Script + fixture test (`audit-canary-flip-fixture.test.js`) preserved for future re-wiring. Resolves the integration-tests commits' `Canary:` trailer policy issue per operator decision (no release intent in current scope).
- **`49e0ff84`** `fix(trap-door-conformance)` — 2026-05-05. Pre-existing fast-tier failure since `065acf77`. 5 trap-door entries (lines 7, 127, 140, 141, 145 in `extension/CLAUDE.md`) used grep-based ENFORCE clauses without naming a `.test.js` file. Appended explicit test refs (`audit-ticket-bundle-schema.test.js`, `activity-event-payload.test.js`, `auto-resume-stop-conditions.test.js`). `trap-door-conformance.test.js`: 62/62 pass.
- **`f6909d78` + `1949c6a4` + `efe0e961`** — Slot 1q (R-ITS-1..4) shipped via `/pickle-tmux` session `pickle-18960261`, 99 min, 1 iteration. Follow-ups: count assertion bumped 11→12 in `activity-event-payload.test.js`; install.sh `R-ITS-1` force-rebuild made TS-derived only (preserved JS-only utilities `parse-coverage-exception.js`, `replay-bundle-iter-stats.js` that earlier wipe deleted).
- **`80430696`** `docs(prd): mega bundle 2026-05-05 — Section CF carry-forwards + slot 1q ALREADY-SHIPPED` — 2026-05-05. Composed mega bundle PRD for path A → re-refine → mega-pipeline plan. Closer + R-CLOSER-1 explicitly DROPPED (local-only).
- **`68d9c1bf`** `docs(prd): lift section lead requirement ACs from peer PRDs (path A meta-ticket 1/4)` — 2026-05-06. Path A ticket 3097eec3 — bundle PRD now has Local AC subsections lifted from each peer PRD with verified file:line anchors. Unblocks re-refinement.
- **`62b34588`** `docs(prd): split AC-06 into 06a (dispositions) + 06b (path-decision)` — 2026-05-06. Path A meta-ticket 2/4.
- **`0b16a707`** + **`48047f56`** — Path A meta-ticket 3/4: register 6 new bundle activity events (worker_backend_resolved, completion_commit_auto_filled, completion_commit_inferred_from_git, time_cap_disabled_default, bundle_bootstrap_exemption_applied, manager_idle_backoff_engaged) through full registration quartet (VALID_ACTIVITY_EVENTS + schema + payload-test fixture + count-assertion + deployed mirror).
- **`34146d6e`** `docs(prd): file /pickle-quick-refine command — abbreviated PRD-to-tickets via parallel Agent fan-out` — 2026-05-06. Captures the validated workflow that replaced path A: 9 parallel Agent calls authoring 9 ticket files in ~2 min vs 30-90 min for the full refinement team. 7 ACs + trap-door for verbatim-AC-lift invariant.
- **`162c226f`** `feat(stop-hook): add idle backoff for 09969d52` — 2026-05-06. Slot 1u SHIPPED via the quick-refine pipeline. R-MSCN-1..6 (manager stop-hook nudge cadence — fixes the wait-pattern that bit slot 1q's worker).
- **`723cb99c`** `bb08867f default pipeline wall-clock caps to off` — 2026-05-06. Slot 1t SHIPPED. R-NTC-1..10 (wall-clock cap removal default). Also commits `.codex/config.toml` + `pickle_settings.json` model switch from `gpt-5.3-codex-spark` to `gpt-5.4` after hitting spark usage limit.
- **`0d528507`** — 2026-05-06. Slot 1r/1s SHIPPED via quick-refine pipeline (ticket `6e80b612`). R-AJUR (anatomy-park judge_unreachable skip when metric_type='none') + R-MJU (szechuan timeout-as-stall — distinguish `judge_timeout` from `stall`, baseline-fail exits with `baseline_unmeasurable`).
- **`17a18a6c`** `edae8fa8 add worker backend split state field` — 2026-05-06. Slot 1o SHIPPED via quick-refine pipeline. R-WBS-1..6 worker_backend split from manager.
- **`fef590ab`** `fix: complete completion-commit contract for 167fcaf9` — 2026-05-06. Slot 1p SHIPPED via quick-refine pipeline. R-CCC-* codex-spark completion-commit contract (built on slot 1o).
- **`b917eac1`** — 2026-05-06. Slot 1n SHIPPED via quick-refine pipeline (ticket `6edd8868`). R-SHB-1..6 stop-hook orphan-shadow.
- **`a8c4ecb5`** — 2026-05-06. Slot 1g SHIPPED via quick-refine pipeline (ticket `1a11461c`). R-CNAR-7 cap-check guard residual (covers 4 remaining gaps from `96ce65cf`). **Residual debt:** trap-door doc still under-specified for R-CNAR-7; flag for follow-up tightening.
- **`ea3cb135`** — 2026-05-06. Slot 1m SHIPPED via quick-refine pipeline (ticket `1e821336`). R-PDT-1..4 pipeline-runner dirty-tree guard.
- **`9347af20`** — 2026-05-06. Slot 1d closed via quick-refine pipeline (ticket `91601dd7`). Test flakes (council-publish + scope-resolver) — verified already green at HEAD; no code change needed.
- **Post-pipeline lint sweep** — 2026-05-06. The 9 quick-refine tickets shipped 10 ESLint errors across `microverse-runner.ts`, `spawn-morty.ts`, `backend-spawn.ts`. Cleaned up via helper extraction + dead-code removal before tagging v1.71.0. Workers do not run lint locally — captured as Working Rule #2 at the top of this file.
- **v1.71.0 tagged locally** — 2026-05-06. 44 commits ahead of `origin/main` at session end. Push deferred until further stability. Tag exists on local repo only.

### Pipeline `pipeline-1d81a0bb` (bundle 2026-05-06) — 5/12 + slot E hidden-shipped (2026-05-06 → 2026-05-07)

Pipeline bailed on `MANAGER_PERSISTENT_HALLUCINATION` at slot G; H/I/J/K/L never started.

- **`4e2e8bf8`** `feat(worker): lint + tsc gate at completion-commit (3646c20a)` — slot A. Worker prompts now run `npx eslint src/ --max-warnings=-1 && npx tsc --noEmit` before the completion commit. Closes Working Rule #2 at the source. Refs slot 1q's post-pipeline lint debt.
- **`eb796544`** `docs(trap-door): complete R-CNAR-7 trap-door audit` — slot B. Tightens the R-CNAR-7 trap-door doc residual flagged by slot 1g's quick-refine ship.
- **`0da2d099`** + **`532246ec`** + **`03145060`** — slot C. `test(integration): serial tier for subprocess-heavy flakes (3a4c5dc5)` plus deferred-validation-handoff bookkeeping. Splits the parallel-tier flake quarantine: subprocess-heavy tests run serial, the rest stay parallel.
- **`97653071`** `fix(microverse): guard worker-mode finalizer history 250d5001` — slot D. anatomy-park finalizer history-crash guard.
- **`c165fa9c`** `test(integration): repair worker fixture sentinels` — cross-cutting integration test fixture repair landed mid-pipeline.
- **`55ef850e`** `fix(szechuan-sauce): override 6 monorepo journal globbing (23ca1ac2)` — slot F. Override 6 now globs `packages/*/db/migrations/...`, `apps/*/...`, `services/*/...` instead of root-only.
- **`617a0db9`** `fix(microverse): guard key_metric description for anatomy-park mode` — **slot E hidden-shipped**. Resolves slot E's microverse `key_metric` description guard for anatomy-park mode, but commit message lacks the `76f99e4a` ticket hash, so the phantom-Done watcher keeps reverting `Status: Done` → `Todo`. Code is in HEAD; ticket file disagrees. Theme A Section G fixes the watcher.
- **Slot G bailed** (`50d51d7a` codex classifier prompt-leak): codex manager hallucinated `EPIC_COMPLETED` four times → pipeline aborted on `MANAGER_PERSISTENT_HALLUCINATION`. Underlying hallucination root cause unaddressed (Open Finding #1).
- **Slots H/I/J/K/L never started**: H `0642202a` (szechuan codex judge model mismatch), I `cbfdffdf` (iteration cap persistence vs display), J `d02a6128` (mux-runner exits 0 on cap-hit), K `db44f365` (deployed package.json version-only revert — research artifact at `prds/research-slot-K-pjv-writer-2026-05-07.md`), L `4dfd3243` (strip excessive defense from deploy-reversion).

### Maintenance commits 2026-05-06 (post-pipeline)

- **`310834a4`** `chore: sync lockfile version to 1.71.0` — npm-lockfile version field aligned with `extension/package.json`.
- **`4974b86d`** `refactor: lint cleanup post-pipeline` — fixes for the 10 ESLint errors slot A's gate would have caught.
- **`8d09c503`** `docs(MASTER_PLAN): record 2026-05-06 pipeline + add bugs-first policy` — v1.71.0 was tagged on this commit.
- **`e47ae8c3`** `fix(install-parity): track dot-builder.js as 100644` — `install.sh` chmod block missed `dot-builder.js`; resulted in a filemode regression that dirtied the tree on every build. See Open Finding #4.

### anatomy-park `2026-05-07-4ca7a746` (IN FLIGHT 2026-05-07)

5-subsystem rotation on `extension/src/` (bin, hooks, lib, services, types). 5 commits landed at the time of writing; expected to grow as iterations proceed. Convergence target: each of 5 subsystems clean for 2 consecutive iterations.

- **`017cbc2c`** `anatomy-park: bin — HIGH fix retry stale lifecycle artifact evidence, trap door`
- **`63eddf8b`** `anatomy-park: hooks — HIGH fix stop-hook update-check interval, trap door`
- **`87ca3e97`** `anatomy-park: lib — HIGH fix dotted RunContext analyzer parsing, trap door`
- **`d0d8cc79`** `anatomy-park: services — HIGH fix CLI backend override precedence, trap door` (residual on slot 1o `worker_backend` split)
- **`75ab7b4d`** `anatomy-park: types — HIGH fix activity-event catalog drift, trap door`

## 🟡 Just merged locally — NOT pushed, NOT released (2026-05-05 PM, retained for context)

Three subsystem branches merged into `main` for build-up; held local until next release decision.

- **RTRC subsystem** (`bab6c7e2` merge of `fix/r-rtrc-readiness-contract-resolver`) — R-RTRC-1..7 readiness contract resolver false-positive fixes. 6 underlying commits. Adds `extension/.readiness-allowlist.json`, `extension/scripts/audit-readiness-allowlist.sh`, forward-reference annotation schema in `check-readiness.ts`, and "Forward-reference hygiene" section in `spawn-refinement-team.ts` analyst prompt. 37 targeted tests pass. Tag `rtrc-final-checkpoint` at `5615cec0`.
- **MWR subsystem** (`ed6a58e3` merge of `fix/r-mwr-monitor-watchdog`) — R-MWR-rename + R-MWR-1..8 monitor watchdog + EOF resilience. 9 underlying commits. Continuous `startRespawnWatchdog`, `PICKLE_MONITOR_WATCHDOG=off` kill-switch, watchdog log tagging, EOF resilience for log/morty/raw watchers, refinement-watcher manifest-rewrite survival, banner reservation. New `monitor-watchdog.test.js` (R-MWR-7) + `refinement-watcher-manifest-rewrite.test.js` (R-MWR-5) + extended `log-watcher.test.js` (R-MWR-8). 163 watcher tests + 13 new + 27 extended pass. Tag `mwr-final-checkpoint-v3` at `9ae60002`.
- **integration-tests subsystem** (`4c97d3ad` merge of `fix/integration-tests-v1.70-followup`) — 6 fixes for pre-existing integration test failures (broken since R-CNAR-1 part 2 / `6be334b1`). 6 underlying commits: atomic node-based postinstall, HT-1 eslint-disable annotation, pipeline-state-coherence cap-split-exit-3 update, microverse-runner worker-mode scored-history guard skip + companion test fix. All 27 canary tests pass. **Audit-canary-flip blocks at release time** because the agent followed the `Canary:` trailer convention but didn't first commit xfail markers — release-time decision deferred. Tag `integration-tests-final-checkpoint` at `7f7912ec`.

**Carry-forward burn-down**: 27 → **13 Todo** from `prds/p1-bug-fix-bundle-2026-05-04.md`. Remaining: AC-TAQ-09, 5 Section H hardening, R-BUNDLE-1/2/DISPO-1, R-CLOSER-1 + Closer.

## 🟢 Just shipped (2026-05-04 → 2026-05-05)

- **v1.70.0 — direct-fix release for run-#6 forensics** (2026-05-05) — bypassed the bundle approach (which kept dying on its own audit-gate machinery) and direct-fixed the 5 highest-impact bugs found by the abandoned bundle's refinement analysis. ~150 LOC across 5 atomic fix commits. Tagged via `gh release create v1.70.0 --latest`.
  - **R-CCC-5** `49f9e12a` — Phantom-Done watcher honors `completion_commit:` frontmatter. New `hasCompletionCommit()` helper returns explicit/inferred/absent. `correctPhantomDoneTickets` calls helper as FIRST gate. Closes the run-#6 revert cascade where bundle commits using R-* codes (no ticket hash) caused the legacy git-log scan to miss everything.
  - **R-CNAR-7** `96ce65cf` — Cap-check at `mux-runner.ts:2888` guards on `state.current_ticket` truthy. New self-heal path emits `cap_check_skipped_stale_cache` event + atomic 5-field cache clear when stale cache is detected. Closes run-#6 attempt-1 cap-trip.
  - **R-CNAR-8** `94e68316` — Atomic 5-field cache clear at every `current_ticket` nullification site: finalizeTerminalState, clearExitReason(resetCurrentTicket), resetStateForPhase, reconcileTicketStateDesyncOnResume, transaction-ticket-ops branches a/c, updateStateField. New `clearTicketCacheFields()` helper.
  - **R-SHB-6** `ef8130f0` — `pruneOrphanedMapEntries(dataRoot)` helper removes phantom `current_sessions.json` entries whose session_dir is missing or state.json unreadable. Wired at `findSessionPathForCwd` + `resolveStateFile` so every cwd-resolve path self-cleans. Closes the manual operator workaround that pruned 13 phantom entries during run #6.
  - **R-ITS-5-MIN** `52e7674d` — install.sh refuses ALL invocations during active session (was: only refused on downgrades). Mid-bundle install.sh accidentally invoked during run #6 was the corruption pattern. `--override-active` and `--closer-context` bypass.
  - **Skipped intentionally** (still in `prds/p1-bug-fix-bundle-2026-05-04.md`'s 27 Todo carry-forwards): R-RTRC readiness resolver false positives, R-MWR monitor watchdog, R-BUNDLE-DISPO-3/4 audit-gate machinery, R-RTC-* test flakes. These are polish, not "very broken." Land in next bundle when ready.
  - **Pre-existing test-gate failures** (verified pre-date these fixes): 6 integration tests fail on parent commit + HEAD: `install-script-prefix.prefix-writes-files`, `install-script-real.e2e`, `gate-fixture-i: green gate`, `worker convergence dead-writer tmp`, `mega bundle A-F smoke`, `pipeline state coherence three-iteration`. These were broken by R-CNAR-1 part 2 (`6be334b1`) and earlier — release ships despite them per "fix bugs ASAP" mandate. Track in follow-up.
- **Slot 1l codex-spark wiring** (`59411f8`) — `gpt-5.3-codex-spark` is the default codex model; per-session override via `state.codex_model`. Tagged with v1.70.0.
- **P1 bug-fix bundle 2026-05-04 launched** — session `2026-05-04-f416c6cc`, 62 atomic tickets refined via 3-cycle team. Bundle PRD `prds/p1-bug-fix-bundle-2026-05-04.md` committed at `862381f`; refined version (61K, +31K) committed at `1f3c530`. Closer (order 750) bumps v1.70.0 + invokes `closer-release-gate.sh` (R-CLOSER-1).
- **Slot 1j cross-backend leak — Section A KEYSTONES SHIPPED via direct-execute** (commits `9437b0c 817e73c a3641e3 616f474 95f2c37`):
  - **R-CNAR-1** `9437b0c` — TICKET_TIER_BUDGETS now `{trivial:5/5min, small:10/10min, medium:30/20min, large:60/80min}`; xlarge dropped per disposition.
  - **R-XBL-2 read-side SoT** `817e73c` (mine) + `a3641e3` (worker overlay) — every spawn site reads `state.backend` via `StateManager.read()` immediately before exec. PICKLE_REFINEMENT_LOCK=1 still wins. New `--backend <name>` CLI flag emits `worker_spawn_backend_override`.
  - **R-XBL-2b** `616f474` — spawn-gate-remediator inheritance audit event.
  - **R-XBL-3 write-side tripwire** `95f2c37` — `assertBackendPreSpawn` + `worker_spawn_backend_mismatch` event + `state.flags.backend_flip_reason` carve-out for legitimate flips.
- **Bundle worker passes (run #3 + run #4) shipped 9 additional Section A residuals + Section B starts** (claude-only):
  - `cd35ae82` R-BUNDLE-CLEANUP — gitignore + remove `bundle/ac-dr-02.json` test debris (slot 1m workaround promoted to fix).
  - `6f1a5486` R-DTS-1 — typescript symlink regression assertions in `install-script.test.js` (slot 1g part).
  - `e5d64089` AC-EVENT-PAYLOAD-01 — `activity-events.schema.json` + parametrized validation across writers.
  - `50c43b9c` AC-XBL-08 — manager-relaunch backend-flip regression test.
  - `8c692f2e` R-XBL-9 — refinement-team prompts reference new event schemas.
  - `7ef0c041` R-XBL-8 — trap-door entry for spawn-morty backend resolution invariants.
  - `a2690794` R-XBL-7b — integration test reproducing actual session 2026-05-03-7d9ee8cc bug under PICKLE_REFINEMENT_LOCK=1.
  - `044a8d42` R-XBL-7 — integration test asserting `state.backend=claude` survives PICKLE_BACKEND=codex env poison.
  - `7d81aad6` R-XBL-6 — `audit-worker-backends.ts` backfill audit script.
  - `ee2ae138` R-XBL-5 — `subtool_backend_override` event from `send-to-morty.md` + `codex-rescue.md` sub-tool wrappers.
- **R-CNAR-1 part 2 — global/per-ticket cap split** (`6be334b1`, 2026-05-05) — `applyTicketTierBudget()` no longer overwrites `state.max_iterations`. The cap-check at `runMuxLoop` now fires two independent exits: per-ticket (`budgetIter >= state.current_ticket_max_iterations`) AND global (`state.iteration >= state.max_iterations`). Pre-fix bug silently truncated operator's global cap to whichever tier ceiling the manager last touched, exiting the entire pipeline at the per-ticket budget. New regression test `extension/tests/mux-runner-cap-split.test.js`. Trap-door entry added. **⚠ DEPLOY-GAP — discovered 2026-05-05 mid-day during run #5 babysit:** the fix is committed but **NOT deployed** (`~/.claude/pickle-rick/extension/bin/mux-runner.js` mtime is `May 3 10:41:42` — predates this commit). Run #5 has been running on the OLD `mux-runner.js` with the conflation bug live. The bug hasn't bitten yet because `state.max_iterations=500` is so much larger than any tier ceiling that per-ticket-budget overwriting global cap hasn't yet caused an early exit — but a single 60-iter `large` ticket passing through `applyTicketTierBudget` could trip it at any moment. Bundle closer (R-CLOSER-1) self-heals via `closer-release-gate.sh` install.sh. **Do NOT manually re-run install.sh mid-pipeline** — risk of mixed-state bugs (running runner has old code in-memory, new spawns get new code from disk). See slot 1q forensic for full deploy-parity gap analysis.
- **Two new bug PRDs filed during bundle launch** (commit `1f3c530` + `6d5a17c`):
  - `prds/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` — pipeline-runner FATAL on `bundle/ac-dr-02.json` (test-debris regenerated by `verify-recapture-fired` on every test run). Bundle's own R-BUNDLE-CLEANUP ticket can't fix because guard fires before iteration 0. Workaround: `git checkout -- bundle/ac-dr-02.json`. 4 R-PDT requirements.
  - `prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` — three compounding bugs: (1) stop-hook default-fallthrough lacks `tmux_mode` check; (2) `recoverStaleActiveFlag` doesn't bridge the `state.pid=null` AND `current_sessions.json` mapped-PID-dead gap; (3) mapped-session filter selects orphans over live-same-cwd. User-visible: "🥒 Pickle Rick Loop Active (Iteration 0 of 100)" feedback was reading orphan session `b20c7a0a`, not live bundle. Manual workaround applied: demoted orphan + repointed `current_sessions.json`. 4 R-SHB requirements.

## 🆕 2026-05-05 finding — slots 1r + 1s bundled

Two sibling judge-unreachable defects in `microverse-runner.js` filed in a single PRD: [`prds/anatomy-park-judge-unreachable-on-worker-convergence.md`](anatomy-park-judge-unreachable-on-worker-convergence.md). Both share the file and the flawed assumption that the judge can be silently bypassed without breaking convergence semantics.

- **Slot 1r** — `pipeline-2026-05-04-8aecd4c7` (claude backend, `INCOME_EXPANSION_FIX_PRD.md` over `loanlight-api-income-expansion`): 21/21 atomic tickets shipped over 173m of pickle phase (B1-B4 / M1-M7 / m1-m9 — every defect from a 3-agent review of `feat/income-expansion`). Citadel green. Anatomy-park converged across 2 iterations (`consecutive_clean=3`, 0 trap doors). **Then `validateWorkerConvergenceHistory` returned `judge_unreachable` and the runner exited 1 → szechuan-sauce skipped.** Sibling of the v1.63.0 finalizer-history-crash fix.
- **Slot 1s** — `2026-05-05-af779f40` (claude backend, szechuan-sauce on the same worktree post-pipeline): worker shipped 2 commits (`06638de8`, `d8cdd846`) and self-reported "no actionable violations remain". `measureLlmMetric` ETIMEDOUT on baseline AND on iteration 2 — twice. Runner declared `converged` (score=0) without any judge score ever produced. Manual gate run confirms the worktree is clean, but the runner had no way to verify; the convergence rested on the worker's word alone.

Combined fix: ~30 LOC + 12 ACs.

## 🔬 Run #2 forensics — three new findings to file (slots 1o/1p/1q below)

The 28-min run #2 (16:59→17:28 local) shipped 4 atomic commits then circuit-broke. Three distinct issues surfaced beyond R-XBL-{2,2b,3}:

- **F1 — codex-spark MANAGER hallucinates backend flips.** Captured tmux line: *"I'll try one last time under Hermes for that ticket, which previously fa…"* — the manager prompt narrated the flip, edited `state.backend` to `'hermes'`, then proceeded to spawn workers in a 2nd backend. R-XBL-3 (now deployed) catches this *read*-side; R12 (manager-tier reliability) materialized. **Filed as slot 1o:** worker/manager backend split (claude manager + codex-spark workers).
- **F2 — codex-spark WORKERS skip `completion_commit:` frontmatter.** Workers commit to git but don't add the YAML field, so phantom-Done watcher (correctly per contract) reverts the ticket to Todo. Compounded with F1: 4 fast manager-loops of "no progress" tripped tier=small budget=4. **Filed as slot 1p:** codex-spark worker prompt strengthening or worker-side frontmatter wrapper.
- **F3 — install.sh deploy gap on `extension/types/index.js`.** First install.sh after R-CNAR-1 + R-XBL-2 left deployed `types/index.js` at the May 3 mtime — md5 mismatch, deployed copy missing 8 events including `worker_spawn_backend_resolved`. State-manager rejected events as unknown (`WARN: ignoring unknown activity event`) for the entire run. Re-running install.sh resolved parity. Suspect: tsc cache / rsync source-not-recompiled-yet race. **Filed as slot 1q:** install.sh post-rsync md5-parity probe + tsc force-rebuild guard.

## 🚨 Live forensic during run #5 — deploy-parity gap (2026-05-05 mid-day)

**Discovered while babysitting run #5**: ALL 5 hot files DRIFT between source and deployed. Deploy mtimes uniformly `May 3 10:41:42` — predates the entire bundle and every R-XBL/R-CNAR commit. See slot 1q's `## Severity update` section for the full analysis.

```
DRIFT  types/index.js              src=7a4ce9f0  dst=f01a910e
DRIFT  services/state-manager.js   src=61d6e119  dst=c0ea25ff
DRIFT  bin/spawn-morty.js          src=9c3d2bc5  dst=d1e68707
DRIFT  bin/mux-runner.js           src=991bb0a6  dst=d377d027
DRIFT  services/pickle-utils.js    src=039b27a6  dst=90397575
```

**What this means for run #5:**
- The cap-split fix `6be334b1` is **NOT live**. Runner uses pre-fix `mux-runner.js`. Bug-not-biting is luck (`state.max_iterations=500` >> any tier ceiling).
- R-XBL-1..9 instrumentation events (`worker_spawn_backend_resolved`, etc.) are silently rejected by deployed state-manager. Monitor.js logs `WARN: ignoring unknown activity event` floods.
- 18 Done tickets' code changes are committed but NOT runtime-active. Claims of "shipped" in MASTER_PLAN refer to source state, NOT deployed state.

**Why it persists:** workers commit + tsc but never `bash install.sh`. Deploy is closer-only. CONTEXT_2026-05-05.md claims an install.sh ran at run #5 launch but disk evidence contradicts (slot 1q hypothesis: TSC same-second mtime cache miss caused a no-op rsync).

**Operator do/don't (now):**
- ❌ DO NOT run `bash install.sh` mid-pipeline. Risk: in-memory runner code (old) and new-spawn code (fresh) diverge → mixed-state bugs (new state-manager rejects old runner's events with new validation rules; old runner expects old API contracts new helpers no longer satisfy).
- ✅ Let run #5 finish. The runner has been running fine on stale code for 1h+; no reason to disturb it.
- ✅ Bundle closer ticket `bdbf368d` runs `closer-release-gate.sh` which runs install.sh. v1.70.0 tag self-heals deploy parity at bundle close.
- ✅ For the 2026-05-05 next-bundle, slot 1q's R-ITS-5 (mid-bundle deploy guardrail with auto-redeploy + kill-switch) prevents this entire class structurally going forward.

## ▶ Recommended next move (2026-05-07 PM — supersedes prior recommendation)

**Theme A pipeline (9/9) shipped + 3-fix hardening sweep landed; v1.72.2 installed locally.** Next round = drain the **6 deferred slots from `pipeline-1d81a0bb`** (G/H/I/J/K/L). Inventory agent (2026-05-07) confirmed these are the highest-impact open bug PRDs; rest are P2 quality + multi-repo work or already-shipped-needing-verification.

### Proposed bundle: 4-section P1 deferred-slots fix

Compose the four highest-impact slots into a new bundle PRD `prds/p1-bug-fix-bundle-2026-05-07-deferred-slots.md` (to be drafted). Run via `/pickle-pipeline --no-refine --backend claude` (not codex — Theme A's clean ship validated this for refinement-team-touching work, and slot G is the codex hallucination root cause itself).

| Slot | Source PRD | Pri | Why it matters |
|---|---|---|---|
| **G** | `prds/codex-classifier-prompt-leak.md` | P1 | `extractAssistantContent` plain-text fallback echoes `<promise>EPIC_COMPLETED</promise>` from prompt → false task_completed. **Root cause of MANAGER_PERSISTENT_HALLUCINATION** (Open Finding #1); bailed `pipeline-1d81a0bb` and one prior pipeline. Currently mitigated only by `--backend claude`. |
| **H** | `prds/szechuan-sauce-codex-judge-model-mismatch.md` | P1 | `init-microverse.ts:13` literal `judge_model: 'claude-sonnet-4-6'` stamps unsupported model into the codex judge → silent fake convergence. Masks real principle violations during szechuan-sauce on codex-backend pipelines. |
| **I** | `prds/p1-iteration-cap-and-phantom-done-handshake.md` (R-1 only) | P1 | Iteration cap reverts to default on `setup.js --resume`. Pipeline silently advances with unfinished work. R-2 (cap-hit exit code 3) shipped via `a7ed2a98`; R-1 (display/persistence) unverified. R-3 (phantom-Done watcher) shipped via Theme A §G. |
| **J** | mux-runner exits 0 on cap-hit | P1 | Pipeline-runner treats incomplete phase as success (should exit 3). Source PRD shared with slot I (`p1-iteration-cap-and-phantom-done-handshake.md` R-2 territory); needs end-to-end verification. |

Slots K and L stay deferred:
- **K** `prds/p1-deployed-pkgjson-version-only-revert.md` — diagnosis-only ticket. Research preserved at `prds/research-slot-K-pjv-writer-2026-05-07.md`. File its own follow-up after triaging hypotheses H-A..H-E.
- **L** `prds/p1-strip-excessive-defense-deploy-reversion.md` — ~480 LOC removal (cron sampler, mux pre-flight, scheduled finalizer, launch-gate verifier). Cron sampler stripped (`c2ec3cf1`); rest unverified. Scope-reduction work, not a bug-fix per se.

### Pre-flight checks before launching the deferred-slots bundle

1. **Verify "possibly-already-shipped" PRDs** the inventory flagged (none in the deferred-slots set, but worth knowing what the open-bug count actually is):
   - DONE-likely: `anatomy-park-finalizer-history-crash.md` (`97653071`), `anatomy-park-runner-undefined-description-crash.md` (`617a0db9`), `anatomy-park-gate-baseline-missing.md` (today's `b0f5ceca`), `loop-runner-relaunch-status-bugs.md`, `p3-monitor-watcher-continuous-auto-respawn.md`, `p3-paused-session-orphan-blocks-stop-hook.md`, `p2-install-sh-types-index-stale-on-fast-reinstall.md`, `p2-refined-tickets-trip-readiness-contract-resolver.md`, `p1-worker-spawns-codex-despite-claude-backend.md`, `p2-codex-manager-empty-queue-spin.md`.
   - Manifests covering shipped children: `p1-bug-bundle-2026-05-01-pm.md`, `p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`, `p2-mega-bundle-2026-05-02-pm.md`.
   - Each can be marked Closed if its child commits are in HEAD; do this audit BEFORE drafting the deferred-slots PRD so we don't double-count.

2. **Open Finding #3 — anatomy-park scope gap on root `/bin/`** can run as a parallel hardening track (not a blocker): `/anatomy-park TARGET=/Users/.../pickle-rick-claude/bin` on the 6 release-critical scripts.

3. **Open Finding #4 — `install.sh` chmod block hand-maintained** can also run in parallel: cheap fix (replace block with directory-glob or manifest), prevents future filemode regressions.

### Follow-up bundle (not next, but queued)

After the deferred-slots ship: a P2 quality + multi-repo bundle composing:
- `microverse-runner-stall-resilience.md` — handoff context to next worker; prevent premature false-stall convergence
- `multi-repo-task-state-drift.md` — auto-mark-done validation + per-ticket `working_dir`
- `large-tier-stall-recovery.md` — codex burns 5 iters of replanning, commits 0 LOC; 3 atomic tickets specified, no ship
- `anatomy-park-szechuan-monorepo-missed-detection-gap.md` — RC-2/RC-3 residuals (Override 6 globbing shipped via `55ef850e`; subsystem-flatten + judge-fallback unfixed)
- `anatomy-park-followups.md` — catalog hygiene + dedicated `recoverable-json.test.js` unit tests + microverse-runner relaunch path
- `large-pipeline-time-budget-undersized.md` — verify-only sweep on R-NTC residuals (header claims SHIPPED via v1.62.1; bug-2 enforcement leak unverified)

### Lessons preserved from the 2026-05-07 session

- **`--backend claude` for refinement-team-touching pipelines.** Codex `MANAGER_PERSISTENT_HALLUCINATION` keeps surfacing on this defect class. Until slot G ships, default to claude for all pipelines that touch `spawn-refinement-team.ts`/`audit-ticket-bundle.ts`/`mux-runner.ts`/refinement plumbing.
- **Test-fixture pattern**: any test that writes `state.json.tmp.<pid>` for orphan-tmp recovery MUST write a complete state snapshot (working_dir, original_prompt, started_at, session_dir, step, iteration, max_iterations, max_time_minutes, worker_timeout_seconds, start_time_epoch, history, completion_promise, schema_version). Validation in `state-manager.ts:260` rejects partial snapshots.
- **`--test-concurrency=8`** is now mandatory in `package.json:test:fast`. Node default = `cores - 1` = 23 on this box; subprocess-heavy tests blow their internal 5000ms/10000ms timeouts under that load.
- **`assertBackendPreSpawn` still does one `_sm.read()`**: cleanest follow-up is to bound `readRecoverableJsonObject`'s `readdirSync` cost in `recoverable-json.ts` (filter by literal tmp-prefix) — `/var/folders/.../T` with 70k+ entries means each read is ~6.7s. Out of scope for the deferred-slots bundle; queue separately.

## 🔔 Active Queue (refreshed 2026-05-07 PM — OPEN items only)

Inventory verified by Explore agent 2026-05-07. Closed/shipped PRDs are now in `## Shipped — recent` below.

### Next bundle target (P1/P2 — deferred slots from `pipeline-1d81a0bb` + Open Finding #12)

| # | Slot | PRD | Status |
|---|---|---|---|
| 1 | G | [`prds/codex-classifier-prompt-leak.md`](codex-classifier-prompt-leak.md) | **Open** — extractAssistantContent plain-text fallback echoes `<promise>EPIC_COMPLETED</promise>` from prompt → false task_completed. MANAGER_PERSISTENT_HALLUCINATION root cause. |
| 2 | H | [`prds/szechuan-sauce-codex-judge-model-mismatch.md`](szechuan-sauce-codex-judge-model-mismatch.md) | **Open** — `init-microverse.ts:13` literal `judge_model: 'claude-sonnet-4-6'` stamps unsupported model into codex judge → silent fake convergence. |
| 3 | I | [`prds/p1-iteration-cap-and-phantom-done-handshake.md`](p1-iteration-cap-and-phantom-done-handshake.md) (R-1) | **Open** — iteration cap reverts to default on `setup.js --resume`. R-2 (exit code 3) shipped via `a7ed2a98`; R-3 (phantom-Done watcher) shipped via Theme A §G. R-1 (display/persistence) unverified. |
| 4 | J | (shared with #3 above) — mux-runner exits 0 on cap-hit | **Open** — pipeline-runner treats incomplete phase as success. Needs end-to-end verification on cap-hit exit code. |
| 5 | — | [`prds/p2-pickle-pipeline-no-scope-auto-inference.md`](p2-pickle-pipeline-no-scope-auto-inference.md) | **Open** — Finding #12 (P2). `/pickle-pipeline` skill writes scopeless `pipeline.json` even when kickoff prompt names a branch / scopes the work. R-PSAI-1..7: regex auto-inference, Step 8 scope surfacing, pre-launch git-branch safety prompt, `lock-scope.js` mid-flight recovery, monitor pane 0 watchdog, doc/regression coverage. Bundles cleanly with #1-4: all five touch the skill-prompt + state-handoff layer. |
| 8 | — | [`prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`](p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md) | **Open** — Finding #15 (P3). Monitor pane 1.0 dashboard freezes on pickle-phase Tickets/Active/Circuit/MetricTrend after `state.step` transitions to `anatomy-park` / `szechuan-sauce`. Monitor process alive, worker-output panes (1.1/1.3) update live, but structured dashboard binds template at boot and never re-binds. Pane 1.2 ticket pointer also stuck on a pickle-phase ticket; "no stdin data received in 3s" warning loops. R-MDS-1..8: phase-boundary respawn in pipeline-runner, `monitor.js --mode <name>`, runtime mode auto-detection (defense-in-depth), `renderMicroverseDashboard` for anatomy-park / szechuan-sauce, pane 1.2 ticket→subsystem pointer swap, stdin-warning drop, trap-door + regression test. Atomic ~2-3h fix; sister to R-MWR (pane liveness) and R-PSAI-5 (pane 0 watchdog). |
| 7 | — | [`prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`](p2-citadel-conformance-core-not-wired-or-silently-skipped.md) | **Open** — Finding #14 (P2). Citadel's PRD-conformance core (T3 AC scorecard, T4 allowlist dead-entry, T6 trap-door coverage, T8 state-machine) does not surface in `citadel_report.json` despite analyzer modules shipping. Live report has 7 sections; ~7 spec'd analyzer surfaces missing or silently inert. R-CCNW-1..8: wiring diagnostic, T3/T4/T5/T8 imports into audit-runner, T6 trap-door-coverage analyzer (may be net-new module), `composes:` frontmatter walk in prd-parser (critical for bundle-PRD shape — current parser sees only ~15 inline ACs, misses ~50 lifted-by-reference), project-shape detection with `skipped: project_shape_mismatch` reason, trap-door triple recognition in rule-set-invariant-audit, regression test. Bundles cleanly with the next quality run; not pipeline-killer (citadel still earns hygiene + reconciliation value), but the core conformance gate it was built for (LOA-618 post-mortem) is currently absent for any bundle-PRD-shaped epic. |
| 6 | — | [`prds/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md`](p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md) | **Open** — Finding #13 (P1, pipeline-killer). `probeJudgeCliAvailability` runs `claude --version` with 50ms timeout AND collapses ETIMEDOUT/ENOENT/other into one `{ok:false}` boolean — caller maps any failure to `judge_cli_missing` exit reason → `pipeline-runner.ts:1670` no-finalize-gate hard exit. Smoking-gun log: `attempts: 0`, `spawnSync claude ETIMEDOUT`. Cost in triggering session: 33m03s of converged anatomy-park work (7 CRITICAL fixes) stranded with no szechuan-sauce baseline. R-MJCP-1..8: discriminated probe result, 5000ms default timeout (env-overridable), shared `classifyJudgeError` helper, regression test, trap-door. Atomic single-file fix; deserves to ship ahead of bundle close — `microverse-runner.ts` is on the hot path for every anatomy-park + szechuan-sauce phase. |

### Deferred — file separately, not in next bundle

| # | Slot | PRD | Status |
|---|---|---|---|
| 5 | K | [`prds/p1-deployed-pkgjson-version-only-revert.md`](p1-deployed-pkgjson-version-only-revert.md) | **Diagnosis-only** — research preserved at `prds/research-slot-K-pjv-writer-2026-05-07.md`. Triage hypotheses H-A..H-E before queueing fix. |
| 6 | L | [`prds/p1-strip-excessive-defense-deploy-reversion.md`](p1-strip-excessive-defense-deploy-reversion.md) | **Partial** — cron sampler stripped (`c2ec3cf1`); ~480 LOC removal across mux pre-flight, scheduled finalizer, launch-gate verifier still queued. Scope-reduction work. |

### Open Findings as standalone actions (no PRD; do as ad-hoc)

| # | Action | Why |
|---|---|---|
| 7 | ~~`/anatomy-park TARGET=…/pickle-rick-claude/bin`~~ | ✅ Closed by 2026-05-07-deferred-slots Slot L (`1c3e4c27`) |
| 8 | ~~Replace `install.sh` chmod block with directory-glob or manifest~~ | ✅ Closed by 2026-05-07-deferred-slots Slot K (`ce578369`) |
| 9 | Audit subsystem CLAUDE.md drift across `extension/src/{bin,hooks,lib,services,types}` | Open Finding #5 — partial; types/CLAUDE.md created during anatomy-park, others may be missing |

### Follow-up bundle (P2 quality + multi-repo, queued after deferred-slots)

| # | PRD | Pri | Notes |
|---|---|---|---|
| 10 | [`prds/microverse-runner-stall-resilience.md`](microverse-runner-stall-resilience.md) | P2 | Handoff context to next worker; only stall classification shipped (`c953f08a`). |
| 11 | [`prds/multi-repo-task-state-drift.md`](multi-repo-task-state-drift.md) | P2 | Auto-mark-done validation + per-ticket `working_dir`. No ship. |
| 12 | [`prds/large-tier-stall-recovery.md`](large-tier-stall-recovery.md) | P2 | Codex burns 5 iters of replanning, commits 0 LOC. 3 atomic tickets, no ship. |
| 13 | [`prds/anatomy-park-szechuan-monorepo-missed-detection-gap.md`](anatomy-park-szechuan-monorepo-missed-detection-gap.md) | P2 | Override 6 globbing shipped (`55ef850e`); RC-2 (subsystem-flatten) + RC-3 (judge fallback) unfixed. |
| 14 | [`prds/anatomy-park-followups.md`](anatomy-park-followups.md) | P3 | Catalog hygiene + `recoverable-json.test.js` + microverse-runner relaunch path. |
| 15 | [`prds/large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md) | P2 | Verify-only. Header claims SHIPPED via v1.62.1; bug-2 enforcement leak unverified. |

### Followups from 2026-05-07 hardening sweep

| # | Action | Why |
|---|---|---|
| 16 | Bound `readRecoverableJsonObject`'s `readdirSync` cost in `recoverable-json.ts` (filter by literal tmp-prefix) | `assertBackendPreSpawn` still does one slow read on macOS where `/var/folders/.../T` has 70k+ entries; cleanest follow-up to `67ae0348` |
| 17 | Push v1.72.x or tag v1.72.2 — release decision | Local-only mode by operator policy; v1.70.0 still GitHub-Latest. Decide when to break the dam. |

### Verify-then-close (possibly already shipped, inventory flagged)

Verify via `git log --grep` keyword check before drafting any new ticket — if commits are in HEAD, mark Closed.

| PRD | Likely shipping commit |
|---|---|
| `prds/anatomy-park-finalizer-history-crash.md` | `97653071` |
| `prds/anatomy-park-runner-undefined-description-crash.md` | `617a0db9` |
| `prds/anatomy-park-gate-baseline-missing.md` | `b0f5ceca` (today's) |
| `prds/p1-bug-bundle-2026-05-01-pm.md` (manifest) | child PRDs all shipped |
| `prds/p1-worker-spawns-codex-despite-claude-backend.md` | R-XBL-1..9 via 2026-05-04 bundle |
| `prds/p2-codex-manager-empty-queue-spin.md` | `8f35a00e`/`a2690794` |
| `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md` (manifest) | 30/30 children |
| `prds/p2-refined-tickets-trip-readiness-contract-resolver.md` | R-RTRC-1..7 |
| `prds/p2-install-sh-types-index-stale-on-fast-reinstall.md` | `f6909d78`/`efe0e961` (slot 1q) |
| `prds/p3-monitor-watcher-continuous-auto-respawn.md` | R-MWR-1..8 (`ed6a58e3` family) |
| `prds/p3-paused-session-orphan-blocks-stop-hook.md` | `26b1cb7a`/`aa52f83f` |
| `prds/p2-mega-bundle-2026-05-02-pm.md` (manifest) | needs full child audit |
| `prds/loop-runner-relaunch-status-bugs.md` | shipped 2026-05-01 (header) |

### Future epics (deferred, not bug-fix, do not count toward open-bug ceiling)

- `prds/hermes-integration.md` — P2 feature, ready
- `prds/deepseek-integration.md` — P3 feature, draft
- `prds/openrouter-multi-provider-workers.md` — P3 feature
- `prds/god-functions-remediation-phase-2.md` — refactor epic, 27 carve-outs
- `prds/portal-gun.md`, `prds/pickle-debate.md`, `prds/pickle-microverse.md` — methodology PRDs

**Residuals** (not their own queue slot, will be swept opportunistically):
- AC-SSV-04, AC-SSV-06, AC-LPB-07, AC-RVN-11 (24h soak), AC-RVN-12 (self-propagation negative test) — see [`state-schema-version-ordering-incident.md`](state-schema-version-ordering-incident.md), [`large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md), [`schema-version-deploy-reversion-rca.md`](schema-version-deploy-reversion-rca.md).
- **`check-readiness.ts` snapshot tmp recovery** — anatomy-park found this HIGH-confidence on session `21605b33` and trap-doored it (`extension/CLAUDE.md`, line 12), but no fix commit landed because anatomy-park exited at iter 2. Independently fixed by anatomy-park on session `c9595747` (commit `97a57c2`).
- ~~**Anatomy-park gate-baseline missing-after-commit**~~ — promoted to P1 **`prds/anatomy-park-gate-baseline-missing.md`** (queue slot #1) after recurring on session `c9595747`. Was a residual on the prior MASTER_PLAN; recurrence proves it's a hard 100% failure mode.
- Citadel post-validation gaps — see [`citadel.md`](citadel.md) `## Post-Validation Gaps`.

---

## 1. PRD Index

### Active (queued or in flight)

| Path | Status | Notes |
|---|---|---|
| `p1-bug-fix-bundle-2026-05-04.md` | **Refined (P1) — IN FLIGHT on session `f416c6cc`, codex-spark** | 62 atomic tickets composing 1e+1g+1h-WSE+1i+1j+1k + R-BUNDLE-1/2 + R-BUNDLE-DISPO-1 + R-CLOSER-1; closer ships v1.70.0 |
| `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` | **Draft (P3)** filed 2026-05-04 PM | 4 R-PDT requirements; workaround documented; file in next bundle after v1.70.0 |
| `anatomy-park-judge-unreachable-on-worker-convergence.md` | **Draft (P1) — TWO-SECTION BUNDLE** filed 2026-05-05 (slots 1r + 1s) | 12 ACs total; ~30-LOC fix in `microverse-runner.js`. Section 1 (slot 1r): skip `validateWorkerConvergenceHistory` when `metric_type='none'`. Section 2 (slot 1s): `measureLlmMetric` ETIMEDOUT must NOT silently converge — exit `judge_timeout`/`baseline_unmeasurable` with exit code 1 + exponential backoff retry budget. Sibling of the v1.63.0 finalizer fix |
| `p2-remove-pipeline-wall-clock-time-cap.md` | **Draft (P2)** filed 2026-05-05 (slot 1t) | 10 R-NTC requirements + 12 AC-NTCs. Default-off `state.max_time_minutes`; iteration caps + per-worker timeouts remain. Drops setup default, `--max-time` advisory, monitor "X/Y min" rendering, rate-limit-wait clamp, codex-manager-relaunch time-eligibility. Field stays opt-in. Supersedes `large-pipeline-time-budget-undersized.md` AC-LPB-07. Live repro: run #5 of bundle `2026-05-04-f416c6cc` was 500/720 min into the cap at launch (start_time_epoch preserved across --resume) and would have lost 48 unshipped tickets without manual operator intervention |
| `p1-worker-backend-split-from-manager.md` | **Draft (P1)** filed 2026-05-05 (slot 1o) | 8 R-WBS requirements + 8 ACs. Optional `state.worker_backend` field; spawn-morty/microverse-runner precedence: refinement-lock → worker_backend → backend. Manager unchanged. Refinement spawns ignore the field. New `worker_backend_resolved` event. Forensic origin: bundle session 2026-05-04-f416c6cc run #2 F1 (codex-spark manager hallucinated backend flip to hermes) |
| `p2-codex-spark-worker-completion-commit-contract-violation.md` | **Draft (P2)** filed 2026-05-05 (slot 1p) | 4 R-CCC requirements + 7 ACs. Three-layer fix: ACK-token in worker prompt, post-commit auto-fill helper, phantom-Done git-log cross-check. Forensic origin: run #2 lost commits 8224fc7f / 160e8816 / 4d7c4cfa to false-revert because codex-spark workers skip `completion_commit:` frontmatter ~30% of the time |
| `p2-install-sh-types-index-stale-on-fast-reinstall.md` | **Draft (P2)** filed 2026-05-05 (slot 1q) | 4 R-ITS requirements + 6 ACs. Force-rebuild compiled JS before `npx tsc`; post-rsync md5-parity probe on 5 most-trafficked compiled files; new `install_sh_parity_check` event. Forensic origin: run #2 deployed types/index.js was missing 8 activity events (incl. `worker_spawn_backend_resolved`); state-manager dropped 28 minutes of forensic events as "unknown" |
| `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` | **Draft (P2)** filed 2026-05-05 (slot 1u) | 6 R-MSCN requirements + 9 AC-MSCN. Adds `WAIT_PATTERN_REGEXES` to stop-hook; after 3 consecutive degenerate manager turns, switches to event-aware nudge (poll state.json mtime, worker-PID liveness, artifact-landing, fallback 60s timer). New `manager_idle_backoff_engaged`/`_released` events. Forensic origin: bundle session 2026-05-04-f416c6cc run #5 ticket 51d826c9 — 154 manager stop-hook turns in 27min worker wait, 133/154 are degenerate `"Waiting for Monitor signal."` |
| `p1-bug-fix-bundle-2026-05-05.md` | **Draft (P1) — BUNDLE WRAPPER** filed 2026-05-05 (queue slot #0-next) | Composes 8 source PRDs (1o + 1p + 1q + 1r/1s + 1t + 1n + 1m + 1d) into 48-61 atomic tickets. Section ordering: C (1q) FIRST, A (1o) before B (1p), H (1d) BEFORE closer. Closer ships v1.71.0. Risk Register R1-R7 + 5 AC-BUNDLE-2026-05-05-* + pre-flight checklist. Refinement directives for Cycles 1-3 |
| `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` | **Draft (P2)** filed 2026-05-04 PM | 4 R-SHB requirements (3 compounding bugs); workaround applied; file in next bundle after v1.70.0 |
| `p1-deployed-pkgjson-version-only-revert.md` | **Draft (P1)** | NEW deploy-revert bug class: pkg.json:version field reverts while file content-hashes match. Diagnostic-first |
| `p2-mega-bundle-2026-05-02-pm.md` | **Refined (P2) — IN FLIGHT on session `fca7952b`** | 6-PRD mega bundle: strip + state-drift + retry + handoff + hermes + god-fn-2; 34 tickets |
| `p1-strip-excessive-defense-deploy-reversion.md` | **In mega bundle Section A** | Drafted; will land via mega bundle |
| `p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md` | **30/30 SHIPPED in code** (session `2026-05-02-ad240987`, codex) | Refined PRD has 17 ACs; closer DEFERRED live release. v1.68.0 untagged pending strip |
| `p1-bug-bundle-2026-05-01-pm.md` | **20/20 SHIPPED** (closer commit `2c814e8`, source v1.67.0) | Anatomy-park failed downstream of deploy-reversion. v1.67.0 will NOT be tagged; v1.68.0 ships directly |
| `readiness-gate-manifest-prd-bundle-mismatch.md` | **SHIPPED via P0 bundle** Section D (commits in main) | AC-RGM-01..07 all green; bundle PRDs no longer need `--skip-readiness` |
| `pipeline-runner-state-active-not-claimed-on-relaunch.md` | **SHIPPED via P0 bundle** Section C (commits in main) | state.active claim-on-relaunch + section-c-still-needed.js gate |
| `anatomy-park-runner-undefined-description-crash.md` | **SHIPPED via P1 bundle** (commits `bddcb71`, `be5dacf`, `cee66e9`, `c8f14d7`, `17623ea`) | All 5 ACs Done; assertMicroverseStateShape + history guards landed |
| `szechuan-sauce-codex-judge-model-mismatch.md` | **SHIPPED via P1 bundle** (commits `aa2336c`, `a590b97`, `f2d938b`, `0357d29`, `26cbf98`, `effe287`, `74f463d`) | All 5 ACs Done; one-line fix at init-microverse.ts:13 + judge_unreachable exit |
| `pipeline-state-desync-and-pane-respawn-tmpdir.md` | **SHIPPED via P1 bundle** (commits `cde1175`, `9a9c9f5`, `145eaea`, `c82c181`, `f55f46c`, `47904e7`, `622cd53`, `674016b`) | T0..T5 in v1.66.0; T6..T10 in v1.67.0 closer commit |
| `hermes-integration.md` + `hermes-research.md` | **Ready (P2)** | Fourth backend `'hermes'`; 12 FRs + 5 NFRs + ~20 new tests |
| `multi-repo-task-state-drift.md` | **Refined draft** | T1-T4 partially shipped pre-v1.63.0; remainder TBD |
| `god-functions-remediation-phase-2.md` | **Draft** | 27 god-fns × ~20 tickets to remove ESLint carve-outs |
| `deepseek-integration.md` | **Draft** | Third backend via DeepSeek's Anthropic-compat shim |
| `openrouter-multi-provider-workers.md` | **Draft** | Lower priority; no source impl |
| `tool-error-retry-tracking.md` | **Draft** | OMC Ralph-mode-inspired; intra-session tool-failure tracking |
| `smart-iteration-handoff.md` | **Refined draft** | Reduce wasted iterations 30%+ in microverse / 20%+ in tmux |

### Design docs (active, no immediate ship target)

| Path | Status | Notes |
|---|---|---|
| `citadel.md` | **Draft (BMAD-merged)** | Functional core SHIPPED via T04-T27 in v1.62.x; remaining gaps in `## Post-Validation Gaps` |
| `pickle-dot-codegen-builder.md` | Refined | `/pickle-dot` design doc (138KB; bloat candidate) |
| `pickle-dot-v8-iterate-support.md` | Ready | V8 iterate handler shipped attractor-side; dot-builder awareness pending |
| `pickle-dot-codegen-builder-bdd-scenarios.md` | Draft | BDD scenarios for codegen builder |
| `bdd-scenarios-auto-patterns.md` | Draft | Auto-pattern BDD scenarios |
| `convergence-v8-topology.md` | Refined | Topology design |
| `council-of-ricks-v1.50-json-directive.md` | Ready | Council JSON directive upgrade |
| `plumbus-generative-audit-frames.md` | Refined | A1-A6 generative audit frames |
| `pickle-agent-teams.md` | Draft | Phase 3 teams-mode alternative |

### Shipped (archive — no further action)

| Release | PRDs |
|---|---|
| **(uncommitted, planned v1.65.0)** | `loop-runner-relaunch-status-bugs.md` SHIPPED via session `21605b33` (5 atomic tickets, 6 commits `087930e..67a2ca0`); standalone `ac-phase-gate.timeout` fix at `d5270c0`; doc-rationalization commits at `7b5e4df`. Anatomy-park trap-doored 2 findings on `21605b33` (commits `2c70e8c`-era CLAUDE.md updates) but exited at iter 2 with gate-baseline failure; szechuan-sauce 4/4 never ran. Awaits release gate + tag. |
| **v1.64.0** (2026-05-01) | (no PRD — pickle-standup gaps + skill launcher fix + codex test shim + lint debt; release notes only) |
| **v1.63.0** (2026-05-01) | `overnight-bug-bundle.md` (9/9 done in 109m on codex), `anatomy-park-finalizer-history-crash.md` (T1), `microverse-runner-stall-resilience.md` (T5), `large-tier-stall-recovery.md` T-A+T-B (T3+T4), `anatomy-park-followups.md` Sub-fix A+C (T6+T2) |
| **v1.62.x** (2026-04-30) | `state-schema-version-ordering-incident.md`, `large-pipeline-time-budget-undersized.md`, `schema-version-deploy-reversion-rca.md`, BMAD wave T04-T27 (under `citadel.md`) |
| **v1.59.x** (2026-04-29) | `god-functions-remediation.md` T0-T19 (16 impl + 4 hardening); codex stall hardening |
| **v1.58.0** (2026-04-28) | `convergence-toolchain-gates.md` (25 atomic tickets, 122 commits, +19,597/-1,921 LOC) |
| **v1.57.0** (2026-04-27) | Cronenberg meta-router (no PRD; designed inline) |
| **v1.56.x** (2026-04-26) | `codex-classifier-prompt-leak.md`; T0 of god-fn epic; pipeline robustness fixes |
| **Earlier** | `watcher-pane-recovery.md` (rolled into citadel-hardening-bundle), `citadel-hardening-bundle.md` (75/75 tickets done in `pipeline-1204204c`) |

---

## 2. Recently Shipped (last 3 releases)

### v1.73.0 (2026-05-09) — 2026-05-08-mega bundle (11/11 sections + closer)

- **Session**: `2026-05-09-7ff82595` (claude backend, ~5h end-to-end with worker-stall remediation by manager-side validation).
- **Bundle commit range**: `ef3b2855..6851f41f` — 10 atomic commits.
- **11 tickets shipped**: Section A (a687a05a — bundle bootstrap + DIAGNOSE disposition), Section B (f3bf3c86 — codex classifier prompt leak R-CCPL-1..6), Section C (5f7192c4 — szechuan judge model claude-routed R-SCJM-1..6), Section D (1ffc21c9 — anatomy-park scope.json edit-time preflight R-APWS-1..7), Section E (e789b21c — /pickle-pipeline scope auto-inference R-PSAI-1..7), Section F (ea802022 — recoverable-json readdir bound R-RJR-1..3), Section G (2bc35531 — subsystem CLAUDE.md drift audit R-CMD-1..4), Section H (8c4d691a — pkgjson version-only revert DIAGNOSE R-PJV-1..6), Section I (1073f7ac — R-SED-1..7 → DROP, premise absent at HEAD), Section J (3941449a — microverse judge probe ETIMEDOUT misclassification R-MJCP-1..8), Section K (a7fa5858 — closer: version 1.73.0 + deploy parity + MASTER_PLAN bookkeeping R-CLOSER-1..3).
- **Open Findings closed**: #11 (anatomy-park edit-time scope), #12 (pickle-pipeline scope auto-inference), #13 (microverse judge ETIMEDOUT), #16 (recoverable-json readdir bound).
- **Open Findings deferred**: #5 (subsystem CLAUDE.md drift) — audit script + JSON report + 5 follow-up DRAFT PRDs (`prds/p3-subsystem-claude-md-{bin,hooks,lib,services,types}.md`) landed; remediation queued.
- **install.sh** ran with `--closer-context` (active-bundle override). md5-parity 5/5 OK across `extension/types/index.js`, `extension/services/state-manager.js`, `extension/bin/spawn-morty.js`, `extension/bin/mux-runner.js`, `extension/services/pickle-utils.js`. Deployed `~/.claude/pickle-rick/extension/package.json:version` = `1.73.0`.
- **Operator note**: workers timed out at 1200s on most tickets, but produced complete artifacts before the timeout; manager validated gates (tsc + eslint + targeted tests) and committed. Timeout root-cause is in spawn-morty / claude-CLI invocation, not in any single ticket — separately filed for follow-up.
- **Release tag**: NOT pushed to GitHub (default per AC-CLOSER-04; local-only mode preserved).

### v1.69.0 (2026-05-03 PM) — mega bundle release ceremony

- **Released** at https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.69.0. Rolls up v1.67.0 (P1 bundle: anatomy-park crash + szechuan judge + pipeline-state-desync tail), v1.68.0 (P0 deploy-reversion bundle: 30 tickets + strip + trap-door fixes), and v1.69.0 closer (mega bundle 34/34 from session `fca7952b`: strip + state-drift + retry-tracking + smart-handoff + hermes + god-fn-2 + backend identity + teams validation).
- 138 commits pushed v1.66.0..HEAD. install.sh clean; src/dep parity OK at 1.69.0.
- **Known pre-existing test failures (not regressions, predate v1.66.0):** `tests/council-publish.test.js:867` (hung `gh pr comment` timeout asserts 1 call, observes 2) and `tests/scope-resolver-import-walks.test.js:111` (rg→grep fallback returns false locally). Filed as `p3-test-flakes-council-publish-and-scope-resolver.md`.

### Uncommitted (planned v1.68.0) — P0 deploy-reversion bundle (30 tickets) + P1 strip-back + trap-door fixes

- **30/30 P0 bundle tickets DONE** in code on session `2026-05-02-ad240987` (codex backend, ~9h end-to-end). Section A (14 lockdown tickets), Section B (2 gate-baseline event + verifier), Section C (2 state.active claim + re-eval), Section D (3 readiness manifest), infra (2 verify-bundle + force-vs-allow matrix), wiring, 4 hardening (HT-1..HT-4), closer, scheduled-soak.
- **Tickets that needed retry**: A.8 (mux-runner pre-flight, c56ab4a7) and A.10 (downgrade UX, 01504f22) failed first pass due to codex's strict full-suite gate; both passed on retry after `state.flags.skip_readiness_reason` bypass for the readiness gate (the bundle PRD itself triggered the very `readiness-gate-manifest-prd-bundle-mismatch.md` bug it ships a fix for — meta).
- **Closer DEFERRED live release**: `bash install.sh` hangs on `crontab` install (sandbox restriction); full `npm test` blocks on pre-existing `trap-door-conformance.test.js` failures (`extension/CLAUDE.md` lines 9, 13, 64, 76). Pkg.json still at 1.67.0; v1.68.0 not tagged on GitHub; v1.66.0 still GitHub-Latest with poison content.
- **NEW P1 strip PRD** (`prds/p1-strip-excessive-defense-deploy-reversion.md`) drops ~480 LOC of cron sampler + scheduled-soak + mux-runner pre-flight before tagging. Codebase analyst Cycle 3 already noted only AC-DR-04c is the actual fix; the rest is defense-in-depth for an unidentified writer class.
- **Trap-door fixes via 2-agent team** (uncommitted): split lines 9+13 of `extension/CLAUDE.md` into separate bullets (one INVARIANT/BREAKS/ENFORCE triple per bullet); created stub tests `extension/tests/mux-runner-state-iteration.test.js` (4 tests) and `extension/tests/get-extension-root-fallback.test.js` (3 tests). `trap-door-conformance.test.js` now 25/25.
- **Phantom session cleanup**: orphan session `2026-05-02-9e48bce6` left active by an agent's test run, deactivated to unblock stop-hook.
- Babysit cron `a3a6970f` ran 18 cycles redeploying every 30min — confirmed live the deploy-reversion bug bites continuously (~every 15-20min before A.14 force-write kill-switch landed mid-pipeline).

### Uncommitted (planned v1.67.0) — P1 bundle (anatomy-park crash + szechuan judge model + pipeline-state-desync tail)

- **All 20 tickets DONE** on session `2026-05-01-325ccb80` over two pickle phases (initial 144m + retry). Closer commit `2c814e8` bumped 1.66.0 → 1.67.0.
- Section A (anatomy-park-runner-undefined-description-crash): 5 ACs shipped (`be5dacf`, `bddcb71`, `cee66e9`, `c8f14d7`, `17623ea`). `assertMicroverseStateShape` runtime validator added; history-access guards; regression test.
- Section B (szechuan-sauce-codex-judge-model-mismatch): 5 ACs shipped (`aa2336c`, `a590b97`, `f2d938b`, `0357d29`, `26cbf98`, `effe287`, `74f463d`). One-line fix at `init-microverse.ts:13`; convergence guard against empty history; new `judge_unreachable` exit reason.
- Section C tail (pipeline-state-desync T6..T10): 5 tickets shipped (`47904e7`, `f55f46c`, `622cd53`, `674016b`, `c82c181`, `145eaea`, `9a9c9f5`, `cde1175`). EXTENSION_DIR opt-in renamed to EXTENSION_DIR_TEST; ESLint rule for bare reads; integration test; trap-door catalog.
- Plus 4 hardening tickets (H1-H4: code quality, data flow, test quality, cross-reference) + 4 anatomy-park bonus commits during the failed phase.
- **Why pipeline reported FAILED**: anatomy-park exited at iter 2 with the same gate-baseline-missing bug v1.66.0 was supposed to fix. Forensic finding: deployed extension was reverted v1.66.0 → v1.64.0 by auto-updater between install.sh and pipeline launch. **The deploy-reversion meta-bug masked all this work as if it were broken.** All 20 tickets ARE shipped in source; the pipeline phase verification failed because the runtime ran stale JS.
- v1.67.0 **NOT yet tagged** on GitHub. Held until P0 bundle ships F7 lockdown.

### v1.66.0 (2026-05-01) — anatomy-park gate-baseline missing-after-commit

- 9 atomic tickets shipped in 91m on session `bfa25a4b`. Gate-baseline write-verify, recapture-before-strict-mode, strict-red routed through stall-limit, integration test, trap-door catalog. AC-RVN-08 deploy-parity assertion already in place — but reversion happens at the auto-updater, not at install.sh.
- Tagged: `gh release create v1.66.0` on 2026-05-01 22:35 UTC. Latest on GitHub.

### Uncommitted (planned v1.65.0) — relaunch status hygiene + ac-phase-gate timeout

- **`loop-runner-relaunch-status-bugs.md` SHIPPED** via `/pickle-pipeline --backend codex` on session `2026-05-01-21605b33`. 5 atomic tickets, 6 commits `087930e..67a2ca0`. Bug A (mux-runner ownership ordering vs `ensureMonitorWindow`), Bug B (monitor pane-0 recovery), Bug C (stale `exit_reason` on relaunch + phase transition).
- Pipeline result: pickle ✓ (3 iter, 41m), citadel ✓ (1 finding), anatomy-park ✗ (iter 2, gate-baseline missing-after-commit, exit 1), szechuan-sauce never ran. Anatomy-park trap-doored 2 HIGH findings: `ac-phase-gate command-timeout` (independently fixed at commit `d5270c0`) and `check-readiness-snapshot recovery` (still open as P3 residual).
- **Standalone `ac-phase-gate.timeout` fix** at commit `d5270c0` — adds `timeout_ms?` field per AC criterion + 30-min default; threaded through `spawnSync`. New trap-door INVARIANT in `extension/CLAUDE.md` with PATTERN_SHAPE.
- **Doc rationalization** at commit `7b5e4df` — MASTER_PLAN 554→160 lines, citadel.md 1103→689 lines, BMAD appendix split out, codex prompt-design notes moved to `docs/`.
- **Test suite**: still 3464/3464 (loop-runner work added tests; counts in pipeline run). ESLint: 0 errors.
- Awaits release gate (`tsc --noEmit && eslint && tsc && npm test`) + version bump + `gh release create v1.65.0`.

### v1.64.0 (2026-05-01) — operator hygiene

- `pickle-standup` skill: closed 5 gaps surfaced live (open-PR query, product-voice lint, epic grouping, drift footer, helper-noise drop list). Linear MCP cross-reference shipped.
- 4 skill launchers (`/anatomy-park`, `/szechuan-sauce`, `/pickle-microverse`, `/plumbus`) refactored: launch microverse-runner via session-local `launch.sh` instead of brittle inline `tmux send-keys` heredocs (zsh silently mis-parsed multi-line `if/elif/fi` chains).
- Codex test shim derives version from `engines.codex` so future engine-pin bumps don't rot the fixture.
- Pre-existing lint debt cleared (8 errors → 0). Two `complexity` violations deferred to god-functions-remediation-phase-2 rows 28-29.
- Test suite: 3464/3464 pass. ESLint: 0 errors.

### v1.63.0 (2026-05-01) — overnight bug bundle

- 9-ticket bundle on codex backend at session `2026-04-30-bc104e78` (109m): APH residual finalizer fix (T1), codex-manager-relaunch service extraction (T2), tier-aware circuit-breaker budget (T3), send-to-morty Resume Detection (T4), microverse stall resilience (T5), trap-door catalog hygiene (T6), test-floor aggregator (T7), parametrized trap-door conformance lint (T8), refinement-time symbol audit (T9).
- `--skip-readiness <reason>` flag (BMAD residual P0.6) shipped as Agent A bundle (commit `deac6c5`).
- Anatomy-park audit on the diff converged clean in 2 iterations on session `2026-05-01-9ccab218` (0 confident findings, 8 candidates dropped at conf<80).

---

## 3. Current State (verified 2026-05-04 PM)

| Item | Value |
|---|---|
| Source version | **v1.69.0** (commit `bdc775f`) + 77 unpushed local commits ahead (R-ICP fixes + bundle 2026-05-04 PRD + refined PRD + 2 new bug PRDs + worker commits as they land) |
| Deployed version | **v1.69.0** + locally-deployed R-ICP fixes (md5 parity confirmed for mux-runner.js, pipeline-runner.js, check-readiness.js) + typescript symlink in place |
| Latest release on GitHub | **v1.69.0** — bundle closer ships v1.70.0 with `gh release create --latest` evicting v1.66.0 from GitHub-Latest |
| Branch state | `main`, **77 local commits ahead of `origin/main`** — NOT pushed per user instruction. Bundle closer (R-CLOSER-1) bundles all pushes |
| Working tree | CLEAN (after `git checkout -- bundle/ac-dr-02.json` workaround for slot 1m dirty-tree-guard bug) |
| Active pipeline session | **`2026-05-04-f416c6cc` IN FLIGHT on codex-spark backend** — 62 atomic tickets, R-XBL-1 first ticket Done at iteration 2; R-XBL-2 mid-implement on `extension/src/services/backend-spawn.ts`. Bootstrap flags applied: `bundle_bootstrap_mode="2026-05-04-v1.70.0"` + `skip_readiness_reason`. max-iter=∞ max-time=∞. tmux session `pipeline-f416c6cc` (4-pane monitor active). |
| Reliability bundle session retained | `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` — postmortem; 38/38 done, 0/4 phases ran. Bundle 2026-05-04 R-BUNDLE-2 snapshots this to `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` for R-XBL-6 + R-TAQ-6 backfill ACs |
| Orphan session demoted | `~/.local/share/pickle-rick/sessions/2026-05-04-b20c7a0a/` — `active=true, pid=null` orphan; manually demoted with `exit_reason='orphan-paused-no-claim'` 2026-05-04 PM (slot 1n forensic) |
| Mega bundle session retained | `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/` — 34 ticket dirs (postmortem) |
| P0 bundle session retained | `~/.local/share/pickle-rick/sessions/2026-05-02-ad240987/` — 30 ticket dirs + bundle artifacts |
| Cron watchdogs | NONE — bundle 2026-05-04 runs autonomously without cron |
| Codex backend | spark-tier production (gpt-5.3-codex-spark default; bundle is first multi-hour stress test per R12) |
| `CODEX_MANAGER_RELAUNCH_CAP` | 10 |
| `engines.codex` pin | `^0.128.0` (source); deployed re-synced via the latest install.sh |
| Today's bug logs | P0 bundle shipped + P1 strip PRD drafted |
| Test suite | strip-PRD blocking on pre-existing trap-door entries (NOW FIXED uncommitted by agent team); needs full re-run after strip+commit |

---

## 4. Resume Strategy

- **Active loop**: idempotent on `state.step` / `state.current_ticket`. If the loop exits, relaunch with `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
- **New work**: `/pickle-refine-prd <prd-path>` → review manifest → `/pickle-tmux <prd-path>` (3+ tickets) or `/pickle <prd-path>` (1-2). Backend defaults to claude; append `--backend codex` for refactor epics.
- **Pipelines**: `/pickle-pipeline <prd-path>` runs `pickle → anatomy-park → szechuan-sauce`. Sequential phase orchestrator at `pipeline-runner.ts`.

---

## 5. Cross-cutting Engineering Rules

These apply to every PR in the codebase. Detail in `extension/CLAUDE.md` and `prds/citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR. Independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`. Must be clean before tag.
3. **Source-of-truth discipline** — edit `extension/src/*.ts` and `.claude/commands/*.md` only; run `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every documented invariant in `extension/CLAUDE.md` has an enforcing test. Don't break the catalog.
5. **Hook decisions** — `"approve"` or `"block"` only (never `"allow"`).
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries only.
8. **Versioning** — semver in `extension/package.json`. Major = breaking (state schema, CLI args, hook contracts); minor = features; patch = fixes. Single bump per epic, at the closer ticket.
9. **No dirty release** — uncommitted changes MUST be committed before tagging. `git status` must be clean; compiled JS must match TS source.
10. **Greenfield discipline** — no legacy aliases, no backward-compat shims for removed code.

For codex backend specifics, see `docs/codex-prompt-design-notes.md`.

---

## 6. Quick Reference

```bash
# P0 bundle session (completed, retained for postmortem)
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-05-02-ad240987
ls $SESSION_ROOT/bundle/                                      # AC artifacts
cat $SESSION_ROOT/refinement_summary.md                       # Cycle-3 analyst summary

# Strip PRD work (manual surgical, no pipeline)
cat prds/p1-strip-excessive-defense-deploy-reversion.md       # 12 ACs, ~480 LOC removal target

# Metrics
node ~/.claude/pickle-rick/extension/bin/metrics.js          # token/commit/LOC report
/pickle-status                                                # formatted current session
/pickle-metrics                                               # aggregate report

# New work
/pickle-prd                                                   # interview → PRD
/pickle-refine-prd <prd-path>                                 # 3-cycle decomposition
/pickle-tmux <prd-path>                                       # 3+ tickets
/pickle <prd-path>                                            # 1-2 tickets, interactive
/pickle-pipeline <prd-path>                                   # full pipeline (pickle→anatomy-park→szechuan-sauce)

# Releases
gh release create vX.Y.Z                                      # tag + publish
git fetch --tags                                              # sync local tags (gh-created tags lag)
```

### Latest release links

- **v1.64.0** — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.64.0
- **v1.63.0** — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.63.0

---

## 7. Reliability Bundle — Source PRDs Closed (session 2026-05-03-7d9ee8cc, commit 7786bcb)

- [x] prds/p1-deployed-pkgjson-version-only-revert.md
- [x] prds/p2-codex-manager-empty-queue-spin.md
- [x] prds/p3-paused-session-orphan-blocks-stop-hook.md
- [x] prds/p3-test-flakes-council-publish-and-scope-resolver.md
