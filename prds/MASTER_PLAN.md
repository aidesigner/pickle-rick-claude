---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-24.** Live ledger: status, open findings, queue, feature epics. Historical narrative (mega-campaign saga, per-commit detail, pre-2026-05-15 releases) lives in `MASTER_PLAN-archive.md` and git history.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.79.2** — 2026-05-24 |
| Latest GitHub release | v1.79.2 — 2026-05-24 |
| Active pipeline | none |
| Codex backend | `gpt-5.4` |

**Priority directive (operator):** drain bug bundles before feature epics. Feature epics do not count toward the open-bug ceiling.

**Dispatch order (reprioritized 2026-05-25):** **R-CSI Phase 1** forensics (operator-gated, B-CSI awaiting next sibling-session incident). Feature epics R-PGI → R-PIAP now eligible after R-MEGA-SELF-FIX v1.80.0 closes Phase 1+2. Promotions explained inline in Open Findings tables.

**2026-05-22..25 — 9 releases (v1.76.0..v1.80.0), 20 findings closed; B-FRA v1.79.0; B-APWS v1.79.1; B-WSRC-GR v1.79.2; B-CCRC v1.79.3; R-MEGA-SELF-FIX Phase 1+2 v1.80.0.** Detail in `## Recently Shipped` + `## Closed since last update`.

---

## Open Findings

Prioritized by severity × recurrence × blast radius (reprioritized 2026-05-23):
- **P1** = data-loss / silent corruption / pipeline-bricking / recurrence ≥3x
- **P2** = pipeline-friction / one-time blocker with workaround / quality gap
- **P3** = polish / documentation / niche edge cases

Each open finding: code + one-line + PRD pointer + impact rationale. Closed-finding detail in `MASTER_PLAN-archive.md`.

