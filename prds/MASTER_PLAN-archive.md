# MASTER_PLAN — Archive (Historical)

Pickle Rick engineering history offloaded from `MASTER_PLAN.md` for token-efficiency on 2026-05-10.
Live `MASTER_PLAN.md` keeps only operational state. Browse here for full forensic detail.

`git log` is the authoritative source for commit-level detail; this archive preserves the prose narrative the live file used to carry.

---

## Closed Open Findings (full text)

These findings were CLOSED before 2026-05-09 and were occupying ~10K bytes in the live file as struck-through entries. Full original text preserved below in case the closing rationale needs to be re-read.

### #86 (CLOSED by B-CMWL bundle — v1.88.0, 2026-05-31) — Codex manager exits pickle at a fixed ~60-min wall; progressing-but-incomplete pickle treated as fatal

Codex manager exited the pickle phase at a fixed ~60-min wall and `pipeline-runner` treated a clean-but-incomplete pickle as fatal (`phase_incomplete_tickets`), stranding the bundle (a 40-ticket bundle needed ~13 relaunches); `--max-time 0` did not lift the wall. Fixed schema-neutrally under B-CMWL: R-CMWL-1 classifies codex `Session inactive` as a relaunchable exit (parity with claude max-turns) via `detectManagerInactiveExit` + the `codex_session_inactive` relaunch kind; R-CMWL-2 makes a progressing-but-incomplete pickle non-fatal in pipeline-runner; R-CMWL-3 resets interrupted-ticket work at the relaunch boundary so a dirty tree no longer bricks relaunch (`resetInterruptedTicketWorkForRelaunch`); R-CMWL-4 adds the manager-level no-progress guard (`codex_manager_consecutive_no_progress >= 2` → `exit_reason: 'codex_manager_no_progress'`) so relaunch cannot loop infinitely; R-CMWL-5 locks the full continuation path with an end-to-end regression test; R-CMWL-6 pins the codex-continuation invariant trap door. Source PRD: `prds/p1-bug-fix-bundle-b-cmwl-codex-manager-fixed-wall-2026-05-30.md`.

### #74 (CLOSED by B-WSWA bundle — v1.86.0, 2026-05-30) — Schema-version-bump bundle cannot self-deploy mid-run

Schema-version-bump bundle (`worker_artifact_progress`, LATEST_SCHEMA_VERSION 4→5) could not self-deploy mid-run — a running mux-runner reads the v5 state with the old binary and trips R-WSRC-2 `state_schema_version_ahead`. Resolved by draining B-WSWA as a normal bundle from a clean no-active-pipeline state: the schema bump lands inside the bundle via the schema-migration ticket (R-WSWA-1) + `_internalSchemaBump`, and the closer deploys at close so the fresh runner loads v5. R-WSWA-4 fixed the EVENT_NAMES + VALID_ACTIVITY_EVENTS drift and enriched the `worker_artifact_progress` / `worker_auto_skip_oversized` event payloads. Source PRD: `prds/p1-bug-fix-bundle-b-wswa-schema-safe-rwmw-2026-05-30.md`.

### #33 (CLOSED by B-WSWA bundle — v1.86.0, 2026-05-30) — Manager wedges on oversized ticket; spawns worker, no artifact progress

Manager wedged on an oversized ticket — repeatedly spawning a worker that made no artifact progress. Fixed schema-safely under B-WSWA: R-WSWA-2 persists `worker_artifact_progress` (the new schema field landed with the 4→5 migration) and emits K=3 zero-delta observability; R-WSWA-3 auto-skips the oversized ticket at K=5 zero-progress spawns; R-WSWA-5 locks the behavior with an end-to-end oversized-wedge regression test; R-WSWA-6 pins the trap door. Owned by B-WSWA per the drain-queue overlap rule. Source PRD: `prds/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`.

### #1 (CLOSED by 2026-05-07-deferred-slots Slot G — R-CCPL-1..6) — MANAGER_PERSISTENT_HALLUCINATION root cause unaddressed

`extractAssistantContent` + `classifyCompletion` now distinguish prompt content from model response in codex plain-text logs (block-delimiter-driven detection); worker template substring-broken tokens prevent the prompt-leak class. Trap-door pinned in `extension/CLAUDE.md` (R-CCPL-4 / classifier). Source PRD: `prds/codex-classifier-prompt-leak.md`.

### #2 (CLOSED by Theme A §G `a70db8f0`) — Codex "Done by model" without commit

Phantom-Done filesystem watcher + completion-commit-hash requirement now enforced. Source: `prds/p1-bug-fix-bundle-theme-a-refinement-quality.md`.

### #3 (CLOSED by 2026-05-07-deferred-slots Slot L — R-APBS-1..3 commit `1c3e4c27`) — Anatomy-park scope gap on root `/bin/`

