---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-21.** Compressed this date — historical narrative (mega-campaign
saga, per-commit blow-by-blow, pre-2026-05-15 releases) lives in
`MASTER_PLAN-archive.md` and in git history. This file is the live ledger:
status, open findings, queue, feature epics.

## Status

| Item | Value |
|---|---|
| Source / deployed version | **v1.75.5** (`extension/package.json`) |
| **v1.76.0** | **BLOCKED — release gate red.** `test:fast` green/stabilized; `test:integration` ~27 fails (~75% concurrency-flakes + ≥1 real `worker-lint-gate` regression); `test:expensive` unverified. Resume plan in `## v1.76.0 Completion`. |
| Active pipeline | `e448b714` — **R-CCR** (B-BABYSIT-FIX review hardening), pickle phase, ~10/16 tickets Done |
| Latest GitHub release | v1.69.0 — local-only mode; HEAD ~390+ commits ahead of origin |
| Codex backend | `gpt-5.4` |

**Priority directive (operator, reaffirmed 2026-05-21):** drain bug bundles
before feature epics. Feature epics do not count toward the open-bug ceiling.

**In flight — R-CCR.** Epic `prds/p2-bbabysit-review-hardening-2026-05-21.md`,
16 tickets, 3-agent review hardening of the B-BABYSIT-FIX commits (`bf89a1a3`).
Pipeline `e448b714` (pickle then citadel then anatomy-park then szechuan-sauce).
Babysat on a 30-min cron; self-healed one spurious-Failed transient. Closes the
review residue of findings #58-#64.

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
| 18 | R-FGNC | finalize-gate mistakes `.npmrc` env WARN for real failures; masks lint/TS errors | `p2-szechuan-anatomy-finalize-gate-npmrc-warn-pollution-masks-real-failures.md`. **B-GATE.** |
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-QSRC / B-WEDGE.** |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker, no artifact progress | `p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`. **B-WEDGE.** |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check | PRD not drafted (~4 tickets). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4 tickets). **B-GATE.** |
| 48 | R-PCFG | runner logs `Phase pickle completed successfully` after exit code 1 / 0 workers | Folded into B-PIPE-FIX R-PIPE-2 (`phase_no_progress` gate). |
| 49 | R-PSSS | anatomy-park / szechuan-sauce silently skip phases when scope filter excludes all subsystems | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. **B-PIPE-LAUNCH-FRICTION.** |
| 52 | R-WUWC | worker writes on-spec code but `markTicketDone` blocked then ticket wedges Failed, output lost | `BUG-REPORT-2026-05-18-pipeline-launch-friction.md` Addendum 5. Likely covered by B-PIPE-FIX. |
| 53 | R-SRAA | anatomy-park `[FATAL] refreshScope: archive already exists` on every pipeline relaunch | `BUG-REPORT-2026-05-18-pipeline-launch-friction.md` Addendum 6. NOTE finding-number collision — commit `5501d4ed` cites "#53 R-PRH"; operator to reconcile numbering. |

### P3

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 5 | — | Subsystem CLAUDE.md drift; audit 5 subsystems under `extension/src/` | No PRD; **B-AUDIT.** |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR.** |
| 32 | R-TFP | `test:fast` parallel-load flakes — substantially closed; asymptotic ~1-2-flake/4-run tail remains | `p2-test-fast-stability-gate-widening-2026-05-19.md`. Residual of B-FLAKE. |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | R-WTB-1..4; B2-RSU residual. **B-QSRC.** |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3 tickets). |
| 50 | R-SRGT | `scope-resolver` import walk loops on timing-out greps when `--scope branch` diff is empty | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. **B-PIPE-LAUNCH-FRICTION.** |
| 51 | R-PPSD | `/pickle-pipeline` skill prompt documents legacy split skip-flags only | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. R-PPSD-1 unblocked to ship independently. |
| 54 | R-MRFP | `MULTI-REPO DETECTED` false-positive on monorepos with per-ticket `working_dir:` | Closed by `5501d4ed` (pending verification). |
| 57 | R-RPRA | `check-readiness.ts` strips leading `/` from absolute paths then false-positive findings | `BUG-REPORT-2026-05-19-readiness-absolute-path-outside-target.md`. Folds into R-RPRA/R-FRA readiness-gate hardening. |
| 64 | R-RHFP | READINESS HALT false-positive surface broad (path strips, prose paths, wall-budget perf timeouts) | `BUG-REPORT-2026-05-21-readiness-contract-resolver-wall-budget-false-positives.md`. Highest-value fix: demote `kind:'performance'` out of the blocking set. |
| 65 | R-RCEX | `check-readiness` flags external-package (`node_modules`) SDK symbols as unresolved `contract` findings | Same bug report as #64. One `resolveSymbolRef` change covers #64 + #65. |

