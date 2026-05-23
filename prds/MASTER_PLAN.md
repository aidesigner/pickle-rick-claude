---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-23.** Three further P2/P3 findings closed today: #48 R-PCFG (verified), #54 R-MRFP (verified), #53 R-SRAA (fixed, `19ff0dd1`). Compressed 2026-05-21 — historical narrative
(mega-campaign saga, per-commit blow-by-blow, pre-2026-05-15 releases) lives in
`MASTER_PLAN-archive.md` and in git history. This file is the live ledger:
status, open findings, queue, feature epics.

## Status

| Item | Value |
|---|---|
| Source / deployed version | **v1.78.0** — 2026-05-22 |
| **v1.78.0** | **SHIPPED 2026-05-22** — #18 R-FGNC (finalize-gate `.npmrc` WARN classifier fix). Full release gate green (tsc / eslint / 6 audits / test:fast 4993 / test:integration 201 / test:expensive 9). Detail in `## Recently Shipped`. |
| Active pipeline | none |
| Latest GitHub release | v1.78.0 — 2026-05-22 |
| Codex backend | `gpt-5.4` |

**Priority directive (operator, reaffirmed 2026-05-21):** drain bug bundles
before feature epics. Feature epics do not count toward the open-bug ceiling.

**2026-05-22 session — 3 releases shipped, 8 findings closed.** v1.76.0
drained the `test:integration` flake tail and shipped R-CCR review-hardening
(epic `prds/p2-bbabysit-review-hardening-2026-05-21.md`, 16/16 tickets, 4/4
phases, commits `5a20c921..2be05865`). v1.77.0 drained the readiness/scope
false-positive cluster (#64 R-RHFP, #65 R-RCEX, #57 R-RPRA, #50 R-SRGT,
#51 R-PPSD) and shipped B-PIPE-LAUNCH-FRICTION (#49 R-PSSS) — the R-PSSS PRD
was re-scoped against the real `pipeline-runner.ts` architecture
(`anatomy-park.ts`/`szechuan-sauce.ts` never existed) then implemented
directly with full 7-touchpoint registration for two new activity events and
a `PhaseSetupResult` contract change. v1.78.0 shipped B-GATE's #18 R-FGNC —
`convergence-gate:buildFailures` combines stdout+stderr and strips pnpm
`.npmrc` `${TOKEN}` WARN noise before classification; finalize-gate
escalation summarises failures by check; szechuan worker runs lint-autofix
before commit. All three releases passed the full gate (tsc / eslint / 6
audits / test:fast / test:integration / test:expensive). Detail per release
in `## Recently Shipped`; closed-finding one-liners in
`## Closed since last update`.

---

## Open Findings

Closed-finding detail in `MASTER_PLAN-archive.md`. Each open finding: code +
one-line + PRD pointer.

### P1

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 25 | R-CSI | Concurrent claude-session destructive-command interference (3 SIGINT incidents/36h) | `p1-concurrent-claude-session-interference-with-running-pipelines.md`. Phase 1 forensics deferred per operator (await next incident). |
| 27 | R-MMRT | Monitor respawn uses temp-dir/empty sessionDir then 4-pane window collapse | `p2-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md`. **B-MONITOR.** |
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse | R-ICDM-1 shipped; R-ICDM-2..7 audit. **B-R-MMTR.** |
| 46 | R-SSDF | szechuan-sauce Session Knowledge Transfer block fails on repos with worker-side firewall `AGENTS.md` | `be269e03` shipped AC-SSDF-03 (skippable transfer); remainder folded into R-MEGA-SELF-FIX. |
| 47 | R-SJET | szechuan-sauce LLM judge baseline-measurement deterministically ETIMEDOUTs | `p1-szechuan-sauce-judge-etimedout-baseline-measurement.md`. R-SJET-1 landed (`53d79a23`); R-SJET-3/4/6 folded into R-MEGA-SELF-FIX. |

### P2

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 11 | R-APWS | anatomy-park worker edits bypass `scope.json:allowed_paths` at fix time | `p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`. |
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. |
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-QSRC / B-WEDGE.** |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker, no artifact progress | `p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`. **B-WEDGE.** |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check | PRD not drafted (~4 tickets). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4 tickets). **B-GATE.** |
| 52 | R-WUWC | worker writes on-spec code but `markTicketDone` blocked then ticket wedges Failed, output lost | `BUG-REPORT-2026-05-18-pipeline-launch-friction.md` Addendum 5. B-PIPE-FIX hardening (R-PIPE-2/3/4 + R-WSE-2/3 observability) shipped; awaiting a fresh post-v1.78.0 reproducer to confirm prevention. |

