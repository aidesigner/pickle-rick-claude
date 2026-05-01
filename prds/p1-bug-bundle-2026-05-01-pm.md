---
title: P1 Bug Bundle — anatomy-park crash, szechuan judge model, pipeline-state-desync tail
status: Draft
date: 2026-05-01
priority: P1
backend: codex-required
type: manifest
---

# PRD — P1 Bug Bundle (2026-05-01 PM)

Manifest PRD composing three open P1s into a single `/pickle-pipeline --backend codex` run. The three source PRDs each describe a bug that has been observed live; this bundle ships them together because they cluster on the post-pickle pipeline phases (anatomy-park + szechuan-sauce + pane/state observability) and benefit from being verified by a single end-to-end pipeline run.

## Source PRDs (authoritative)

Read each source PRD at execution time. Atomic tickets, ACs, and risk tables stay there; this manifest only orders execution and resolves cross-PRD dependencies.

| Section | Source PRD | Tickets | Estimated LOC |
|---|---|---|---|
| **A** | `prds/anatomy-park-runner-undefined-description-crash.md` | AC-APRC-01..06 (5 mandatory + 1 optional) | ~150-250 |
| **B** | `prds/szechuan-sauce-codex-judge-model-mismatch.md` | AC-SCJM-01..06 (5 mandatory + 1 optional) | ~200-300 |
| **C** | `prds/pipeline-state-desync-and-pane-respawn-tmpdir.md` (tail) | PSD-T6..T10 (5 remaining; T0..T5 SHIPPED v1.66.0) | ~250 |

**Bundle total**: ~16 atomic tickets, ~600-800 LOC.

## Why bundle these

All three are P1, all three are in flight at the post-pickle pipeline phases (anatomy-park / szechuan-sauce / state observability), and shipping them as one bundle:

1. Lets a single `/pickle-pipeline` run validate all three end-to-end (the in-flight `anatomy-park` + `szechuan-sauce` phases will exercise the fixes for A and B; the bundle end-to-end exercises C).
2. Avoids three separate pipeline runs each costing ~90 minutes.
3. Keeps related observability + correctness fixes together in one release (likely v1.67.0).

## Sequencing (refinement-locked)

1. **Section C first (PSD-T6..T10)** — finishes the test-fixture migration that v1.66.0's `npm test` env-var workaround currently papers over. Closes the foundation before A and B add new test fixtures.
   - PSD-T6 (test-fixture migration), PSD-T7 (ESLint rule), PSD-T8 (integration test), PSD-T9 (trap-door catalog), PSD-T10 (closer — only fires at very end of bundle).
2. **Section A (AC-APRC-01..05)** — guards `mvState.key_metric.description` access; lets anatomy-park reach iter 3+ on PRDs that aren't microverse-shaped. Without A, every subsequent anatomy-park run on this codebase or `loanlight-api` is at risk.
3. **Section B (AC-SCJM-01..05)** — routes the judge through claude unconditionally; hardens convergence against false-converge on `metric_measurement_failed`. Without B, every `--backend codex` szechuan run on a ChatGPT-account-authed codex CLI silently fakes convergence.
4. **Optional T6 in each section** — A's AC-APRC-06 (graceful degrade for anatomy-park failures) and B's AC-SCJM-06 (pipeline-runner skip-finalize-gate on judge_unreachable) are decision-required tasks. Refinement should down-prioritize unless explicit user approval.

## Acceptance Gates (bundle-level)