`discoverSubsystems` already enumerates repo-root `/bin/` when target=repoRoot and ≥3 source files are present (verified empirically: 4 .js files, fileCount=4). Regression locked in by `extension/tests/anatomy-park-resolveSubsystems-bin.test.js` (3 tests covering the source-extension threshold and the bin-discovery contract); trap-door pinned at `src/bin/pipeline-runner.ts` (R-APBS-1..3).

### #4 (CLOSED by 2026-05-07-deferred-slots Slot K — R-ICM-1..3 commit `ce578369`) — `install.sh` chmod block hand-maintained

The hand-maintained chmod list (lines 401–437, 36 entries covering only ~26/49 `extension/bin/*.js`) is replaced with directory-glob `chmod +x "$EXTENSION_ROOT/extension/bin/"*.js`. Post-install verification loop (`R-ICM-2`) asserts every `extension/bin/*.js` + `dispatch.js` is executable; fail-loud on regression. The 4 chmod 600/700 entries (audit_file ×2, activity dir) preserved per `R-ICM-3` and verified post-install. Regression coverage: `extension/tests/integration/install-chmod-coverage.test.js`. Trap-door pinned at `install.sh (R-ICM-1 chmod glob)`.

### #6 (CLOSED by Theme A §L `3574159d`) — `/pickle-standup` output quality + accuracy

Noise filter + commit-LOA scan + repo discovery. Source: `prds/p1-bug-fix-bundle-theme-a-refinement-quality.md`.

### #8 (NEWLY-CLOSED via `cbce383a`) — test:fast fork-bomb on multi-core boxes

`cbce383a` caps `--test-concurrency=8`. Subprocess-heavy tests no longer blow their internal 5000ms/10000ms timeouts under contention.

### #9 (NEWLY-CLOSED via `67ae0348`) — spawn-morty redundant-readdir hang on macOS

`67ae0348` reuses preloaded state. Worker spawn now ~13s faster per invocation when temp dirs are large. Margin-watch follow-up: `assertBackendPreSpawn` still does one `_sm.read()`; cleanest cure is to bound `readRecoverableJsonObject`'s `readdirSync` cost in `recoverable-json.ts` (filter by literal tmp-prefix) — out of scope this session.

---

## 2026-05-07 PM Status (post-Theme-A + post-hardening)

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
  - `e6edbf29` + `ad38e946` + `cce050c7` + `e55f094f` test: orphan-tmp full-state-snapshot fix across 14 test files
  - **`b0f5ceca` fix(microverse)**: defer stale-baseline refresh failures to post-commit recapture — addresses the recurring anatomy-park pipeline-killer ✅
  - **`cbce383a` fix(test:fast)**: cap concurrency at 8 to stop boundary-timeout fork-bomb ✅
  - **`67ae0348` fix(spawn-morty)**: reuse preloaded state to avoid redundant readdirSync hangs ✅
  - **`246c81d4` + `da43416f`** chore: bump v1.72.1 → v1.72.2
- **Production gates: ALL GREEN** at `da43416f` — TypeScript clean, ESLint clean, trap-door audit clean (113 ENFORCE refs verified), phantom-Done audit clean, all targeted regression tests pass.

---

## Quick-refine pipeline on bundle PRD (2026-05-06 → v1.71.0)

**Session `pipeline-e0834dcd`** ran 9 atomic implementation tickets via `/pickle-pipeline --no-refine --backend codex`. Each ticket = 1 source PRD (slots 1o..1u + 1m + 1n + 1d + 1g residual), authored by 9 parallel `Agent` calls in ~2 min ("quick-refine" workflow validated this session). All 9 pickle-phase tickets shipped 2026-05-06; the pipeline auto-cancelled before anatomy-park phase entered. v1.71.0 tagged locally.

