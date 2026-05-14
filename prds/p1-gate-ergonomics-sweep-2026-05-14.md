---
title: P1 — Gate-Ergonomics Sweep (R-FRA + R-QGSK + R-PPPG) for codex pipelines
status: Open
filed: 2026-05-14
priority: P1
type: bug-bundle
composes:
  - prds/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md   # R-FRA — annotation-parity between check-readiness and audit-ticket-bundle (P2)
  - prds/p3-collapse-quality-gate-skip-flags.md                          # R-QGSK — collapse skip_readiness_reason + skip_ticket_audit_reason → skip_quality_gates_reason (P3)
  - prds/pickle-pipeline-preflight-gates-ergonomics.md                   # R-PPPG — scope-resolver base-ref bug, source_prd absolute-path strip, cross-doc-naming-drift archive collision (P1)
---

# PRD: Gate-Ergonomics Sweep (R-FRA + R-QGSK + R-PPPG)

**Status**: Open, P1, filed 2026-05-14 PM. Phase 1b of the post-b54f2143 master plan. Sanctioned 3-PRD bundle under operator rule #1 — shared file surface justifies the exception.

## Why these three together

Every codex pipeline launch currently pays a stack of pre-flight gate failures that force operators to set BOTH `state.flags.skip_readiness_reason` AND `state.flags.skip_ticket_audit_reason` before pickle phase will enter. The three child PRDs touch the same gate-chain plumbing:

| Surface | R-FRA | R-QGSK | R-PPPG |
|---|---|---|---|
| `extension/src/bin/check-readiness.ts` | ✓ (annotation parser) | ✓ (skip-flag reader) | ✓ (source_prd absolute-path strip) |
| `extension/src/bin/audit-ticket-bundle.ts` | ✓ (annotation parser) | ✓ (skip-flag reader) | ✓ (cross-doc-naming-drift severity demotion) |
| `extension/src/services/scope-resolver.ts` | — | — | ✓ (base-ref default fix) |
| `extension/src/services/state-manager.ts` | — | ✓ (migration shim) | — |
| Refinement template (`spawn-refinement-team.ts`) | ✓ (forward-ref guidance) | — | ✓ (source_prd shape) |

Three of the four file surfaces are touched by ≥2 of the PRDs. Shipping them sequentially would force a three-way rebase merge dance; shipping them as one bundle lets the refinement team see the full surface and atomize cleanly.

## Compositional contract

This master PRD lifts ACs from the three child PRDs via citadel's `composes:` walker (`extension/src/services/citadel/prd-parser.ts:507-555`, cycle detection + depth limit ≤8 verified shipped per R-CCNW closure audit). The expected lifted entity count: ≥3 R-codes (R-FRA, R-QGSK, R-PPPG) plus all child ACs.

**Bundle ticket cap**: ≤8 refined tickets total across the three PRDs (operator rule #2). The refinement team must collapse where possible:
- R-FRA's `isForwardReferenceAnnotation()` extract is one ticket touching both gates.
- R-QGSK's skip-flag collapse + state-manager migration is one ticket.
- R-PPPG's three failure modes are three independent tickets (scope-resolver, source_prd path, cross-doc-naming-drift severity).
- Plus regression-test / trap-door pin tickets per the refinement team's call.

Expected: 5-7 refined tickets, well under cap.

## Acceptance — bundle-level

Beyond each child PRD's ACs:

- **AC-GES-01** (bundle): a follow-up codex pipeline launches without operator setting any skip flag — readiness + ticket-audit both pass on a properly-annotated bundle.
- **AC-GES-02** (bundle): scope-resolver `scope=branch` defaults to `origin/main` (or the actual default branch), not `origin/<current-branch>`. Verified by a synthetic 110-commit feature-branch fixture.
- **AC-GES-03** (bundle): `cross-doc-naming-drift` findings at severity `info` do NOT exit-1 ticket audit (severity threshold for fatal exit raised to `warning` minimum, OR cross-doc-naming-drift severity demoted to `info`).
- **AC-GES-04** (bundle): refinement template's `source_prd:` writes a path RELATIVE to the repo root (or path-relative to the session dir), never absolute.

## Verification

| AC | Check | Command |
|---|---|---|
| AC-GES-01 | Launch a small fixture bundle on codex; confirm zero skip flags needed | operational — next bundle after this ships |
| AC-GES-02 | Synthetic fixture: branch 110 commits ahead of main; scope-resolver returns paths from that diff against `origin/main` | `node --test extension/tests/scope-resolver-branch-base.test.js` |
| AC-GES-03 | Run audit-ticket-bundle against a bundle with cross-doc-naming-drift findings; assert exit 0 | `node --test extension/tests/audit-ticket-bundle-severity-threshold.test.js` |
| AC-GES-04 | Run refinement on a fixture PRD; assert `source_prd` field in any generated ticket frontmatter is relative | `node --test extension/tests/refinement-source-prd-relative.test.js` |

## Backend

`--backend codex` per operator token budget. Expected codex strike tax: 2-3 strikes × ~80 min operator heal (mux-runner guardrail prevents data loss; R-CCPL diagnosis runs in parallel as Phase 1a).

## Coupling with other queue items

- **R-CCPL** (DIAGNOSIS-ONLY): orthogonal. Runs in parallel as no-pipeline forensic.
- **R-CCDC** (DIAGNOSE-THEN-FIX): orthogonal. Stage 1 forensic runs in parallel.
- **R-MBSR** (refinement clustering): orthogonal. This bundle ships on the existing flat-manifest refinement path; success here is one of the data points feeding R-MBSR's blast-radius decision.

## Stakeholders

- **Author**: Gregory Dickson (Pickle Rick)
- **Implementer**: refinement team + ≤8 workers via mux-runner
- **Reviewers**: any operator who has set both skip flags on a codex launch

## References

- `prds/MASTER_PLAN.md` Phase 1b — this bundle is the queued NEXT pipeline.
- Child PRDs listed in `composes:` frontmatter above.
- b54f2143 session — primary evidence for R-FRA + R-QGSK friction.
- `2026-05-14-9d491b00` session — primary evidence for R-PPPG's three failure modes.