| ID | Phase | Check |
|---|---|---|
| **AC-BB-01** | bundle-end | All Section A mandatory ACs (AC-APRC-01..05) pass per source PRD |
| **AC-BB-02** | bundle-end | All Section B mandatory ACs (AC-SCJM-01..05) pass per source PRD |
| **AC-BB-03** | bundle-end | All Section C tickets (PSD-T6..T10) shipped per source PRD; `npm test` script no longer requires `PICKLE_TEST_ALLOW_MISSING_EXTENSION_SENTINEL=1` because tests opt in individually (PSD-T6 closes that workaround) |
| **AC-BB-04** | per-phase | Anatomy-park phase of THIS pipeline run reaches Phase 4/4 szechuan-sauce — i.e. the bundle's anatomy-park run validates A's fix on its own diff |
| **AC-BB-05** | per-phase | Szechuan-sauce phase of THIS pipeline run produces a non-empty `convergence.history` with at least one judge-scored iteration (validates B's fix on its own diff) |
| **AC-BB-06** | bundle-end | Single closer commit bumps version 1.66.0 → 1.67.0; release gate (`tsc --noEmit && eslint && tsc && npm test`) passes |
| **AC-BB-07** | bundle-end | Trap-door catalog at `extension/CLAUDE.md` gains the new INVARIANTs from each source PRD (PSD-T9, AC-APRC-05, AC-SCJM-05) without exceeding the 1500-char limit per entry (AC-BUNDLE-17 from citadel) |

## Cross-cutting risks

| ID | Risk | Mitigation |
|---|---|---|
| **BR-1** | Section A and B both touch `microverse-runner.ts`; merge conflicts during decomposition | Refinement assigns one set of file lines per ticket. Document the file-line range each ticket touches in the refinement_manifest. |
| **BR-2** | Section C's PSD-T6 fixture migration intersects test files that A/B's new tests will create | T6 closes BEFORE A/B's new tests are authored. Refinement orders C completely ahead of A and B. |
| **BR-3** | Anatomy-park phase of THIS bundle run hits A's bug while running against this codebase, blocking the run | This codebase doesn't trigger A's symptom — A reproduces on `loanlight-api` (different `key_metric` shape). pickle-rick-claude session state has `key_metric: undefined` in the same way; A's guard is for the access path. Run with `--skip-anatomy` only as a fallback if the symptom recurs. |
| **BR-4** | Szechuan-sauce phase of THIS bundle run hits B's bug because we're on the same codex backend that triggered B | Yes — this run will exercise B's fix on its own diff. AC-BB-05 verifies it. If B's fix doesn't land before szechuan-sauce, the szechuan phase will silently false-converge. |
| **BR-5** | The codex judge-spawn is hardcoded model at a single site; refactoring it incorrectly could break worker spawn (which uses different routing) | AC-SCJM-01 mandates writeup of the call site BEFORE refactoring. AC-SCJM-04's integration test locks the regression. |

## Reproducers (consolidated)

- **A** — Run `/pickle-pipeline <prd>` on a non-microverse PRD; anatomy-park crashes at iter 3 on `Cannot read properties of undefined (reading 'description')`. Observed: `loanlight-api` session `2026-05-01-a78affa6`.
- **B** — Run `/szechuan-sauce --backend codex` on any repo with a ChatGPT-account-authed codex CLI; convergence reports `BestScore: 0` and `exit_reason: converged` after 2 false-stalled iterations. Observed: `loanlight-api` session `2026-05-01-330d0300`.
- **C** — pre-v1.66.0: any pipeline run shows `state.iteration=0` regardless of actual iteration count; panes 1+3 die at phase transition. Now papered over by v1.66.0; T6..T10 remove the workaround and lock the regression in tests.

## Operator workarounds (until bundle ships)

- **A**: `--skip-anatomy` flag. Loses the deep-review phase; szechuan-sauce still runs on post-pickle HEAD.
- **B**: `--backend claude` (no codex routing). Slower but the judge spawn works.
- **C**: Already mitigated by v1.66.0's `npm test` env-var workaround. No operator action needed; just don't author NEW tests that pin EXTENSION_DIR=tmpdir without using the opt-in flag.

## Rollback plan

If the pipeline run derails on Section A or B mid-flight, the closing commit (T10/closer) is held until all bundle ACs pass. Each ticket lands as its own commit so individual reverts are possible. The bundle doesn't claim convergence until AC-BB-06 release gate passes — guards against shipping a broken release.

## Cross-references

- Source PRDs (above) — canonical detail
- v1.66.0 release notes: https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.66.0
- Citadel + Hardening Bundle precedent: `prds/citadel-hardening-bundle.md` (Apr 29) — same manifest pattern for 3-source bundles

— Pickle Rick out. *belch*