| Order | ID | Slot | Status | Source PRD |
|------:|----|------|--------|-----------|
| 10 | `09969d52` | 1u | Done (`162c226f`) | `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` |
| 20 | `bb08867f` | 1t | Done (`723cb99c`) | `p2-remove-pipeline-wall-clock-time-cap.md` |
| 30 | `6e80b612` | 1r/1s | Done (`0d528507`) | `anatomy-park-judge-unreachable-on-worker-convergence.md` |
| 40 | `edae8fa8` | 1o | Done (`17a18a6c`) | `p1-worker-backend-split-from-manager.md` |
| 50 | `167fcaf9` | 1p | Done (`fef590ab`) | `p2-codex-spark-worker-completion-commit-contract-violation.md` |
| 60 | `6edd8868` | 1n | Done (`b917eac1`) | `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` |
| 70 | `1a11461c` | 1g | Done (`a8c4ecb5`) — residual debt R-CNAR-7 trap-door | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` |
| 80 | `1e821336` | 1m | Done (`ea3cb135`) | `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` |
| 90 | `91601dd7` | 1d | Done (`9347af20`) — already green at HEAD | `p3-test-flakes-council-publish-and-scope-resolver.md` |

Post-pipeline lint sweep: 10 ESLint errors across `microverse-runner.ts`, `spawn-morty.ts`, `backend-spawn.ts` cleaned via helper extraction + dead-code removal before tagging v1.71.0. Workers don't run lint locally — captured as Working Rule #2.

Closer + release-gate explicitly DROPPED (local-only scope; no upstream tag publish). Carry-forwards from bundle 2026-05-04 (AC-TAQ-09, R-BUNDLE-1/2/DISPO-1, 5 Section H tickets) deferred.

---

## Path A meta-bundle — partial, abandoned (2026-05-06 mid-day)

Briefly attempted: refinement of mega bundle PRD via `/pickle-refine-prd`. First pass produced 5 meta-tickets (PRD-shape fixes, not implementation). Path A ran 3 of 4 meta-tickets (`68d9c1bf`, `62b34588`, `0b16a707` + `48047f56`) before hitting fast-failure loops on the 4th (`e83118ff` skipped). Re-refinement after path A produced only 14 deduped tickets (~6 unique work areas), missing 5 of 9 source PRDs. Abandoned for the simpler quick-refine workflow. Sessions `2026-05-05-b8465d85` and `2026-05-06-9dacd293` deactivated; refinement artifacts remain on disk.

---

## Shipped post-v1.70.0 (2026-05-05 → 2026-05-06)

- **`244b4c51`** `chore: remove audit-canary-flip from gate sequence` — 2026-05-05. Stripped `bash scripts/audit-canary-flip.sh` from CLAUDE.md (×2), `extension/scripts/check-wired.sh`, `release-gate-parity.test.js`, `release-gate-wiring.test.js`, `.github/workflows/{ci,release}.yml`. Script + fixture test preserved.
- **`49e0ff84`** `fix(trap-door-conformance)` — 2026-05-05. 5 trap-door entries (`extension/CLAUDE.md` lines 7, 127, 140, 141, 145) used grep-based ENFORCE clauses without naming a `.test.js` file. Appended explicit test refs.
- **`f6909d78` + `1949c6a4` + `efe0e961`** — Slot 1q (R-ITS-1..4) shipped via `/pickle-tmux` session `pickle-18960261`, 99 min, 1 iteration. Follow-ups: count assertion bumped 11→12 in `activity-event-payload.test.js`; install.sh `R-ITS-1` force-rebuild made TS-derived only.
- **`80430696`** `docs(prd): mega bundle 2026-05-05 — Section CF carry-forwards + slot 1q ALREADY-SHIPPED`. Closer + R-CLOSER-1 explicitly DROPPED (local-only).
- **`68d9c1bf`** `docs(prd): lift section lead requirement ACs from peer PRDs (path A meta-ticket 1/4)` — 2026-05-06.
- **`62b34588`** `docs(prd): split AC-06 into 06a (dispositions) + 06b (path-decision)` — 2026-05-06.
- **`0b16a707`** + **`48047f56`** — Path A meta-ticket 3/4: register 6 new bundle activity events through full registration quartet.
- **`34146d6e`** `docs(prd): file /pickle-quick-refine command` — 2026-05-06.
- Slot 1u/1t/1r/1s/1o/1p/1n/1g/1m/1d shipped via quick-refine pipeline (see prior section table).

### Pipeline `pipeline-1d81a0bb` (bundle 2026-05-06) — 5/12 + slot E hidden-shipped (2026-05-06 → 2026-05-07)

Pipeline bailed on `MANAGER_PERSISTENT_HALLUCINATION` at slot G; H/I/J/K/L never started.

- **`4e2e8bf8`** `feat(worker): lint + tsc gate at completion-commit (3646c20a)` — slot A.
- **`eb796544`** `docs(trap-door): complete R-CNAR-7 trap-door audit` — slot B.
- **`0da2d099`** + **`532246ec`** + **`03145060`** — slot C. `test(integration): serial tier for subprocess-heavy flakes`.
- **`97653071`** `fix(microverse): guard worker-mode finalizer history 250d5001` — slot D.
- **`c165fa9c`** `test(integration): repair worker fixture sentinels`.
- **`55ef850e`** `fix(szechuan-sauce): override 6 monorepo journal globbing (23ca1ac2)` — slot F.
- **`617a0db9`** — slot E hidden-shipped (commit message lacks ticket hash; phantom-Done watcher kept reverting Status). Theme A Section G fixes the watcher.
- Slot G bailed on `MANAGER_PERSISTENT_HALLUCINATION`. Slots H/I/J/K/L never started.

### Maintenance commits 2026-05-06 (post-pipeline)

- **`310834a4`** chore: sync lockfile version to 1.71.0.
- **`4974b86d`** refactor: lint cleanup post-pipeline.
- **`8d09c503`** docs(MASTER_PLAN): record 2026-05-06 pipeline + add bugs-first policy. v1.71.0 tagged here.
- **`e47ae8c3`** fix(install-parity): track dot-builder.js as 100644.

### anatomy-park `2026-05-07-4ca7a746`

5-subsystem rotation on `extension/src/` (bin, hooks, lib, services, types). 5 commits landed during 21/50 iterations; pipeline-killer class (b0f5ceca's stale-baseline class) ended the run.

- **`017cbc2c`** anatomy-park: bin — HIGH fix retry stale lifecycle artifact evidence
- **`63eddf8b`** anatomy-park: hooks — HIGH fix stop-hook update-check interval
- **`87ca3e97`** anatomy-park: lib — HIGH fix dotted RunContext analyzer parsing
- **`d0d8cc79`** anatomy-park: services — HIGH fix CLI backend override precedence
- **`75ab7b4d`** anatomy-park: types — HIGH fix activity-event catalog drift

---

## Just merged locally (2026-05-05 PM)

Three subsystem branches merged into `main` for build-up; held local until next release decision.

- **RTRC subsystem** (`bab6c7e2` merge of `fix/r-rtrc-readiness-contract-resolver`) — R-RTRC-1..7 readiness contract resolver false-positive fixes. 6 underlying commits. Tag `rtrc-final-checkpoint` at `5615cec0`.
- **MWR subsystem** (`ed6a58e3` merge of `fix/r-mwr-monitor-watchdog`) — R-MWR-rename + R-MWR-1..8 monitor watchdog + EOF resilience. 9 underlying commits. Tag `mwr-final-checkpoint-v3` at `9ae60002`.
- **integration-tests subsystem** (`4c97d3ad` merge of `fix/integration-tests-v1.70-followup`) — 6 fixes for pre-existing integration test failures. 6 underlying commits. Tag `integration-tests-final-checkpoint` at `7f7912ec`.

Carry-forward burn-down: 27 → 13 Todo from `prds/p1-bug-fix-bundle-2026-05-04.md`.

---

## Just shipped (2026-05-04 → 2026-05-05) — v1.70.0 direct-fix release

- **v1.70.0 — direct-fix release for run-#6 forensics** (2026-05-05) — bypassed the bundle approach (which kept dying on its own audit-gate machinery) and direct-fixed the 5 highest-impact bugs. ~150 LOC across 5 atomic fix commits. Tagged via `gh release create v1.70.0 --latest`.
  - **R-CCC-5** `49f9e12a` — Phantom-Done watcher honors `completion_commit:` frontmatter.
  - **R-CNAR-7** `96ce65cf` — Cap-check at `mux-runner.ts:2888` guards on `state.current_ticket` truthy.
  - **R-CNAR-8** `94e68316` — Atomic 5-field cache clear at every `current_ticket` nullification site.
  - **R-SHB-6** `ef8130f0` — `pruneOrphanedMapEntries(dataRoot)` helper removes phantom `current_sessions.json` entries.
  - **R-ITS-5-MIN** `52e7674d` — install.sh refuses ALL invocations during active session.
- **Slot 1l codex-spark wiring** (`59411f8`) — `gpt-5.3-codex-spark` is the default codex model. Tagged with v1.70.0.
- **P1 bug-fix bundle 2026-05-04 launched** — session `2026-05-04-f416c6cc`, 62 atomic tickets refined via 3-cycle team.
- **Slot 1j cross-backend leak — Section A KEYSTONES SHIPPED via direct-execute** (commits `9437b0c 817e73c a3641e3 616f474 95f2c37`):
  - **R-CNAR-1** `9437b0c` — TICKET_TIER_BUDGETS now `{trivial:5/5min, small:10/10min, medium:30/20min, large:60/80min}`.
  - **R-XBL-2 read-side SoT** `817e73c` (mine) + `a3641e3` (worker overlay) — every spawn site reads `state.backend` via `StateManager.read()` immediately before exec.
  - **R-XBL-2b** `616f474` — spawn-gate-remediator inheritance audit event.
  - **R-XBL-3 write-side tripwire** `95f2c37` — `assertBackendPreSpawn` + `worker_spawn_backend_mismatch` event.
- **Bundle worker passes (run #3 + run #4)** shipped 9 additional Section A residuals + Section B starts: `cd35ae82` `6f1a5486` `e5d64089` `50c43b9c` `8c692f2e` `7ef0c041` `a2690794` `044a8d42` `7d81aad6` `ee2ae138`.
- **R-CNAR-1 part 2 — global/per-ticket cap split** (`6be334b1`, 2026-05-05). DEPLOY-GAP discovered mid-day during run #5 babysit; bundle closer self-heals.
- Two new bug PRDs filed during bundle launch: `prds/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` and `prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md`.

---

## 2026-05-05 finding — slots 1r + 1s bundled

Two sibling judge-unreachable defects in `microverse-runner.js`: [`prds/anatomy-park-judge-unreachable-on-worker-convergence.md`](anatomy-park-judge-unreachable-on-worker-convergence.md). Both share the file and the flawed assumption that the judge can be silently bypassed without breaking convergence semantics.

- **Slot 1r** — `pipeline-2026-05-04-8aecd4c7` (claude backend): 21/21 atomic tickets shipped over 173m. Citadel green. Anatomy-park converged across 2 iterations. Then `validateWorkerConvergenceHistory` returned `judge_unreachable` and the runner exited 1 → szechuan-sauce skipped.
- **Slot 1s** — `2026-05-05-af779f40` (claude backend, szechuan-sauce post-pipeline): worker shipped 2 commits. `measureLlmMetric` ETIMEDOUT on baseline AND on iteration 2 — twice. Runner declared `converged` (score=0) without any judge score ever produced.

Combined fix: ~30 LOC + 12 ACs.

---

## Run #2 forensics — three new findings (slots 1o/1p/1q)

The 28-min run #2 (16:59→17:28 local) shipped 4 atomic commits then circuit-broke. Three distinct issues surfaced beyond R-XBL-{2,2b,3}:

- **F1 — codex-spark MANAGER hallucinates backend flips.** Captured tmux line: *"I'll try one last time under Hermes for that ticket, which previously fa…"*. R-XBL-3 catches this read-side; R12 manager-tier reliability materialized. Filed as slot 1o.
- **F2 — codex-spark WORKERS skip `completion_commit:` frontmatter.** Workers commit to git but don't add the YAML field. Filed as slot 1p.
- **F3 — install.sh deploy gap on `extension/types/index.js`.** First install.sh after R-CNAR-1 + R-XBL-2 left deployed `types/index.js` at the May 3 mtime. Filed as slot 1q.

---

## Live forensic during run #5 — deploy-parity gap (2026-05-05 mid-day)

Discovered while babysitting run #5: ALL 5 hot files DRIFT between source and deployed. Deploy mtimes uniformly `May 3 10:41:42`.

```
DRIFT  types/index.js              src=7a4ce9f0  dst=f01a910e
DRIFT  services/state-manager.js   src=61d6e119  dst=c0ea25ff
DRIFT  bin/spawn-morty.js          src=9c3d2bc5  dst=d1e68707
DRIFT  bin/mux-runner.js           src=991bb0a6  dst=d377d027
DRIFT  services/pickle-utils.js    src=039b27a6  dst=90397575
```

**Why it persists:** workers commit + tsc but never `bash install.sh`. Deploy is closer-only. CONTEXT_2026-05-05.md claims an install.sh ran at run #5 launch but disk evidence contradicts.

**Operator do/don't (now):**
- ❌ DO NOT run `bash install.sh` mid-pipeline. Risk: in-memory runner code (old) and new-spawn code (fresh) diverge → mixed-state bugs.
- ✅ Let run #5 finish.
- ✅ Bundle closer ticket `bdbf368d` runs `closer-release-gate.sh` which runs install.sh. v1.70.0 tag self-heals deploy parity at bundle close.
- ✅ For the next-bundle, slot 1q's R-ITS-5 (mid-bundle deploy guardrail with auto-redeploy + kill-switch) prevents this entire class structurally.

---

## Recommended next move (2026-05-07 PM, superseded by Active Queue)

**Theme A pipeline (9/9) shipped + 3-fix hardening sweep landed; v1.72.2 installed locally.** Next round = drain the **6 deferred slots from `pipeline-1d81a0bb`** (G/H/I/J/K/L). Inventory agent (2026-05-07) confirmed these are the highest-impact open bug PRDs.

### Proposed bundle: 4-section P1 deferred-slots fix

Compose four highest-impact slots into a new bundle PRD `prds/p1-bug-fix-bundle-2026-05-07-deferred-slots.md`. Run via `/pickle-pipeline --no-refine --backend claude` (Theme A's clean ship validated this for refinement-team-touching work).

| Slot | Source PRD | Pri | Why it matters |
|---|---|---|---|
| **G** | `prds/codex-classifier-prompt-leak.md` | P1 | `extractAssistantContent` plain-text fallback echoes `<promise>EPIC_COMPLETED</promise>` from prompt → false task_completed. Root cause of MANAGER_PERSISTENT_HALLUCINATION. |
| **H** | `prds/szechuan-sauce-codex-judge-model-mismatch.md` | P1 | `init-microverse.ts:13` literal `judge_model: 'claude-sonnet-4-6'` stamps unsupported model into the codex judge. |
| **I** | `prds/p1-iteration-cap-and-phantom-done-handshake.md` (R-1 only) | P1 | Iteration cap reverts to default on `setup.js --resume`. R-2 (cap-hit exit code 3) shipped via `a7ed2a98`. |
| **J** | mux-runner exits 0 on cap-hit | P1 | Pipeline-runner treats incomplete phase as success (should exit 3). |

Slots K and L stay deferred:
- **K** `prds/p1-deployed-pkgjson-version-only-revert.md` — diagnosis-only ticket. Research at `prds/research-slot-K-pjv-writer-2026-05-07.md`.
- **L** `prds/p1-strip-excessive-defense-deploy-reversion.md` — ~480 LOC removal. Cron sampler stripped (`c2ec3cf1`); rest unverified.

### Lessons preserved from the 2026-05-07 session

- **`--backend claude` for refinement-team-touching pipelines.** Codex `MANAGER_PERSISTENT_HALLUCINATION` keeps surfacing on this defect class.
- **Test-fixture pattern**: any test that writes `state.json.tmp.<pid>` for orphan-tmp recovery MUST write a complete state snapshot. Validation in `state-manager.ts:260` rejects partial snapshots.
- **`--test-concurrency=8`** is now mandatory in `package.json:test:fast`. Node default = `cores - 1` = 23 on this box.
- **`assertBackendPreSpawn` still does one `_sm.read()`**: cleanest follow-up is to bound `readRecoverableJsonObject`'s `readdirSync` cost in `recoverable-json.ts`.

---

## Older Recently Shipped (v1.63.0 → v1.69.0)

### v1.69.0 (2026-05-03 PM) — mega bundle release ceremony
- Released at https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.69.0. Rolls up v1.67.0 (P1 bundle: anatomy-park crash + szechuan judge + pipeline-state-desync tail), v1.68.0 (P0 deploy-reversion bundle: 30 tickets + strip + trap-door fixes), and v1.69.0 closer (mega bundle 34/34 from session `fca7952b`: strip + state-drift + retry-tracking + smart-handoff + hermes + god-fn-2 + backend identity + teams validation).
- 138 commits pushed v1.66.0..HEAD. install.sh clean; src/dep parity OK at 1.69.0.
- Pre-existing test failures filed as `p3-test-flakes-council-publish-and-scope-resolver.md`.

### Uncommitted (planned v1.68.0) — P0 deploy-reversion bundle (30 tickets) + P1 strip-back + trap-door fixes
- 30/30 P0 bundle tickets DONE in code on session `2026-05-02-ad240987` (codex backend, ~9h).
- Tickets that needed retry: A.8 (mux-runner pre-flight, c56ab4a7) and A.10 (downgrade UX, 01504f22).
- Closer DEFERRED live release: `bash install.sh` hangs on `crontab` install (sandbox restriction); pkg.json still at 1.67.0.
- NEW P1 strip PRD (`prds/p1-strip-excessive-defense-deploy-reversion.md`) drops ~480 LOC.
- Trap-door fixes via 2-agent team. `trap-door-conformance.test.js` 25/25.
- Babysit cron `a3a6970f` ran 18 cycles redeploying every 30min.

### Uncommitted (planned v1.67.0) — P1 bundle (anatomy-park crash + szechuan judge model + pipeline-state-desync tail)
- All 20 tickets DONE on session `2026-05-01-325ccb80`. Closer commit `2c814e8` bumped 1.66.0 → 1.67.0.
- Section A (anatomy-park-runner-undefined-description-crash): 5 ACs shipped (`be5dacf`, `bddcb71`, `cee66e9`, `c8f14d7`, `17623ea`).
- Section B (szechuan-sauce-codex-judge-model-mismatch): 5 ACs shipped (`aa2336c`, `a590b97`, `f2d938b`, `0357d29`, `26cbf98`, `effe287`, `74f463d`).
- Section C tail (pipeline-state-desync T6..T10): 5 tickets shipped.
- Plus 4 hardening tickets + 4 anatomy-park bonus commits.
- Pipeline reported FAILED due to deploy-reversion meta-bug (deployed extension reverted v1.66.0 → v1.64.0).

### v1.66.0 (2026-05-01) — anatomy-park gate-baseline missing-after-commit
- 9 atomic tickets shipped in 91m on session `bfa25a4b`. Tagged: `gh release create v1.66.0` on 2026-05-01.

### Uncommitted (planned v1.65.0) — relaunch status hygiene + ac-phase-gate timeout
- `loop-runner-relaunch-status-bugs.md` SHIPPED via `/pickle-pipeline --backend codex` on session `2026-05-01-21605b33`. 5 atomic tickets, 6 commits `087930e..67a2ca0`.
- Standalone `ac-phase-gate.timeout` fix at commit `d5270c0`.
- Doc rationalization at commit `7b5e4df`: MASTER_PLAN 554→160 lines, citadel.md 1103→689 lines.

### v1.64.0 (2026-05-01) — operator hygiene
- `pickle-standup` skill: closed 5 gaps. 4 skill launchers refactored.

### v1.63.0 (2026-05-01) — overnight bug bundle
- 9-ticket bundle on codex backend at session `2026-04-30-bc104e78` (109m): APH residual finalizer fix (T1), codex-manager-relaunch service extraction (T2), tier-aware circuit-breaker budget (T3), send-to-morty Resume Detection (T4), microverse stall resilience (T5), trap-door catalog hygiene (T6), test-floor aggregator (T7), parametrized trap-door conformance lint (T8), refinement-time symbol audit (T9).
- `--skip-readiness <reason>` flag (BMAD residual P0.6) shipped as Agent A bundle (commit `deac6c5`).

### Latest release links
- v1.64.0 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.64.0
- v1.63.0 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.63.0

---

## Offloaded from live MASTER_PLAN 2026-05-30 (reorg for babysitter-tick token-efficiency)

Findings closed by shipped bundles, removed from the live Open-Findings tables:
- **#34 R-WTB** + **#87 R-CSIS** + **#32 R-TFP** (Class C) — CLOSED via **B-PIPE-HARDEN-2 v1.81.1** (closer `c7feae53` + `2052107b`).
- **#78 R-AFCC-STALE** — CLOSED via **B-AFCC-DEEP v1.82.0**: the autofill helper was collapsed (Phase 3A, `8b0e741a`), so the cross-session stale-attribution surface vanished.
- **#27 R-MMRT** — CLOSED v1.80.1 (B-MONITOR partial); B-MONITOR residual is now only #29 R-MWCL.
- **R-QGSK** (B-QSRC half) — shipped via the stale-PRD-sweep unified `skip_quality_gates_reason` flag; B-QSRC's remaining R-RSU residual folds into B-WEDGE.

### Recently Shipped (v1.76.0..v1.82.1)
| Release | Date | Content |
|---|---|---|
| v1.82.1 | 2026-05-29 | **B-CWRR CLOSED** (#88) — citadel monorepo `workingDir`-as-`repoRoot` doubling. Class A `PipelineRuntime.repoRoot` + AC-CWRR-4 spec (`cd139d23`), Class B 5-site audit (`cf9808e9`), Class C pipeline-status counter (`b9b00df2`), closer `10b787c9`. Schema-neutral. |
| v1.82.0 | 2026-05-29 | **B-AFCC-DEEP CLOSED** (12/12) — autofill/Done-flip RCA. `TicketCompletionEvidence` module + 5 callsites (`fadc2477`), helper shims (`8b0e741a`,`d235d24d`), `git cat-file -e` reachability (`434774fc`), 8-path suite (`3de26d83`,`db992304`), R-CLOSER-ADJACENCY-AUDIT (`ab432842`), closer `0e64a705`. |
| v1.81.1 | 2026-05-28 | **B-PIPE-HARDEN-2 CLOSED** (9/9) — #34 R-WTB timeout floor, #87 R-CSIS closer-gate-expensive fix, #32 R-TFP-C flake serialization. Closer `c7feae53`, parity+lockfile `6dc6a987`, residual sync `2052107b`. |
| v1.81.0 | 2026-05-27 | **B-PIPE-BABYSIT-HARDEN** — #80 R-OMS orphan-manager reaping (`ed13a2a5`), #81 R-AISLOW pre-skip (`a03b1766`), #82 R-SJLAG heartbeat (`24cb85d0`+`94cb35c0`), closer `8978b306`. Schema-neutral. |
| v1.80.3 | 2026-05-27 | #83 R-RIC-EXPLICIT — `hasCompletionCommit` honors explicit `completion_commit:` frontmatter (`3255dec5`,`6efc4e53`,`103ef20b`,`863016bb`). |
| v1.80.2 | 2026-05-27 | #79 B-RELEASE-DRIFT — 5 root-cause classes of 12 gate failures (R-SMTEST/R-MUXQG/R-MUXAUDIT/R-EMWMOCK/R-RSFISO) + R-SMTEST-6 `827c6641`, R-RELDRIFT-2 `b2c286a2`. 13 tickets. Closer `957e3087`. |
| v1.80.1 | 2026-05-25 | #27 R-MMRT — monitor respawn validates `sessionDir`; `65bf6bd3`,`d1e5f886`,`d0ff0a85`,`6e187f67`. B-MONITOR partial. |
| v1.80.0 | 2026-05-25 | R-MEGA-SELF-FIX Phase 1+2 — #47 R-SJET (`c15b8332`,`710e5cfd`,`0286c356`,…), #46 R-SSDF AGENTS.md firewall (`82a5d453`). |
| v1.79.0..v1.79.3 | 2026-05-24 | B-FRA (#66-#69), B-APWS (#11), B-WSRC-GR (#72), B-CCRC (#73). |
| v1.78.0..v1.78.2 | 2026-05-22..23 | #18 R-FGNC, #53 R-SRAA, #48/#54 verified, #52 R-WUWC reproducer. |
| v1.77.0 | 2026-05-22 | Readiness/scope false-positive cluster + B-PIPE-LAUNCH-FRICTION (#49/#50/#51/#57/#64/#65). |
| v1.76.0 | 2026-05-22 | Release-gate stabilization + R-CCR review-hardening (16/16); flake-tail serialized via `.serial-tests.json`. |

### Closed since last update — dated detail (2026-05-22 .. 2026-05-29)

**(2026-05-22)** #58-#63 B-BABYSIT-FIX (`bf89a1a3`) + R-CCR (`e448b714`); #64 R-RHFP (`a0604987`); #65 R-RCEX (`8cb5ba79`); #50 R-SRGT (`6f71dd6a`); #57 R-RPRA verified; #49 R-PSSS (`988ed55a`,`9020c26b`); #51 R-PPSD verified; #18 R-FGNC (`48718c63`,`b5500da8`).

**(2026-05-23)** #48 R-PCFG verified (`bd5e4466`); #54 R-MRFP verified (`5501d4ed`); #53 R-SRAA (`19ff0dd1`); #5 B-AUDIT partial (`1add4451`); #32 R-TFP gate-blocking → B-FLAKE v1.76.0; B-FRA/B-APWS PRDs drafted (`cfa38603`,`46db2c27`); #52 R-WUWC B-WUWC-REPRODUCER (`d9bdb589`,`4b38893c`, closer 26301c6a).

**(2026-05-24)** #66 R-FRA, #67 R-RTRC8, #68 R-FRA-GATE, #69 R-FRA-5th — B-FRA CLOSED v1.79.0; #70 R-CCQF (`e3f510fd`); #71 R-PEDC (`e3f510fd`); #11 R-APWS B-APWS CLOSED v1.79.1 (`69aaa442`,`45223a06`,`e80eaed5`,`2aa079c2`); #72 R-WSRC-GR B-WSRC-GR CLOSED v1.79.2 (`b60d4cfb`).

**(2026-05-25)** #27 R-MMRT B-MONITOR CLOSED v1.80.1 (`65bf6bd3`,`d1e5f886`,`d0ff0a85`,`6e187f67`).

**(2026-05-26)** #5 B-AUDIT — all 5 subsystems OK under `audit-subsystem-claude-md.sh` (`6c8c29b2`→`bb7d040e`, `3255afb2`→`1a64117e`). Stale-PRD sweep: 7 P3 PRDs (R-RTPS/R-QGSK/R-POD/R-PDT/R-MWR/R-SOA) whose work shipped under other bundles — mark `status: Shipped`, no code change.

**(2026-05-27)** #80 R-OMS + #81 R-AISLOW + #82 R-SJLAG B-PIPE-BABYSIT-HARDEN v1.81.0 (PRD `p1-bug-fix-bundle-b-pipe-babysit-harden-2026-05-27.md`); #79 B-RELEASE-DRIFT v1.80.2; #83 R-RIC-EXPLICIT v1.80.3 (trap door in `services/CLAUDE.md`, ENFORCE `has-completion-commit-explicit-source.test.js`).

**(2026-05-29)** #88 R-CWRR B-CWRR v1.82.1 (PRD `p1-bug-fix-bundle-b-cwrr-citadel-workingdir-as-reporoot-2026-05-29.md`). Closer `10b787c9` (fast 5192/integration 725/expensive incl. self-skipping soak).

**R-SJET #47 / R-SSDF #46** closed via R-MEGA-SELF-FIX v1.80.0 (R-SJET-3 `c15b8332`, R-SJET-4 `710e5cfd`, R-SJET-6 `0286c356`, T-HARDEN-PROBE `65d57aab`, T-HARDEN-AUTORESUME `5a25ef7b`, T-HARDEN-DOCS `e696ce16`, env-strip `b2936a41`; R-SSDF-FW `82a5d453`+`12373766`). **R-CCRC #73** via B-CCRC v1.79.3 (`06d6a905`,`0e04b5ca`).
