---
backend: codex-required
bundle: true
priority: P0+P1+P2+P3
target_release: v1.63.0
---

# PRD: Overnight Bug Bundle — Pickle-Pipeline Stability + Stall + Drift + UX

**Status**: Bundle manifest (2026-04-30 PM) — refine + ship overnight via `/pickle-pipeline --backend codex`
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Type**: **Manifest PRD** — composes 6 source PRDs into one ordered, deduped overnight ticket queue. Refiner produces one combined queue (~24 tickets across 6 sub-bundles). Source PRDs stay independently shippable; this manifest only sequences them and adds cross-cutting bundle-level acceptance gates.

---

## 🔔 Why a bundle, why now

Six independent bug PRDs are queued and locked in priority order in `prds/MASTER_PLAN.md` §2.3. Running them as separate sessions would burn 6 setup costs, 6 review passes, 6 lint+test gate runs, and 6 release tags. They also touch overlapping files (microverse-runner, mux-runner, pickle-utils) — sequenced as a single overnight bundle they share refactor diff hygiene, gate verification, and a single version bump.

The P0 (`anatomy-park-finalizer-history-crash`) is also a hard prerequisite: every other bundle PRD that includes anatomy-park or szechuan-sauce in its verification will hit the finalizer crash and fail without it. Bundling forces correct ordering.

---

## Source PRDs (in execution-priority order)

| # | Source PRD | Sub-bundle key | Tier | Tickets (rough) | Files-of-record |
|---|---|---|---|---|---|
| 1 | `prds/anatomy-park-finalizer-history-crash.md` | **APH** | P0 — pipeline-blocking | 6 (F1..F6) | `microverse-runner.ts`, `init-microverse.ts`, `types/index.ts`, `eslint-plugin-pickle/`, 2 new test files |
| 2 | `prds/anatomy-park-followups.md` (Sub-fix C only — extract relaunch helper) | **APF-C** | P3 (lifted to P0-tier ordering — shares files with APH) | 1 (T3) | `microverse-runner.ts`, new `services/codex-manager-relaunch.ts`, `mux-runner.ts`, `microverse.test.js` |
| 3 | `prds/anatomy-park-followups.md` (Sub-fixes A, B) | **APF-AB** | P3 | 2 (T1 catalog, T2 recoverable-json tests) | `extension/CLAUDE.md`, new `recoverable-json.test.js` |
| 4 | `prds/watcher-pane-recovery.md` | **WPR** | P2 | 4 (T1..T4) | `pickle-utils.ts` (`restartDeadWatcherPanes`), `tmux-monitor.sh`, `ensure-monitor-window.test.js`, `extension/CLAUDE.md` |
| 5 | `prds/large-tier-stall-recovery.md` | **LTS** | P2 | 3 (T-A, T-B, T-C verification) | `mux-runner.ts`, `types/index.ts`, `state-manager.ts`, `send-to-morty.md`, `send-to-morty-review.md`, 2 new test files |
| 6 | `prds/multi-repo-task-state-drift.md` | **MRD** | P2 | 4 (T2, T4, T1, T3 in dep order) | `pickle-utils.ts`, `mux-runner.ts`, `types/index.ts`, `pickle.md`, `pickle-refine-prd.md` |
| 7 | `prds/microverse-runner-stall-resilience.md` | **MRS** | P1 | 4 (AC-1..AC-4 → 4 atomic) | `microverse-runner.ts`, `microverse-state.ts`, microverse tests |

**Sub-bundle execution order** (locked — derived from §Sequencing Rationale below):

```
APH  →  APF-C  →  APF-AB  →  WPR  →  LTS  →  MRD  →  MRS  →  bundle-close
```

Refiner is free to interleave when files don't conflict, but **must respect APH→APF-C→MRS hard fence** (all three touch `microverse-runner.ts`, must rebase forward not concurrently).

---

## Sequencing Rationale

