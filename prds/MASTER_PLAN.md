---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-23.** Live ledger: status, open findings, queue, feature epics. Historical narrative (mega-campaign saga, per-commit detail, pre-2026-05-15 releases) lives in `MASTER_PLAN-archive.md` and git history.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.78.1** — 2026-05-23 |
| Latest GitHub release | v1.78.1 — 2026-05-23 |
| Active pipeline | none |
| Codex backend | `gpt-5.4` |

**Priority directive (operator):** drain bug bundles before feature epics. Feature epics do not count toward the open-bug ceiling.

**Dispatch order (reprioritized 2026-05-23 by severity × recurrence × blast radius):** **B-FRA** (5x recurrence, halts creation-heavy launches) → **B-APWS** (silent scope-boundary defeat) → **R-MEGA-SELF-FIX** Phase 1/2/4 → **B-WUWC-REPRODUCER** (data-loss). Promotions/demotions explained inline in Open Findings tables.

**2026-05-22..23 — 4 releases (v1.76.0..v1.78.1), 11 findings closed; 3 P1 bundle PRDs drafted ready for dispatch:** `B-FRA` (`cfa38603`), `B-APWS` (`46db2c27`), `B-WUWC-REPRODUCER` (`92bed106`) in `prds/p1-bug-fix-bundle-b-*-2026-05-23.md`. Detail in `## Recently Shipped` + `## Closed since last update`.

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
| 47 | R-SJET | szechuan-sauce LLM judge baseline-measurement deterministically ETIMEDOUTs — DETERMINISTIC PHASE BLOCKER | `p1-szechuan-sauce-judge-etimedout-baseline-measurement.md`. R-SJET-1 landed (`53d79a23`); R-SJET-3/4/6 folded into R-MEGA-SELF-FIX. |
| 46 | R-SSDF | szechuan-sauce Session Knowledge Transfer block fails on repos with worker-side firewall `AGENTS.md` — PHASE BLOCKER on common repo type | `be269e03` shipped AC-SSDF-03 (skippable transfer); remainder folded into R-MEGA-SELF-FIX. |
| 52 | R-WUWC | worker writes on-spec code but `markTicketDone` blocked then ticket wedges Failed, output lost — DATA LOSS class | `BUG-REPORT-2026-05-18-pipeline-launch-friction.md` Addendum 5. B-PIPE-FIX hardening (R-PIPE-2/3/4 + R-WSE-2/3 observability) shipped; awaiting a fresh post-v1.78.0 reproducer to confirm prevention. |
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse — manager loop control regression | R-ICDM-1 shipped; R-ICDM-2..7 audit. **B-R-MMTR.** |
| 11 | R-APWS | anatomy-park worker edits bypass `scope.json:allowed_paths` at fix time — SILENT SCOPE BOUNDARY DEFEAT | `p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`. **(Promoted P2→P1 2026-05-23: scope isolation is a security boundary; silent bypass is unacceptable.)** |
| 66 | R-FRA | readiness gate rejects forward-created test/script files in refined tickets — root-cause PRD (5 false-positive classes, RC-1/2/3 fix paths) | `p2-refined-tickets-trip-readiness-contract-resolver.md`. **B-FRA.** |
| 67 | R-RTRC8 | `/pickle-refine-prd` Step 7c template doesn't remind authors to add R-RTRC-7 forward-ref annotations on backticked paths/symbols | `p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md`. **B-FRA.** |
| 68 | R-FRA-GATE | forward-ref annotation regex parity drift between `check-readiness` and `audit-ticket-bundle` (two skip flags needed pre-R-QGSK-2) | `p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md`. R-QGSK-2 unified flag partial; gate-side regex parity still open. **B-FRA.** |
| 69 | R-FRA | **5th recurrence (2026-05-23)** — `B-PROJECT-AUDIT-2026-05-23` session `2026-05-23-17b2f716` hit `READINESS HALT exited 2` with 34 `file_path` findings on forward-created test files; unblocked via `skip_quality_gates_reason` | `BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md`. **B-FRA. (Cluster promoted P2→P1 2026-05-23: 5x recurrence is the highest of any open finding; halts every creation-heavy pipeline launch.)** |

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
- **B-FRA/B-APWS/B-WUWC-REPRODUCER bundle PRDs drafted** — `cfa38603`,`46db2c27`,`92bed106`. Ready for dispatch in priority order.

Earlier closed (detail in archive): #1-#4, #6, #8-#10, #13-#17, #20-#24, #26, #31, #36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED. NEXT bundles listed in dispatch order (reordered 2026-05-23).

### P1 bundles — dispatch order

| # | Bundle | Status | Composes | Notes |
|---|---|---|---|---|
| 1 | **B-FRA** | NEXT | #66 + #67 + #68 + #69 | **HIGHEST RECURRENCE (5x)** — bundle PRD `p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md` (cfa38603). 5 tickets R-FRA-1..5 + optional R-FRA-6 shared predicate. Closes ticket-author + pre-flight gap; R-RTRC-1..7 trap doors already shipped. |
| 2 | **B-APWS** | NEXT | #11 R-APWS | **SECURITY BOUNDARY** — bundle PRD `p1-bug-fix-bundle-b-apws-scope-allowlist-enforcement-2026-05-23.md` (46db2c27). 5 tickets R-APWS-7..11. Regression coverage + observability test only (F1/F2/F3 infra shipped). Patch bump. |
| 3 | **R-MEGA-SELF-FIX** | PARTIAL | B-PIPE-FIX + B-SJET-2 + B-SSDF + launch-friction + R-CSI | `p1-self-fix-mega-campaign-2026-05-19.md`. Phase 0 done; Phase 3 shipped v1.77.0. Phase 1 (#47 judge env isolation), Phase 2 (#46 AGENTS.md firewall) — szechuan PHASE BLOCKERS. Phase 4 (#25 R-CSI forensics) DEFERRED in B-CSI. |
| 4 | **B-WUWC-REPRODUCER** | NEXT | #52 R-WUWC | **DATA LOSS** — bundle PRD `p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md` (92bed106). 3 tickets R-WUWC-1..3. Reproducer test; closer reports Closed-or-DEFERRED with gap list. Patch bump. Drift sweep confirmed auto-commit salvage NOT shipped → follow-up R-WUWC-2-SALVAGE. |
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