### P3

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 5 | — | Subsystem CLAUDE.md drift; audit 5 subsystems under `extension/src/` | **PARTIAL** — `hooks/` and `lib/` now report **OK** under `scripts/audit-subsystem-claude-md.sh` (`1add4451`); `types/` cleared STALE; `bin/` (51 files) and `services/` (32 files) remain INCOMPLETE — per-export documentation, ongoing. |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR.** |
| 32 | R-TFP | `test:fast` + `test:integration` parallel-load flakes | `p2-test-fast-stability-gate-widening-2026-05-19.md`. v1.76.0 serialized the subprocess-heavy tail via `.serial-tests.json` and retiered `council-publish` / `mux-runner.output-stall` / `check-update` fast→integration — gate verified green. B-FLAKE SHIPPED; watch item only. |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | R-WTB-1..4; B2-RSU residual. **B-QSRC.** |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3 tickets). |

### Closed since last update (2026-05-22)
#58-#63 — **B-BABYSIT-FIX** (`bf89a1a3`) + **R-CCR** review-hardening (`e448b714`) — shipped under the **v1.76.0** tag 2026-05-22.
#64 R-RHFP — `check-readiness` `performance` wall-budget findings demoted to advisory + telemetry-event-name literals skipped (`a0604987`). Path-strip / correction-note facets already shipped earlier.
#65 R-RCEX — `check-readiness` `resolveSymbolRef` now resolves external SDK symbols against declared-dependency `node_modules` `.d.ts` files (`8cb5ba79`).
#50 R-SRGT — `scope-resolver` `computeOneHop` empty-seed short-circuit + aggregate wall-clock cap; per-grep timeout 30s→5s (`6f71dd6a`).
#57 R-RPRA — verified already fixed: the R-RHFP PATH_RE negative lookbehind `(?<![\w./@-])` refuses to start a match after `/`, so an absolute path outside TARGET extracts nothing — no leading-`/`-stripped phantom `file_path` finding. Regression test added. The R-FRA facets (Files-to-modify forward-create, prose-hedged ellipsis paths) from the same bug report remain under R-FRA.
#49 R-PSSS — anatomy-park / szechuan-sauce empty-scope skips are now operator-visible: structured WARN + `anatomy_park_empty_scope_skip` / `szechuan_sauce_empty_scope_skip` activity events; phase-setup returns `PhaseSetupResult` and `pipeline-status.json` records per-phase `phase_skips` dispositions (`988ed55a`, `9020c26b`). B-PIPE-LAUNCH-FRICTION fully shipped under v1.77.0.
#51 R-PPSD — verified already satisfied: both `pickle-pipeline.md` and `pickle-tmux.md` document the unified `skip_quality_gates_reason` flag with legacy flags labelled. No code change needed.
#18 R-FGNC — `convergence-gate` `buildFailures` no longer lets pnpm `.npmrc` `${TOKEN}` WARN noise mask real TS/lint failures: combines stdout+stderr, strips the WARN before classification, exit code is the pass/fail signal; finalize-gate escalation summarises failures by check; szechuan worker runs lint-autofix before commit (`48718c63`, `b5500da8`). R-FGNC-6 (setup token preflight, R-MAY) deferred.

### Closed since last update (2026-05-23)
#48 R-PCFG — verified shipped: R-PIPE-2 `phase_no_progress` exit_reason gate (`bd5e4466`, 14 tests passing) catches the false `Phase pickle completed successfully` log after a non-zero exit.
#54 R-MRFP — verified shipped: `detectMultiRepo` dedupes ticket `working_dir` values by their enclosing git repo root (`5501d4ed`, 8 tests covering monorepo-workspace cases).
#53 R-SRAA — `writeScopeArchive` now rotates a pre-existing `archive/scope.<phase>.json` to a timestamped `.bak` sibling instead of FATALing with `SCOPE_ARCHIVE_EXISTS`; pipeline relaunches no longer require manual `rm` of the archive dir (`19ff0dd1`). `SCOPE_ARCHIVE_EXISTS` retired from `ScopeErrorCode`.
#5 B-AUDIT (partial) — `hooks/` and `lib/` subsystem CLAUDE.md flipped INCOMPLETE → **OK** under `audit-subsystem-claude-md.sh`; `types/` cleared STALE; `bin/` (51 files) and `services/` (32 files) remain INCOMPLETE (`1add4451`).
#32 R-TFP gate-blocking portion — **B-FLAKE** flake-tail serialization shipped in v1.76.0; finding retained as a watch item only (see P3).
Earlier closed (detail in archive): #1-#4, #6, #8-#10, #13-#17, #20-#24, #26, #31,
#36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED.

