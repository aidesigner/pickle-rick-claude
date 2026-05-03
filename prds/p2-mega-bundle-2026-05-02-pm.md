---
title: P2 Mega Bundle — strip + state drift + retry tracking + smart handoff + hermes + god-fn phase 2
status: Draft
date: 2026-05-02
priority: P2
backend: codex-required
type: manifest
peer_prds:
  related:
    - prds/p1-strip-excessive-defense-deploy-reversion.md           # Section A — foundational (must ship first)
    - prds/multi-repo-task-state-drift.md                            # Section B — state machine bug
    - prds/tool-error-retry-tracking.md                              # Section C — intra-session retry guard
    - prds/smart-iteration-handoff.md                                # Section D — handoff intelligence
    - prds/hermes-integration.md                                     # Section E — fourth backend
    - prds/god-functions-remediation-phase-2.md                      # Section F — eslint-disable carve-out cleanup
---

# PRD — P2 Mega Bundle: post-deploy-reversion strip + 5 follow-on epics

This is a long-pipeline mega bundle composing 6 source PRDs into a single autonomous codex run. Section A lands first (it strips dead code from the v1.68.0 release procedure) so the rest of the bundle ships against a clean tree.

## Composition

| Section | Source PRD | Type | Estimated tickets | Estimated LOC | Notes |
|---|---|---|---|---|---|
| **A** | `prds/p1-strip-excessive-defense-deploy-reversion.md` | strip | 3-5 | ~480 removed | Surgical delete; no pipeline-runner work |
| **B** | `prds/multi-repo-task-state-drift.md` | bug | 6-8 | ~250 | Refactor `mux-runner.ts:549-558` auto-mark-done; add ticket-completion validation |
| **C** | `prds/tool-error-retry-tracking.md` | bug | 4-6 | ~150 | New PostToolUseFailure hook + `last-tool-error.json` per session |
| **D** | `prds/smart-iteration-handoff.md` | perf | 8-12 | ~400 | Stall recovery taxonomy, ticket sizing, cross-iteration knowledge handoff |
| **E** | `prds/hermes-integration.md` | feature | 12-15 | ~600 | Fourth backend `'hermes'`; spawn-pattern parity with claude/codex |
| **F** | `prds/god-functions-remediation-phase-2.md` | refactor | 15-20 | ~3000 | Remove 27 carve-outs by remediating each god-fn |
| Wiring + closer | (this bundle) | infra | 1 + 1 | ~80 | End-to-end integration test + v1.69.0 closer |
| Hardening | HT-1..HT-4 | review | 4 | ~200 | Code quality, data flow, test quality, cross-reference |

**Bundle total** (rough): ~50–70 atomic tickets, ~5,000 LOC churn (mostly deletions in A and refactor in F). Target version: **v1.69.0**.

## Sequencing (refinement-locked)

1. **Section A first (strip)** — drops the cron sampler / scheduled-soak / mux-runner pre-flight from v1.68.0's planned shape so the rest of the pipeline doesn't ship code paths the strip is removing. Atomic deletes; no behavior changes for keep-list functionality.
2. **Section B (state drift)** — fixes the auto-mark-done bug in mux-runner that bites multi-repo flows. Independent of A but lands second so the subsequent refactor sections work against a correct state machine.
3. **Section C (retry tracking)** — new hook + state file. Independent.
4. **Section D (smart handoff)** — extends mux-runner / microverse-runner stall recovery and adds cross-iteration knowledge channel. Stacks on B's correct state machine.
5. **Section E (hermes)** — new backend wiring. Standalone; lands after D so the new backend gets the smarter handoff for free.
6. **Section F (god-fn phase 2)** — remediates 27 functions. Lands last because eslint changes cascade.
7. **Wiring** — end-to-end test exercising A+B+C+D+E+F together.
8. **Hardening** — HT-1..HT-4 review the entire diff.
9. **Closer** — bump 1.67.0 → 1.69.0 (skip 1.68.0 if strip is part of this bundle, OR ship 1.68.0 first then 1.69.0). Operator choice: **single closer to 1.69.0** is simpler.

## Bundle-level Acceptance Criteria

| ID | Phase | Verifier | Check |
|---|---|---|---|
| AC-MEGA-A | bundle-end | strip PRD ACs | All 12 AC-STRIP-NN from `prds/p1-strip-excessive-defense-deploy-reversion.md` pass |
| AC-MEGA-B | bundle-end | source PRD verifiers | `multi-repo-task-state-drift.md` ACs all green |
| AC-MEGA-C | bundle-end | source PRD verifiers | `tool-error-retry-tracking.md` ACs all green |
| AC-MEGA-D | bundle-end | source PRD verifiers | `smart-iteration-handoff.md` target metric ≥30% wasted-iter reduction in microverse / ≥20% in tmux |
| AC-MEGA-E | bundle-end | source PRD verifiers | `hermes-integration.md` 12 FRs + 5 NFRs + ~20 new tests green |
| AC-MEGA-F | bundle-end | source PRD verifiers | `god-functions-remediation-phase-2.md` ACs green; zero carve-outs remain |
| AC-MEGA-INTEGRATE | bundle-end | wiring ticket | Full lint+test+build gate green; integration test exercises A→F together |
| AC-MEGA-CLOSER | bundle-end | closer ticket | v1.69.0 tagged + published + deployed; CHANGELOG records all 6 sections |

## Pre-flight (operator workaround)

The deploy-reversion bug may still bite during this run (cron sampler from P0 bundle was stripped if Section A ran successfully; otherwise v1.68.0's force-write kill-switch from A.14 should suppress most reversions). Operator should run before launch:

```bash
SRC_V=$(jq -r .version /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/package.json)
DEP_V=$(jq -r .version $HOME/.claude/pickle-rick/extension/package.json)
[ "$SRC_V" = "$DEP_V" ] || bash install.sh
```

A 1-hour cron babysit is recommended for long pipelines; kill it via `CronDelete` once the closer reaches `success`.

## Cross-references

- Bundle session of the predecessor (P0 deploy-reversion): `~/.local/share/pickle-rick/sessions/2026-05-02-ad240987/`
- Codebase analyst Cycle 3 verdict: `${SESSION_ROOT}/refinement/analysis_codebase.md` ("AC-DR-04c is the only AC that prevents the bug from recurring")
- Source PRDs (above table) carry the canonical ACs.

— Pickle Rick out. *belch*