### Closed since last update (2026-05-21)
#58-#64 — **B-BABYSIT-FIX** (`bf89a1a3`); R-CCR (`e448b714`) review-hardening in flight.
Earlier closed (detail in archive): #1-#4, #6, #8-#10, #13-#17, #20-#24, #26, #31,
#36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED.

### P1 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **R-CCR** | IN-FLIGHT | B-BABYSIT-FIX review hardening | Pipeline `e448b714`, 16 tickets, ~10 Done. |
| **B-BABYSIT-FIX** | SHIPPED | findings #58-#64 | `bf89a1a3`. R-CCR hardens the review residue. |
| **R-MEGA-SELF-FIX** | IN-FLIGHT | B-PIPE-FIX + B-SJET-2 + B-SSDF + launch-friction + R-CSI | `p1-self-fix-mega-campaign-2026-05-19.md`. Combined self-fix pipeline. |
| **B-QSRC** | NEXT | R-QGSK + R-RSU residuals from B2-RSU partial-ship | New bundle PRD needs scoping. Closes residue of #29/#30/#34. |
| **B-CSI** | DEFERRED | R-CSI Phase 1+2 | Await next sibling-session incident before scoping Phase 2. |
| **B-CCDC** | DEFERRED | R-CCDC citadel detection-coverage successor | Per operator: maybe-later. |

### P2 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-FLAKE** | RELEASE-GATE IN FLIGHT | R-TFP-W | `test:fast` stabilized; v1.76.0 untagged — see `## v1.76.0 Completion`. |
| **B-PIPE-LAUNCH-FRICTION** | QUEUED | R-PSSS + R-SRGT + R-PPSD | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. Closes #49/#50/#51. |
| **B-MONITOR** | QUEUED | R-MMRT + R-MWCL residuals | Shared `pickle-utils.ts` + `monitor.ts`. Closes #27/#29. |
| **B-GATE** | QUEUED | R-FGNC + R-PVTA + R-VSGE | R-PVTA/R-VSGE need PRDs drafted. Closes #18/#39/#40. |
| **B-WEDGE** | QUEUED | R-RSU residuals + R-WMW | Only if B2's R-RSU doesn't fully close #30. Closes #30/#33. |
| **B-PNTR** | QUEUED | remove bare `/pickle` non-tmux loop | `p2-remove-non-tmux-pickle-loop.md`. Refinement recommended pre-launch. |

### P3 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-R-MMTR** | QUEUED | R-ICDM-2..7 + R-MMTRH heal + R-MMTR-7 closer | Closes #19/#28. |
| **B-E2E** | QUEUED | R-MMTR6S | E2E re-attempt of force-skipped R-MMTR-6. Ships after B-R-MMTR. |
| **B-LSOF** | QUEUED | R-PIWG-5 | `lsof` concurrent-git-process probe (~2-3 tickets). |
| **B-AUDIT** | QUEUED | subsystem CLAUDE.md drift (#5) | No PRD; ad-hoc audit. |

---

## Feature Epics — after the bug drain

Do not count toward the open-bug ceiling. **Not to be refined/built until the
`e448b714` pipeline finishes** (same repo — concurrent epics collide).

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

## v1.76.0 Completion (release BLOCKED)

`test:fast` stabilized + green. `test:integration` RED. `test:expensive`
unverified. Release-gate fix commits are on `main`, **local only — unpushed, no tag**.

1. **Triage ~27 `test:integration` failures**: `cd extension && npm run test:integration 2>&1 | grep '^x'`; run each failing file in isolation — flake (passes alone) vs real (fails alone).
2. **Fix real regression(s)** — start with `worker-lint-gate.test.js` (`0 !== 1` at :144) + `worker-lint-gate-forensic`.
3. **Stabilize concurrency-flakes** — load-robust budgets / deterministic barriers / fixture isolation; edits confined to `extension/tests/`, no `t.skip()`.
4. **Run `test:expensive`** (`RUN_EXPENSIVE_TESTS=1 npm run test:expensive`, 30-min soak); triage.
5. **Gate green** then bump `extension/package.json` 1.75.5 to 1.76.0, commit `chore: bump version to 1.76.0`, `git push origin main`, `gh release create v1.76.0`, `bash install.sh` (verify md5 parity, top-5 compiled files).
6. **Cleanup** — `git worktree prune`; `git branch -D worktree-agent-*`.

---

## Recently Shipped

| Release | Date | Content |
|---|---|---|
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