### P1 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **R-CCR** | SHIPPED | B-BABYSIT-FIX review hardening | 16/16, 4/4 phases, `e448b714`; shipped under the v1.76.0 tag 2026-05-22. |
| **B-BABYSIT-FIX** | SHIPPED | findings #58-#64 | `bf89a1a3`. R-CCR hardens the review residue. |
| **R-MEGA-SELF-FIX** | PARTIAL | B-PIPE-FIX + B-SJET-2 + B-SSDF + launch-friction + R-CSI | `p1-self-fix-mega-campaign-2026-05-19.md`. Phase 0 (B-PIPE-FIX R-PIPE-3/4) done; **Phase 3 (B-PIPE-LAUNCH-FRICTION) shipped under v1.77.0**. Phase 1 (B-SJET-2 judge env isolation + sticky-fallback), Phase 2 (B-SSDF AGENTS.md firewall), Phase 4 (R-CSI forensics) still open. |
| **B-QSRC** | NEXT | R-QGSK + R-RSU residuals from B2-RSU partial-ship | New bundle PRD needs scoping. Closes residue of #29/#30/#34. |
| **B-CSI** | DEFERRED | R-CSI Phase 1+2 | Await next sibling-session incident before scoping Phase 2. |
| **B-CCDC** | DEFERRED | R-CCDC citadel detection-coverage successor | Per operator: maybe-later. |