### P1

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 25 | R-CSI | Concurrent claude-session destructive-command interference (3 SIGINT incidents/36h) — DATA LOSS class | `p1-concurrent-claude-session-interference-with-running-pipelines.md`. Phase 1 forensics deferred per operator (await next incident). |
_(R-SJET #47 closed via R-MEGA-SELF-FIX v1.80.0 — R-SJET-3 nested-claude env isolation `c15b8332`, R-SJET-4 all_judge_backends_exhausted `710e5cfd`, R-SJET-6 integration tests `0286c356`, T-HARDEN-PROBE `65d57aab`, T-HARDEN-AUTORESUME `5a25ef7b`, T-HARDEN-DOCS `e696ce16`, env-stripping regression fix `b2936a41`. See `## Closed since last update (2026-05-25)`.)_
_(R-SSDF #46 closed via R-MEGA-SELF-FIX v1.80.0 — R-SSDF-FW AGENTS.md firewall detection + TASK_NOTES integration `82a5d453` + ignore `12373766`. See `## Closed since last update (2026-05-25)`.)_
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse — manager loop control regression | R-ICDM-1 shipped; R-ICDM-2..7 audit. **B-R-MMTR.** |
_(R-CCRC #73 closed via B-CCRC v1.79.3 — `06d6a905` R-CCRC-1 ref-code fallback + `0e04b5ca` R-CCRC-2 done-flip guard routing. See `## Closed since last update (2026-05-24)`.)_
| 74 | R-WSWA | B-WEDGE session `pickle-e4f1269f` (2026-05-25) killed by R-WSRC-2 graceful exit `state_schema_version_ahead`. **Root cause diagnosed 2026-05-25 02:18Z**: the R-WMW-1 worker's fix REQUIRES a schema bump (LATEST_SCHEMA_VERSION 4→5 + new `worker_artifact_progress` state field + new event). Worker recompiled (`extension/services/state-manager.js` shows new normalizeV5StateDefaults), wrote a v5 state.json, but the running mux-runner (older compiled binary loaded at process start) read it and tripped R-WSRC-2. **Design gap**: schema-version-bump bundles cannot self-deploy mid-run — guard fires before the new code takes effect. Working tree preserved: 9 files modified, 5 test:fast regressions follow (same EVENT_NAMES + VALID_ACTIVITY_EVENTS drift class as R-MEGA-SELF-FIX). Operator-required: (a) fix test drift on the salvaged tree, (b) commit + install.sh + restart mux-runner BEFORE testing — fresh runner has v5 schema. Sized: ~3 tickets (test fixes + restart docs + R-WSWA event payload enrichment per original AC). |
| 75 | R-PTSB | Phantom teams-base "default-off" sessions recur (3 occurrences today: `1fa2d19e`, `4341c0f9`, `20a4c0fa`). Created during B-FRA / B-APWS / B-WEDGE runs. `original_prompt: "default-off"` or `"teams-base"` / `"effort-medium-test"` + `tmux_mode: false` + `iteration: 0` + `history: []`. Block `install.sh` until manually cancelled. Hypothesis: teams-mode worker subagent initialization writes a placeholder session via `setup.js` without then spawning tmux. Sized: ~2 tickets (root-cause + auto-cleanup heuristic). |

### P2

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 27 | R-MMRT | Monitor respawn uses temp-dir/empty sessionDir then 4-pane window collapse — observability gap (not pipeline-blocking) | `p2-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md`. **B-MONITOR. (Demoted P1→P2 2026-05-23: cosmetic + observability impact only; workaround = manual respawn.)** |
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-QSRC / B-WEDGE.** |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker, no artifact progress | `p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`. **B-WEDGE.** |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | R-WTB-1..4; B2-RSU residual. **B-QSRC. (Promoted P3→P2 2026-05-23: blocks R-PTG worker lifecycle; tier_cap_override workaround needed each session.)** |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check | PRD not drafted (~4 tickets). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4 tickets). **B-GATE.** |

### P3

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 5 | — | Subsystem CLAUDE.md drift; audit 5 subsystems under `extension/src/` | **PARTIAL** — `hooks/` and `lib/` now report **OK** under `scripts/audit-subsystem-claude-md.sh` (`1add4451`); `types/` cleared STALE; `bin/` (51 files) and `services/` (32 files) remain INCOMPLETE — per-export documentation, ongoing. |
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. **(Demoted P2→P3 2026-05-23: UX friction; operator can pass `--scope` explicitly.)** |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR.** |
| 32 | R-TFP | `test:fast` + `test:integration` parallel-load flakes | `p2-test-fast-stability-gate-widening-2026-05-19.md`. v1.76.0 serialized the subprocess-heavy tail via `.serial-tests.json` and retiered `council-publish` / `mux-runner.output-stall` / `check-update` fast→integration — gate verified green. B-FLAKE SHIPPED; watch item only. |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3 tickets). |

### Closed since last update (2026-05-22)
- #58-#63 — **B-BABYSIT-FIX** (`bf89a1a3`) + **R-CCR** review-hardening (`e448b714`), v1.76.0.
- #64 R-RHFP — readiness `performance` findings demoted to advisory; telemetry-event literals skipped (`a0604987`).
- #65 R-RCEX — `resolveSymbolRef` resolves external SDK symbols against `node_modules/*.d.ts` (`8cb5ba79`).
- #50 R-SRGT — `computeOneHop` empty-seed short-circuit + 60s wall cap; per-grep 30s→5s (`6f71dd6a`).
- #57 R-RPRA — verified: R-RHFP PATH_RE negative lookbehind prevents leading-`/` phantom finding. R-FRA facets remain.
- #49 R-PSSS — empty-scope skips emit WARN + `*_empty_scope_skip` events; `PhaseSetupResult` + `phase_skips` (`988ed55a`,`9020c26b`). B-PIPE-LAUNCH-FRICTION fully shipped v1.77.0.
- #51 R-PPSD — verified: both pipeline skill prompts document `skip_quality_gates_reason`. No code change.
- #18 R-FGNC — `convergence-gate:buildFailures` combines stdout+stderr, strips `.npmrc` WARN; szechuan runs lint-autofix pre-commit (`48718c63`,`b5500da8`). R-FGNC-6 (R-MAY) deferred.

### Closed since last update (2026-05-23)
- #48 R-PCFG — verified: R-PIPE-2 `phase_no_progress` gate (`bd5e4466`, 14 tests) catches false "completed successfully" after non-zero exit.
- #54 R-MRFP — verified: `detectMultiRepo` dedupes by enclosing git repo root (`5501d4ed`, 8 monorepo tests).
- #53 R-SRAA — `writeScopeArchive` rotates pre-existing archive to `.bak`; `SCOPE_ARCHIVE_EXISTS` retired (`19ff0dd1`).
- #5 B-AUDIT (partial) — `hooks/`+`lib/` flipped INCOMPLETE→OK; `types/` cleared STALE; `bin/`+`services/` still INCOMPLETE (`1add4451`).
- #32 R-TFP gate-blocking — **B-FLAKE** serialized flake-tail shipped v1.76.0; retained as P3 watch item.
- **B-FRA/B-APWS bundle PRDs drafted** — `cfa38603`,`46db2c27`. Ready for dispatch in priority order.
- #52 R-WUWC — **B-WUWC-REPRODUCER CLOSED**: wuwc-reproducer.test.js confirms all 4 prevention layers green (R-WSE-1/2/3 + R-PIPE-2). Reproducer: `d9bdb589`; trap-door: `4b38893c`; closer: 26301c6a (v1.78.2). Test: `extension/tests/wuwc-reproducer.test.js`.

### Closed since last update (2026-05-24)
- #66 R-FRA — readiness gate false-positives on forward-created test/script files: **B-FRA CLOSED** (R-FRA-6 shared predicate, R-FRA-2 pre-flight script, R-FRA-3 persona Step 0, R-FRA-4 prds/CLAUDE.md). v1.79.0.
- #67 R-RTRC8 — `/pickle-refine-prd` Step 7c missing forward-ref annotation reminder: **B-FRA CLOSED** (R-FRA-1). v1.79.0.
- #70 R-CCQF — `hasCompletionCommit` now accepts unquoted-short / unquoted-full / quoted-short / quoted-full SHA via new `normalizeCompletionCommitField` helper (`e3f510fd`). 12 regression assertions in `extension/tests/has-completion-commit-quoted-form.test.js`. Trap-door pinned in `extension/CLAUDE.md`.
- #71 R-PEDC — `mux-runner.clearStaleDoneWithoutCommitEvidence` clears stale `done_without_commit_evidence` exit_reason on 4 `guard.ok===true` recovery paths (`e3f510fd`); mirrors R-CCR-3 stale-handoff pattern. 5 regression assertions in `extension/tests/exit-reason-clears-on-recovery.test.js`.
- #68 R-FRA-GATE — forward-ref annotation regex parity drift between `check-readiness` and `audit-ticket-bundle`: **B-FRA CLOSED** (R-FRA-6 unified FORWARD_REF_ANNOTATION_RE module imported by both consumers). v1.79.0.
- #69 R-FRA 5th recurrence — `B-PROJECT-AUDIT-2026-05-23` hit READINESS HALT on 34 forward-created findings: **B-FRA CLOSED**. PRD: `prds/p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md`. v1.79.0.
- #11 R-APWS — scope-allowlist enforcement regression coverage + observability test landed; preflight, event, and status-drift rendering now end-to-end-tested. Worker-simulation tests for anatomy-park (`69aaa442`) + szechuan-sauce (`45223a06`), renderScopeDrift output-contract test (`e80eaed5`), worker-prompt ordering trap-door (`2aa079c2`). **B-APWS CLOSED.** Bundle ships under v1.79.1.
- #72 R-WSRC-GR — `config-protection.ts` blocks 9 prohibited git verbs from worker subprocesses; trap-door pinned in `extension/CLAUDE.md`; Git Boundary Rules prompts augmented with runtime-enforcement note. **B-WSRC-GR CLOSED.** closer: `b60d4cfb` (v1.79.2).

Earlier closed (detail in archive): #1-#4, #6, #8-#10, #13-#17, #20-#24, #26, #31, #36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED. NEXT bundles listed in dispatch order (reordered 2026-05-24).

### P1 bundles — dispatch order

| # | Bundle | Status | Composes | Notes |
|---|---|---|---|---|
| 1 | **B-FRA** | SHIPPED | #66 + #67 + #68 + #69 | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md` (cfa38603). R-FRA-1..R-FRA-6 tickets all Done. Closes #66+#67+#68+#69. Trap doors: R-RTRC-1..7 (prior) + R-FRA-1, R-FRA-2, R-FRA-6 (new). v1.79.0. |
| 2 | **B-APWS** | SHIPPED | #11 R-APWS | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-apws-scope-allowlist-enforcement-2026-05-23.md` (46db2c27). 5 tickets R-APWS-7..11. Regression coverage + observability test. Trap doors: R-APWS-7..10 scope-preflight wiring + renderScopeDrift output contract. Every worker fired R-WSRC-GR (4x) — all self-recovered via path-scoped `git restore --source`. v1.79.1. |
| 3 | **R-MEGA-SELF-FIX** | PARTIAL | B-PIPE-FIX + B-SJET-2 + B-SSDF + launch-friction + R-CSI | `p1-self-fix-mega-campaign-2026-05-19.md`. Phase 0 done; Phase 3 shipped v1.77.0. Phase 1 (#47 judge env isolation), Phase 2 (#46 AGENTS.md firewall) — szechuan PHASE BLOCKERS. Phase 4 (#25 R-CSI forensics) DEFERRED in B-CSI. |
| 4 | **B-WUWC-REPRODUCER** | SHIPPED | #52 R-WUWC | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md` (92bed106). All 4 prevention layers confirmed green by wuwc-reproducer.test.js (`d9bdb589`). Closer: 26301c6a (v1.78.2). Auto-commit salvage (Bug 5 fix #2) still not shipped → follow-up R-WUWC-2-SALVAGE if filed. |
| 5 | **B-QSRC** | QUEUED | R-QGSK + R-RSU residuals from B2-RSU partial-ship | New bundle PRD needs scoping. Closes residue of #29/#30/#34. |
| 6 | **B-CSI** | DEFERRED | R-CSI Phase 1+2 | Await next sibling-session incident before scoping Phase 2. Operator-gated. |
| 7 | **B-CCDC** | DEFERRED | R-CCDC citadel detection-coverage successor | Per operator: maybe-later. |
| — | **R-CCR** | SHIPPED | B-BABYSIT-FIX review hardening | 16/16, 4/4 phases, `e448b714`; shipped under the v1.76.0 tag 2026-05-22. |
| — | **B-BABYSIT-FIX** | SHIPPED | findings #58-#64 | `bf89a1a3`. R-CCR hardens the review residue. |

### P2 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-GATE** | PARTIAL | R-FGNC + R-PVTA + R-VSGE | **R-FGNC (#18) shipped 2026-05-22** (`48718c63`+`b5500da8`). R-PVTA (#39) / R-VSGE (#40) still need PRDs drafted. Verify-command host-tool gaps cause silent worker failures. |
| **B-WEDGE** | QUEUED | R-RSU residuals + R-WMW | Closes #30/#33. Manager wedge on oversized ticket is visible (no data loss) but burns wall-time. |
| **B-MONITOR** | QUEUED | R-MMRT + R-MWCL residuals | Closes #27/#29. Observability gap; cosmetic + diagnostic impact. |
| **B-PNTR** | QUEUED | remove bare `/pickle` non-tmux loop | `p2-remove-non-tmux-pickle-loop.md`. Refinement recommended pre-launch. |
| **B-FLAKE** | SHIPPED | R-TFP-W | `test:fast` + `test:integration` green; flake tail serialized via `.serial-tests.json`. Shipped in v1.76.0. |
| **B-PIPE-LAUNCH-FRICTION** | SHIPPED | R-PSSS + R-SRGT + R-PPSD | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. All three findings closed 2026-05-22 (#49/#50/#51) — shipped under the **v1.77.0** tag. |

### P3 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-R-MMTR** | QUEUED | R-ICDM-2..7 + R-MMTRH heal + R-MMTR-7 closer | Closes #19/#28. |
| **B-E2E** | QUEUED | R-MMTR6S | E2E re-attempt of force-skipped R-MMTR-6. Ships after B-R-MMTR. |
| **B-LSOF** | QUEUED | R-PIWG-5 | `lsof` concurrent-git-process probe (~2-3 tickets). |
| **B-AUDIT** | PARTIAL | subsystem CLAUDE.md drift (#5) | `hooks/` + `lib/` → OK; `types/` cleared STALE; `bin/`/`services/`/`types/` still INCOMPLETE under `audit-subsystem-claude-md.sh`. Per-export documentation, ongoing. |

---

## Feature Epics — after the bug drain

Gated behind operator's drain-bug-bundles-first directive. Do not count toward open-bug ceiling.

| Epic | Priority | PRD | Scope |
|---|---|---|---|
| **R-PIAP** | P2 | `p2-proportional-intent-aware-pipeline-2026-05-21.md` | Proportional + intent-aware processing. Pillar A: tier-proportional lifecycle + auto-sizing classifier. Pillar B: anatomy/szechuan auto-detect UI-primary branches. 11 reqs. |
| **R-PGI** | P2 | `p2-pipeline-graph-intelligence-2026-05-21.md` | GitNexus embedding. Graph-preflight stage + staged consumption (direct `.gitnexus/` target, MCP fallback). 9 reqs. Feeds R-PIAP-A5 classifier. |

**Order when bug queue allows:** R-PGI first (infrastructure R-PIAP-A5 consumes), then R-PIAP.

### Deferred future epics

- **Integrations:** `hermes-integration.md` (P2 ready), `deepseek-integration.md` (P3 draft), `openrouter-multi-provider-workers.md` (P3)
- **Refactor:** `god-functions-remediation-phase-2.md` (27 carve-outs)
- **Methodology PRDs:** `portal-gun.md`, `pickle-debate.md`, `pickle-microverse.md`
- **Design docs (no ship target):** `citadel.md`, `pickle-dot-codegen-builder.md`, `council-of-ricks-catalog-mode-and-publish-fixes.md`, `plumbus-generative-audit-frames.md`, `pickle-agent-teams.md`, `smart-iteration-handoff.md`, `tool-error-retry-tracking.md`

---

## Recently Shipped

| Release | Date | Content |
|---|---|---|
| v1.79.0 | 2026-05-24 | **#66+#67+#68+#69 B-FRA CLOSED** — forward-ref annotation bundle: R-FRA-6 (shared FORWARD_REF_ANNOTATION_RE), R-FRA-2 (pre-flight audit-ticket-forward-refs.sh), R-FRA-1 (Step 7c reminder), R-FRA-3 (persona Step 0 heuristic), R-FRA-4 (prds/CLAUDE.md authoring guide). 3 new trap doors: R-FRA-1, R-FRA-2, R-FRA-6. PRD: `prds/p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md`. |
| v1.78.2 | 2026-05-23 | #52 R-WUWC **CLOSED** — B-WUWC-REPRODUCER: wuwc-reproducer.test.js confirms all 4 prevention layers (R-WSE-1/2/3 + R-PIPE-2). Reproducer (`d9bdb589`) + trap-door (`4b38893c`) + closer 26301c6a. |
| v1.78.1 | 2026-05-23 | #53 R-SRAA (`scope-resolver:writeScopeArchive` rotates to `.bak`; `SCOPE_ARCHIVE_EXISTS` retired) + #48 R-PCFG + #54 R-MRFP verified + #5 B-AUDIT partial (`hooks/`+`lib/`→OK). |
| v1.78.0 | 2026-05-22 | #18 R-FGNC — `convergence-gate:buildFailures` combines stdout+stderr, strips `.npmrc` WARN; finalize-gate summarises by check; szechuan runs lint-autofix pre-commit. Also serialized `dispatch.test.js` (R-TFP). |
| v1.77.0 | 2026-05-22 | Readiness/scope false-positive cluster + B-PIPE-LAUNCH-FRICTION. #64 R-RHFP / #65 R-RCEX / #57 R-RPRA (check-readiness), #50 R-SRGT (scope-resolver caps), #51 R-PPSD (skill docs), #49 R-PSSS (empty-scope WARN + events). |
| v1.76.0 | 2026-05-22 | Release-gate stabilization. R-CCR review-hardening (16/16). 1 real regression + 6 stale-test repairs; flake-tail serialized via `.serial-tests.json`; 3 subprocess-timeout files retiered fast→integration. |
| v1.75.0..v1.75.5 | 2026-05-16..17 | B-WSRC (#43), B-MRWG (#42), B-CTSF (#44), B-CCPM-1b (#45), B-SJET partial (#47 open), surgical sweep F1-F3+F5 (#2). |
| v1.73.0..v1.74.0 | 2026-05-09..11 | v1.73.0 11-section mega bundle (closes #11-13, #16); v1.74.0 reliability mega + R-MMTR + R-ARSF auto-resume. |

Pre-v1.73.0 + per-release v1.75.x detail in `MASTER_PLAN-archive.md` + git log.

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `prds/citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`. Clean before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per epic at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # 3+ tickets
/pickle <prd>                        # 1-2 tickets, interactive
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md`.