1. **APH first.** P0. Every other PRD that runs anatomy-park or szechuan-sauce in its verification (and the bundle's own end-to-end gate AC-OBB-04) will crash on the finalizer until APH ships. Without APH, the bundle cannot self-verify.
2. **APF-C second.** It extracts `evaluateCodexManagerRelaunch` from `mux-runner.ts` into `services/codex-manager-relaunch.ts` and wires it into `microverse-runner.ts`. APH lands defensive guards in `microverse-runner.ts`; if APF-C lands first the extraction touches lines APH wants to edit. Reverse order = clean rebase.
3. **APF-AB third.** A1 (catalog hygiene) clears the baseline for the new trap-door entries that APH-F8, APF-C, WPR-T4, LTS T-A, and MRS will all add. Catalog hygiene before catalog growth = less merge churn. B (recoverable-json tests) is fully independent; can run in parallel.
4. **WPR fourth.** Adds new trap-door entry (T4) — must follow APF-A so it lands on a clean baseline. Touches `pickle-utils.ts` but only adds a new function (no overlap with MRD's edits to existing functions in the same file). Independent of microverse work.
5. **LTS fifth.** Touches `mux-runner.ts` (circuit breaker), `types/index.ts` (state schema fields), `send-to-morty.md`. Independent of microverse work. Conflicts with MRD on `mux-runner.ts` and `types/index.ts` → must land before MRD.
6. **MRD sixth.** Touches `mux-runner.ts` (transition block), `pickle-utils.ts` (status taxonomy + handoff), `types/index.ts` (`multi_repo_warning` event). Comes after LTS to share state-schema bumps in one rebase.
7. **MRS seventh.** Touches `microverse-runner.ts` (handoff builder + stall classifier) and `microverse-state.ts`. Must follow APH to avoid rebase grief on the same `buildMicroverseHandoff` function APH guards. Also benefits from APF-C's relaunch helper being deployed.
8. **Bundle close.** Single version bump to v1.63.0 + GH release + `bash install.sh` + smoke gate.

---

## Bundle-Level Acceptance Gates

These fire at bundle finalize-time, in addition to each source PRD's own ACs.

### Phase: pre-refinement
- **AC-OBB-01** Refinement manifest must produce ≥1 ticket per source PRD. Refiner cycle's `all_success: true`. Output `refinement_summary.md` enumerates source-PRD coverage.

### Phase: per-phase (during pickle execution)
- **AC-OBB-02** APH→APF-C→MRS hard fence honored: no MRS ticket starts before all APH tickets are Done; no APF-C ticket starts before all APH tickets are Done. Pipeline-runner must respect `links: depends_on` (per AC-SSV-05 already shipped in v1.62.0).
- **AC-OBB-03** Single `services/codex-manager-relaunch.ts` extraction — APF-C's helper must be the single source of truth. After APF-C lands, no copies of the relaunch logic remain in `mux-runner.ts` (grep `evaluateCodexManagerRelaunch` returns only the extracted module + the import sites). Test: `extension/tests/codex-manager-relaunch.test.js` covers both call sites with the same mock fixture.

### Phase: post-pickle (anatomy-park + szechuan-sauce on this bundle's diff)
- **AC-OBB-04** Bundle's anatomy-park phase must converge cleanly (proves APH F1+F5 fix in production). `pipeline.json` finalize-time check: phase 2 `exit_reason === 'converged'` AND `microverse.json` `exit_reason === 'converged'` (no overwrite). If APH fix is broken, this AC will fail loudly instead of silently — by design.
- **AC-OBB-05** Bundle's szechuan-sauce phase reaches Phase 3 at all (proves `pipeline-runner` advances past anatomy-park). Pre-fix this never happens; post-fix it must.

### Phase: bundle-end
- **AC-OBB-06** Single version bump to `v1.63.0` (semver minor — new flags, new slash command guidance, new state fields, new activity events; no breaking schema change because `convergence_mode` defaults to `'metric'`). One commit `chore: bump version to 1.63.0 — overnight bug bundle`. One `gh release create v1.63.0`.
- **AC-OBB-07** All trap-door entries added by this bundle conform to `AC-BUNDLE-17` (≤1500 chars, one INVARIANT/BREAKS/ENFORCE triple per entry, ENFORCE names a `.test.js` file) — same standard as the citadel bundle. APF-A's hygiene pass is the standard; all new entries from APH/APF-C/WPR/LTS/MRD/MRS must meet it on first write.
- **AC-OBB-08** Test suite at bundle close: ≥3404 + (sum of new tests across 6 PRDs) tests pass. Concretely: APH adds ≥6 (F1..F5 unit + AC-APH-06 integration), APF-AB adds ≥6, WPR adds ≥3, LTS adds ≥7 (5 in T-A + 5 in T-B, capped per spec), MRD adds ≥10, MRS adds ≥4. **Floor: 3440 tests pass.** No skipped tests (per existing 0-skip invariant).
- **AC-OBB-09** ESLint clean (`npx eslint src/ --max-warnings=-1`) AND new lint rule from APH-F8 (`forbid bare .convergence.history access`) is registered AND fires on a deliberate violation in a fixture test.
- **AC-OBB-10** `tsc --noEmit` clean.
- **AC-OBB-11** `bash install.sh` from repo root deploys to `~/.claude/pickle-rick/` cleanly (parity check from `assertSchemaVersionDeployParity` shipped in v1.62.0 must remain green).
- **AC-OBB-12** Bundle-end emits one summary `memory/overnight_bundle_<date>.md` listing every commit grouped by sub-bundle, every new test, every new trap-door entry, and the `v1.63.0` release URL. Pattern: like `meeseeks-summary.md` but cross-PRD.

---

## Decisions (locked at manifest authoring time)

| Decision | Value | Why |
|---|---|---|
| **Backend** | `codex` | Validated production-grade for large refactor epics (god-fn epic, citadel bundle). Per-bundle CAP already raised to 10 in `932ac54`. |
| **Tier overrides** | LTS T-A's tier-aware budgets (`large: 12`, `medium: 5`, `small: 4`, `trivial: 3`) ship with this bundle and the bundle itself benefits — APH F1..F5 are large, MRS AC-1..AC-4 are large | Self-bootstrapping: the fix that gives codex more headroom on large tickets is in this bundle's first execution wave. Order T-A early so subsequent large tickets get the headroom. **Deviation from APH→APF-C→APF-AB sequence: LTS T-A may slot in at order=15 before WPR for self-bootstrap.** Refiner decides if this is worth the rebase risk. Default: keep linear sequence. |
| **Convergence mode for bundle's anatomy-park phase** | `worker` (the default) | Proves APH F1+F5 in production. Don't switch to metric mode just to dodge the bug — the bug is the point. |
| **Single version bump** | At bundle close, after every sub-bundle Done | Per `extension/CLAUDE.md` semver: this is **minor** (new features: flags, slash-command updates, state fields, activity events; backward-compatible). v1.62.2 → v1.63.0. |
| **Refinement cycles** | 3 (default) | Bundle is large enough that risk-scope analyst output is load-bearing. |
| **Refinement analysts** | `requirements / codebase / risk-scope` (default) | Same as citadel bundle. |
| **`max_iterations`** | 500 | Bundle-wide ceiling; per-ticket budgets driven by LTS T-A tier-aware policy once it lands. |
| **`max_time_minutes`** | 720 (default) — refiner may bump to 1080 if estimate suggests >720m | Per `prds/large-pipeline-time-budget-undersized.md` AC-LPB-07 (manifest-aware default at launch — partially shipped via Step 0.5 sizing prompt). 24 tickets × ~25m avg on codex ≈ 10h. Comfortable in 1080m. |
| **`worker_timeout`** | 1200s (default) | Sufficient for tier=`large` tickets. |
| **Stall limits** | 3/5 (default) | Per pipeline.json schema. |

---

## Refinement Inputs

The refiner receives this manifest plus the 6 source PRDs in execution order. Output expected:

1. `<SESSION_ROOT>/refinement_manifest.json` — `all_success: true`
2. `<SESSION_ROOT>/refinement/analysis_{requirements,codebase,risk-scope}.md` — per-cycle artifacts
3. `<SESSION_ROOT>/refinement_summary.md` — per-source-PRD coverage map + ticket count + cross-PRD risk register
4. `<SESSION_ROOT>/decomposition_manifest.json` — ~24 atomic tickets in execution order, each with `links: depends_on` correctly populated for the APH→APF-C→MRS hard fence (per AC-OBB-02)

Refiner is allowed to:

- **Drop a ticket** if a source PRD's AC is already satisfied by HEAD (e.g. APF-C might be partly done if `evaluateCodexManagerRelaunch` was already extracted in some commit since the source PRD was authored — verify before re-doing).
- **Merge two tickets** if they touch the same function in the same file with no AC delta (e.g. two APH F* fixes that both edit `writeFinalReport`'s shape — refiner may combine into one ticket with both AC tags).
- **Split a ticket** if a source PRD's "atomic" ticket is actually two concerns (e.g. MRD T2 mixes schema field + handoff display — those can split if tier budgets benefit).
- **Add a ticket** if cross-PRD analysis surfaces a missing concern (refinement-derived ticket — flag with `NEW-T*` prefix per citadel bundle convention).

Refiner is NOT allowed to:

- Change AC verification commands defined in source PRDs.
- Skip the APH→APF-C→MRS hard fence (AC-OBB-02 will fail at bundle finalize-time).
- Drop any source PRD entirely. If refiner believes a source PRD is obsolete, surface in `refinement_summary.md` as a flagged decision; do not silently exclude.

---

## Cross-PRD Risk Register

Surfaced by composing the 6 source PRDs. Source-PRD-internal risks stay in their own files.

| ID | Risk | Source PRDs implicated | Mitigation |
|---|---|---|---|
| **R-OBB-01** | Three PRDs (APH, APF-C, MRS) edit `microverse-runner.ts` non-overlappingly but rebase storms across iterations might confuse codex worker | APH, APF-C, MRS | APH→APF-C→MRS hard fence (AC-OBB-02). Refiner emits explicit `links: depends_on` chain. Worker prompts (`send-to-morty.md`) per LTS T-B Resume Detection block already handle multi-iteration continuity. |
| **R-OBB-02** | Two PRDs (LTS, MRD) edit `state.json` schema (LTS adds `current_ticket_tier`, `current_ticket_budget`; MRD adds `multi_repo_warning` event + indirectly `working_dir` per ticket) | LTS, MRD | Both are additive, optional fields; both default-safe. No `schemaVersion` bump required (still v3 from v1.62.0). Refiner verifies via `state-manager.test.js` migration coverage. |
| **R-OBB-03** | APF-C extracts `evaluateCodexManagerRelaunch` from mux-runner; LTS T-A also edits mux-runner's circuit-breaker logic. Two different functions but same file. | APF-C, LTS | LTS T-A scope is the trip site (`No progress in` log line) and a new helper `getCircuitBreakerBudget` — non-overlapping with APF-C. Refiner sequences APF-C before LTS so file is in stable extracted shape. |
| **R-OBB-04** | MRS AC-3 (gap analysis refresh on accept) writes to disk after every iteration — risks disk thrash on long microverse runs | MRS | MRS AC-3's append is bounded (one block per accepted iteration, max 5 commits per session of typical work). Negligible vs the 12h microverse run already tolerates. |
| **R-OBB-05** | LTS T-B's Resume Detection block in `send-to-morty.md` introduces a phase-skip table — codex literal-bleed class might skip Step 5 (Implement) when an old `code_review_*.md` says PASS but the diff was reverted | LTS | LTS R3 mitigation: stale-mtime guard is mandatory, not optional. Refiner verifies in T-B test fixtures (case e). |
| **R-OBB-06** | The bundle's own anatomy-park phase will exercise APH F1..F5 against the bundle's own pickle-phase diff. If APH ships broken, AC-OBB-04 fails AND the bundle exit code is 1 AND szechuan-sauce never runs. | APH | This is intentional — proves APH end-to-end. Operator workaround per `prds/anatomy-park-finalizer-history-crash.md` "Operator workaround" section if it triggers. Pre-bundle verification: run APH unit tests (AC-APH-01..05) green BEFORE pickle phase enters anatomy-park. |
| **R-OBB-07** | Schema-version-deploy-reversion (the v1.62.0-shipped infrastructure) must hold across the bundle's overnight run. If watchdog `614355bb` fires, it auto-fixes per the established whitelist. | All | Already mitigated. Runtime monitoring via `${SESSION}/watchdog.log`. |
| **R-OBB-08** | Bundle finalizes at v1.63.0 but local tags lag (per §2.3 note). User must run `git fetch --tags` post-release. | All | Document in bundle close summary. Non-blocking. |
| **R-OBB-09** | LTS T-C ("end-to-end verification" — relaunch the god-fn epic) is N/A — god-fn epic already shipped (T0–T19 Done per MASTER_PLAN §2.1). Refiner must skip T-C OR replace it with "verify large-tier ticket lands within tier budget" using one of this bundle's own large tickets (APH F1..F5 or MRS AC-1..AC-4) as the test. | LTS | Refiner replaces T-C with `LTS-T-C': verify a large-tier ticket from this bundle reaches Done within 12 iterations`. Documented in `refinement_summary.md`. |
| **R-OBB-10** | LTS T-A's tier budget ships into the bundle execution itself — but the bundle is already running when T-A lands, so iter 1 of every ticket BEFORE T-A still uses the old 5-iter budget | LTS | Sequence T-A early (order≤30 in refiner output) so tier-aware budgets are live for the rest of the bundle. Tickets BEFORE T-A use old budget; that's acceptable because APH/APF-C/APF-AB tickets are mostly small/medium. |

---

## Pre-Launch Checklist (operator)

Run these before invoking `/pickle-pipeline` over this manifest:

1. **Working tree clean** — `git -C ... status` must show no uncommitted changes EXCEPT the in-progress validation-pass commit (current branch has `extension/tests/activity-logger.test.js`, `extension/tests/types-gate-events.test.js`, `prds/large-pipeline-time-budget-undersized.md`, `prds/state-schema-version-ordering-incident.md` modified — commit these first per MASTER_PLAN §2.3 final note).
2. **Test baseline** — `cd extension && npm test` must show 3404 pass / 0 fail / 0 skipped.
3. **Lint baseline** — `npx eslint src/ --max-warnings=-1` clean.
4. **TS baseline** — `npx tsc --noEmit` clean.
5. **Deployed parity** — `bash install.sh` recently run; `cat ~/.claude/pickle-rick/extension/types/index.js | grep schemaVersion` returns 3.
6. **Tag sync** — `git fetch --tags` so `gh release create v1.63.0` doesn't conflict.
7. **Codex CLI available** — `which codex && codex --version` works (per LTS context).
8. **Free disk** — bundle session dir + 6h of iteration logs ≈ 500MB headroom.

---

## Launch (commands of record)

```bash
SESSION_ROOT=/Users/gregorydickson/.local/share/pickle-rick/sessions/$(date +%Y-%m-%d)-$(openssl rand -hex 4)
mkdir -p "$SESSION_ROOT"
cp prds/overnight-bug-bundle.md "$SESSION_ROOT/prd.md"

node ~/.claude/pickle-rick/extension/bin/setup.js \
  --tmux --resume "$SESSION_ROOT" \
  --max-iterations 500 \
  --max-time 1080 \
  --worker-timeout 1200 \
  --backend codex

# pipeline.json written: phases [pickle, anatomy-park, szechuan-sauce]
tmux new-session -d -s pipeline-$(basename "$SESSION_ROOT") -c "$SESSION_ROOT"
tmux send-keys -t pipeline-$(basename "$SESSION_ROOT") \
  "node ~/.claude/pickle-rick/extension/bin/pipeline-runner.js $SESSION_ROOT" C-m
```

Refinement runs first (claude backend per skill contract), then implementation flips to codex per the manifest frontmatter `backend: codex-required` (AC-BUNDLE-18 from the citadel bundle enforces this — non-codex invocation rejected at startup).

---

## Live Monitoring

```bash
tmux attach -t pipeline-<hash>                            # full-screen monitor
tail -f $SESSION_ROOT/tmux-runner.log                     # orchestrator
ls -t $SESSION_ROOT/tmux_iteration_*.log | head -1 | xargs tail -f
git log --since="$(date -v-12H +%Y-%m-%d\ %H:%M)" --oneline   # commits since launch
node ~/.claude/pickle-rick/extension/bin/metrics.js       # token/commit/LOC report
tmux kill-session -t pipeline-<hash>                      # graceful shutdown (active=false → watchers self-terminate)
```

---

## Resume Strategy

If `pipeline-<hash>` exits before completion:

```bash
node ~/.claude/pickle-rick/extension/bin/pipeline-runner.js $SESSION_ROOT
```

Pipeline-runner is idempotent on `state.step` / `state.current_ticket`. Watcher pane recovery during phase transitions is delivered by **WPR sub-bundle** earlier in the queue (so by the time anatomy-park or szechuan-sauce kicks in, watcher recovery is live).

If APH ships broken and AC-OBB-04 trips:

1. Confirm finalizer crash per APH source PRD §"Operator workaround".
2. Edit `${SESSION_ROOT}/pipeline.json` to drop `anatomy-park` from `phases`.
3. Re-launch pipeline-runner — szechuan-sauce will run on the pickle-phase diff (still proves AC-OBB-05 partially).
4. Open a follow-up bug PRD against APH and stack on top.

---

## Out of Scope

- BMAD residual §1.1 follow-ups (separate bundle PRD, recommended next).
- SSV/LPB/RVN residuals (AC-SSV-04, AC-SSV-06, AC-LPB-07, AC-RVN-11/12) — too small to bundle, batch with BMAD residuals.
- god-functions-remediation-phase-2 (refactor, not bug — separate epic).
- openrouter-multi-provider-workers, tool-error-retry-tracking, smart-iteration-handoff (all "Not started, lower priority" per MASTER_PLAN §1).

---

## Files Touched (composite, deduplicated across source PRDs)

```
extension/src/bin/microverse-runner.ts           # APH (F1-F5), APF-C (T3 wiring), MRS (handoff + classifier)
extension/src/bin/init-microverse.ts             # APH (F7 convergence_mode population)
extension/src/bin/mux-runner.ts                  # APF-C (extract relaunch), LTS (T-A circuit breaker), MRD (T1 + T3 transition + multi-repo)
extension/src/services/codex-manager-relaunch.ts # APF-C (NEW — extracted from mux-runner)
extension/src/services/microverse-state.ts       # MRS (recordAmnesiacExit)
extension/src/services/pickle-utils.ts           # WPR (restartDeadWatcherPanes), MRD (T2 + T4 status taxonomy + handoff)
extension/src/services/state-manager.ts          # LTS (T-A allowlist update if needed)
extension/src/types/index.ts                     # APH (F6 MicroverseSessionState shape), LTS (T-A state fields), MRD (T3 multi_repo_warning event), all additive
extension/eslint-plugin-pickle/index.js          # APH (F8 forbid bare .convergence.history)
extension/scripts/tmux-monitor.sh                # WPR (T1 if helper logic shared)
extension/CLAUDE.md                              # APF-AB-A (catalog hygiene), WPR (T4 trap-door), APH/APF-C/LTS/MRD/MRS new entries
.claude/commands/send-to-morty.md                # LTS (T-B Resume Detection)
.claude/commands/send-to-morty-review.md         # LTS (T-B Resume Detection adapted)
.claude/commands/pickle.md                       # MRD (T2 working_dir field, T1 TASK_COMPLETED, Skipped re-attempt)
.claude/commands/pickle-refine-prd.md            # MRD (T2 working_dir field)

# NEW test files (composite)
extension/tests/microverse-runner-finalizer.test.js   # APH F1..F5
extension/tests/pipeline-runner-anatomy-park.test.js  # APH F6 integration
extension/tests/codex-manager-relaunch.test.js        # APF-C extracted helper
extension/tests/recoverable-json.test.js              # APF-AB-B
extension/tests/ensure-monitor-window.test.js         # WPR T3
extension/tests/mux-runner-circuit-breaker.test.js    # LTS T-A
extension/tests/send-to-morty-resume.test.js          # LTS T-B

# UPDATED test files
extension/tests/microverse.test.js                    # APF-C T3 regression
extension/tests/pickle-utils.test.js                  # MRD T2, T4 + WPR shared util tests
extension/tests/mux-runner.test.js                    # MRD T1, T3
```

---

## Linked Context

- All 6 source PRDs as listed above.
- Bug-PRD priority ladder: `prds/MASTER_PLAN.md` §2.3.
- Refiner skill: `.claude/commands/pickle-refine-prd.md` — produces 3-cycle × 3-analyst manifest.
- Pipeline runner: `extension/src/bin/pipeline-runner.ts` — sequences pickle → anatomy-park → szechuan-sauce; reads `pipeline.json`; respects `links: depends_on` per AC-SSV-05 (shipped v1.62.0).
- Manifest pattern of record: `prds/citadel-hardening-bundle.md` (75-ticket precedent, shipped 2026-04-30 PM as 75/75 Done in 424m).
- Self-bootstrapping precedent: convergence-toolchain-gates v1.58.0 (Phase 1 ran on claude rate-limited at 5h, phases 2/3 ran on codex 5–10× faster, gate caught its own bugs in-loop).