### P2 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-FLAKE** | SHIPPED | R-TFP-W | `test:fast` + `test:integration` green; flake tail serialized via `.serial-tests.json`. Shipped in v1.76.0. |
| **B-PIPE-LAUNCH-FRICTION** | SHIPPED | R-PSSS + R-SRGT + R-PPSD | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. All three findings closed 2026-05-22 (#49/#50/#51) — shipped under the **v1.77.0** tag. R-PSSS implemented directly against `pipeline-runner.ts` after the PRD re-scope. |
| **B-MONITOR** | QUEUED | R-MMRT + R-MWCL residuals | Shared `pickle-utils.ts` + `monitor.ts`. Closes #27/#29. |
| **B-GATE** | PARTIAL | R-FGNC + R-PVTA + R-VSGE | **R-FGNC (#18) shipped 2026-05-22** (`48718c63`+`b5500da8`). R-PVTA (#39) / R-VSGE (#40) still need PRDs drafted. |
| **B-WEDGE** | QUEUED | R-RSU residuals + R-WMW | Only if B2's R-RSU doesn't fully close #30. Closes #30/#33. |
| **B-PNTR** | QUEUED | remove bare `/pickle` non-tmux loop | `p2-remove-non-tmux-pickle-loop.md`. Refinement recommended pre-launch. |

### P3 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-R-MMTR** | QUEUED | R-ICDM-2..7 + R-MMTRH heal + R-MMTR-7 closer | Closes #19/#28. |
| **B-E2E** | QUEUED | R-MMTR6S | E2E re-attempt of force-skipped R-MMTR-6. Ships after B-R-MMTR. |
| **B-LSOF** | QUEUED | R-PIWG-5 | `lsof` concurrent-git-process probe (~2-3 tickets). |
| **B-AUDIT** | PARTIAL | subsystem CLAUDE.md drift (#5) | `hooks/` + `lib/` → OK; `types/` cleared STALE; `bin/`/`services/`/`types/` still INCOMPLETE under `audit-subsystem-claude-md.sh`. Per-export documentation, ongoing. |

---

## Feature Epics — after the bug drain

Do not count toward the open-bug ceiling. Gated behind the operator's
priority directive (drain bug bundles first); the prior R-CCR pipeline
collision constraint cleared when that pipeline completed 2026-05-22.

| Epic | Priority | PRD | Scope |
|---|---|---|---|
| **R-PIAP** | P2 | `p2-proportional-intent-aware-pipeline-2026-05-21.md` | Proportional and intent-aware processing. Pillar A — tier-proportional lifecycle (trivial/small tickets run fewer phases, not the same phases faster; deterministic auto-sizing classifier). Pillar B — intent-aware cleanup (anatomy-park/szechuan-sauce auto-detect UI-primary branches, flag-only on branch-authored visual code). 11 reqs, machine-checkable ACs. |
| **R-PGI** | P2 | `p2-pipeline-graph-intelligence-2026-05-21.md` | GitNexus embedding. Graph-preflight stage (CLI `analyze` before refine/build/hardening, pinned auto-install, graceful degradation). Staged consumption: direct `.gitnexus/` read (target, gated on a format spike) with MCP-for-claude fallback. 9 reqs. Feeds R-PIAP's tier classifier. |

**Suggested order when the bug queue allows:** refine R-PGI first (its preflight +
graph-query layer are infrastructure R-PIAP-A5's classifier can consume), then R-PIAP.

### Deferred future epics

- `hermes-integration.md` (P2, ready) · `deepseek-integration.md` (P3, draft) ·
  `openrouter-multi-provider-workers.md` (P3)
- `god-functions-remediation-phase-2.md` — refactor epic, 27 carve-outs
- Methodology PRDs: `portal-gun.md`, `pickle-debate.md`, `pickle-microverse.md`
- Design docs (no ship target): `citadel.md`, `pickle-dot-codegen-builder.md`,
  `council-of-ricks-catalog-mode-and-publish-fixes.md`,
  `plumbus-generative-audit-frames.md`, `pickle-agent-teams.md`,
  `smart-iteration-handoff.md`, `tool-error-retry-tracking.md`

---

## Recently Shipped

| Release | Date | Content |
|---|---|---|
| v1.78.0 | 2026-05-22 | #18 R-FGNC — `convergence-gate` `buildFailures` combines stdout+stderr and strips pnpm `.npmrc` `${TOKEN}` WARN noise before failure classification (the prior `stderr \|\| stdout` dropped real TS/lint errors whenever stderr carried the WARN); exit code is the pass/fail signal; finalize-gate escalation summarises failures by check; szechuan worker runs lint-autofix before commit. Also serialized `dispatch.test.js` (R-TFP flake tail). Full gate green. |
| v1.77.0 | 2026-05-22 | Readiness/scope false-positive cluster + B-PIPE-LAUNCH-FRICTION. `check-readiness`: `performance` wall-budget findings demoted to advisory, telemetry-event literals skipped (#64 R-RHFP), external SDK symbols resolve against `node_modules/*.d.ts` (#65 R-RCEX), absolute-path no-false-finding pinned (#57 R-RPRA). `scope-resolver` `computeOneHop` empty-seed short-circuit + 60s wall cap (#50 R-SRGT). `/pickle-pipeline` skip-flag docs verified (#51 R-PPSD). anatomy-park/szechuan-sauce empty-scope skips now emit operator WARNs + `*_empty_scope_skip` activity events + `pipeline-status.json:phase_skips` dispositions (#49 R-PSSS). Full gate green. |
| v1.76.0 | 2026-05-22 | Release-gate stabilization. R-CCR review-hardening epic (16/16) shipped under this tag. 1 real regression fixed (codex-spark worker-gate fixture), 6 stale tests repaired, concurrency-flake tail serialized via `.serial-tests.json`, 3 subprocess-timeout files retiered fast→integration, 6 complexity carve-outs reviewed. Full gate green. |
| v1.75.5 | 2026-05-17 | Surgical sweep F1-F3+F5 (readiness hybrid-annotation, handoff None/N/A, explicit `completion_commit` guard, analyst-output wiring). Closes #2 hallucinated-acceptance subclass. |
| v1.75.4 | 2026-05-17 | B-SJET partial — R-SJET-5 telemetry + command-metric async. Finding #47 stays open. |
| v1.75.3 | 2026-05-17 | B-CCPM-1b — codex manager no-signal framing + signal-sender attribution + codex command guidance. Closes #45. |
| v1.75.2 | 2026-05-17 | B-CTSF — closer ownership tags + terminal closer-handoff detection + runbook. Closes #44. |
| v1.75.1 | 2026-05-16 | B-MRWG — bounded between-ticket gate, kill worker-gate npm descendants, stall heartbeat. Closes #42. |
| v1.75.0 | 2026-05-16 | B-WSRC — worker source/state recursion contamination; StateManager schema-ceiling + hooks + scanners. Closes #43. |
| v1.74.0 | 2026-05-11 | Reliability mega bundle + R-MMTR family + R-ARSF auto-resume stabilization. |
| v1.73.0 | 2026-05-09 | 11-section mega bundle (codex classifier leak, judge model routing, scope preflight). Closes #11/#12/#13/#16. |

Pre-v1.73.0 in `MASTER_PLAN-archive.md`.

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
