---
title: P1 — Bug-fix bundle 2026-05-05 (post-v1.70.0)
status: Draft
date: 2026-05-05
priority: P1
type: bug-bundle
peer_prds:
  composes:
    - prds/p1-worker-backend-split-from-manager.md
    - prds/p2-codex-spark-worker-completion-commit-contract-violation.md
    - prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md  # R-CNAR-7 addendum (slot 1g residual)
    - prds/p2-install-sh-types-index-stale-on-fast-reinstall.md
    - prds/anatomy-park-judge-unreachable-on-worker-convergence.md
    - prds/p2-remove-pipeline-wall-clock-time-cap.md
    - prds/p2-manager-stop-hook-nudge-cadence-wastes-turns.md
    - prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md
    - prds/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md
    - prds/p3-test-flakes-council-publish-and-scope-resolver.md
  related:
    - prds/p1-bug-fix-bundle-2026-05-04.md  # the prior bundle (run #5 in flight at filing)
    - prds/large-pipeline-time-budget-undersized.md  # AC-LPB-07 superseded by 1t
refinement:
  cycles: 3
  workers: [requirements, codebase, risk-scope]
  notes: file post-v1.70.0 release; refinement should expect ~50-70 atomic tickets
---

# PRD — Bug-fix bundle 2026-05-05 (post-v1.70.0)

**LAUNCH WINDOW**: file ONLY after bundle 2026-05-04 (`p1-bug-fix-bundle-2026-05-04.md`) closes and v1.70.0 is tagged on GitHub via the closer ticket. Do NOT launch in parallel with run #5 of the prior bundle.

## Why one bundle

Bundle 2026-05-04 closes Section A's cross-backend leak class + Section B/C/D/E hardening. The residuals + new findings since the bundle filed (slots 1o through 1t) span overlapping subsystems:

- **Slots 1o + 1p + 1r/1s** are about backend hybrid mode and convergence-judge reliability — both touch worker spawn paths and convergence semantics.
- **Slot 1q** is install.sh deploy parity — required to land BEFORE this bundle's first run, else the bundle is at risk of the same activity-event drop that crippled bundle 2026-05-04 run #2.
- **Slots 1m + 1n** are operational/lifecycle papercuts: dirty-tree guard residuals, stop-hook orphan-shadow.
- **Slot 1d** is pre-existing test flakes — should land in this bundle to keep the release gate green.
- **Slot 1t** removes a wall-clock cap that almost killed run #5 of the prior bundle; quick LOC, big reliability win.

Eight separate releases would re-traverse the same code paths eight times. One bundle ships them together.

Estimated ticket count after refinement: **50-70 atomic tickets** (vs 62 in the prior bundle).

## Composition

| Section | Source PRD | Slot | Priority | Tickets (est.) | Lead requirement |
|---------|-----------|------|----------|----------------|------------------|
| **A** | `p1-worker-backend-split-from-manager.md` | 1o | P1 | 8-10 | R-WBS-1: `state.worker_backend` field + spawn-site precedence |
| **B** | `p2-codex-spark-worker-completion-commit-contract-violation.md` | 1p | P2 | 6-8 | R-CCC-2: post-commit auto-fill helper |
| **B-2** | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` (R-CNAR-7 addendum) | 1g residual | P1 | 3-4 | R-CNAR-7: cap-check guard + self-heal stale per-ticket cache when `current_ticket=null` (fixes resume-stall trap) |
| **C** | `p2-install-sh-types-index-stale-on-fast-reinstall.md` | 1q | P2 | 4-6 | R-ITS-1: force-rebuild before tsc; R-ITS-2: post-rsync md5-parity probe |
| **D** | `anatomy-park-judge-unreachable-on-worker-convergence.md` | 1r+1s | P1 | 8-10 | R-AJUR-1: skip guard when metric_type='none'; R-MJU-1: judge_timeout vs stall distinction |
| **E** | `p2-remove-pipeline-wall-clock-time-cap.md` | 1t | P2 | 8-10 | R-NTC-1: stop writing default; R-NTC-2: state-field invariant flip |
| **F** | `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` | 1u | P2 | 5-6 | R-MSCN-1: WAIT_PATTERN_REGEXES; R-MSCN-2: idle-backoff state machine |
| **G** | `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` | 1n | P2 | 4-5 | R-SHB-1: stop-hook tmux_mode default-fallthrough fix |
| **H** | `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` | 1m | P3 | 4-5 | R-PDT-1: dirty-allowed list; R-PDT-2: stable verify-recapture digest |
| **I** | `p3-test-flakes-council-publish-and-scope-resolver.md` | 1d | P3 | 3-4 | flake-stabilization on the two failing tests |
| **J** | Bundle infra (R-BUNDLE-1/2 carryforward + audit-bundle-thesis update) | — | — | 2-3 | bundle thesis matrix entry; carryforward of dispositions |
| **Closer** | R-CLOSER-2 release-gate + version bump | — | — | 1 | bump v1.71.0; `gh release create --latest` |

**Total estimate: 53-67 atomic tickets** (refinement may merge or split).

## Composition rationale (Risk Register)

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **R1 — Slot 1q must land first** | High | This bundle's first run depends on activity-event integrity. Closer of bundle 2026-05-04 already runs install.sh; if 1q is also in this bundle, the gate is doubled. Section C is the FIRST section by section-order so it lands before backend-split spawn changes. |
| **R2 — Slot 1o (worker_backend) interacts with R-XBL-3 pre-spawn assertion** | Medium | R-XBL-3 currently asserts `state.backend` matches resolved backend. With 1o, the assertion needs updating to match `worker_backend ?? backend`. Section A early ticket: update assertion + add regression test. |
| **R3 — Slot 1t (no wall-clock cap) for this very bundle** | Low | The bundle itself benefits from 1t — long bundles won't trip a wall-clock cap mid-run. But we MUST NOT regress the opt-in path; section E first ticket covers regression test. |
| **R4 — Slot 1p ACK token may pollute manager log parsing** | Medium | The `COMPLETION_COMMIT_RECORDED:` token must NOT match any existing manager log pattern. Refinement Cycle 2 codebase-analyst confirms pattern is unique. |
| **R5 — Slot 1m R-PDT-2 stable digest may regress on file-list ordering** | Low | `verify-recapture-fired` test sorts file paths before hashing. Add explicit ordering test as part of R-PDT-2. |
| **R6 — Bundle ships during operator off-hours; no live monitoring** | Low | New `worker_backend_resolved` event + parity events + `manager_idle_backoff_engaged` events provide enough forensic trail for postmortem. R-NTC-9's `time_cap_disabled_default` event also helps. |
| **R7 — Closer fails because pre-existing test flakes (1d) are not yet stable** | High | Section I lands 1d test stabilization BEFORE the closer ticket. Closer's release-gate runs full `npm test` and depends on Section I green. |
| **R8 — Section F idle-backoff regex misses some degenerate manager replies** | Medium | Cycle 2 codebase-analyst expands `WAIT_PATTERN_REGEXES` from `tmux_iteration_*.log` corpus across recent runs. R-MSCN-1 ACs assert ≥80% degenerate-reply coverage. |
| **R9 — Section F + Section G merge conflict in `stop-hook.ts`** | Medium | Both Sections touch `extension/src/hooks/handlers/stop-hook.ts`. Ordering constraint enforces F-before-G; refinement Cycle 1 confirms no overlapping line ranges. |

## Dispositions table (carry forward)

Same R-BUNDLE-DISPO-1 disposition table format from prior bundle:

| Code | Meaning |
|------|---------|
| ALREADY-SHIPPED | Existing code already satisfies; ticket converts to REGRESSION-TEST-ONLY |
| REGRESSION-TEST-ONLY | Implementation already exists; only a test asserting current behavior |
| DROP | Refinement determined the requirement is unnecessary or already covered |
| SUPERSEDED | A different requirement closes this gap; reference the superseder |
| RTO | Replaces an obsolete approach with a new one (Replace-To-Other) |

## Ordering constraints

1. **Section C MUST come first.** install.sh parity probe is upstream of every other ticket's effective-deployment.
2. **Section A before Section B.** R-WBS-1 (worker_backend field) enables R-CCC-* worker-side mitigations to be applied without affecting manager.
3. **Section I (test flakes) BEFORE closer.** Release gate runs full test suite.
4. **Section D + Section E independent.** No ordering between judge-unreachable fix and wall-clock cap removal.
5. **Section F (stop-hook nudge cadence) + Section G (stop-hook orphan-shadow) — sister Sections, both touch `stop-hook.ts`.** Land Section F before Section G to avoid merge conflicts in the same handler. Both are P2.
6. **Section H (dirty-tree-guard) independent of all others.**
7. **Closer ships v1.71.0.** Increment over bundle 2026-05-04's v1.70.0; closer runs `bash install.sh` (now with R-ITS-2 parity gate) + `npm test` + `gh release create v1.71.0 --latest`.

## Refinement directives

When `/pickle-refine-prd prds/p1-bug-fix-bundle-2026-05-05.md` runs:

- **Cycle 1 (requirements)**: validate AC machine-checkability of every R-* requirement above. Flag any that read like prose.
- **Cycle 2 (codebase)**: enumerate every file each section touches; flag overlaps with bundle 2026-05-04's commits since they may not yet be deployed at refinement time. Confirm R-WBS-2 spawn-site list against current `mux-runner.ts` line numbers.
- **Cycle 3 (risk-scope)**: stress-test the bundle thesis — could any section be safely DEFERRED to a v1.72.0 follow-up? (Recommendation: 1d test flakes are P3; could defer if the closer's release-gate test_floor is already met without them.)

## Acceptance Criteria

- **AC-BUNDLE-2026-05-05-01** — All 7 source PRDs (1o, 1p, 1q, 1r/1s, 1t, 1n, 1m, 1d) have refined `R-*` requirements with machine-checkable ACs. Bundle's `refinement_manifest.json` produces atomic tickets matching the section table above.
- **AC-BUNDLE-2026-05-05-02** — `bundle-thesis-matrix.md` is updated with this bundle's row; per-source-PRD AC->ticket coverage is 100%.
- **AC-BUNDLE-2026-05-05-03** — Closer runs full release gate (lint + tsc + audits + npm test:fast + npm test:integration + RUN_EXPENSIVE_TESTS=1 npm test:expensive), commits a clean tree, bumps to v1.71.0, and successfully tags + publishes.
- **AC-BUNDLE-2026-05-05-04** — Post-bundle audit confirms: every Section's lead trap-door entry exists in `extension/CLAUDE.md`; every new activity event (`worker_backend_resolved`, `completion_commit_auto_filled`, `completion_commit_inferred_from_git`, `install_sh_parity_check`, `time_cap_disabled_default`, etc.) is registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json`.
- **AC-BUNDLE-2026-05-05-05** — Bundle ran end-to-end with no operator manual reset of `start_time_epoch`, no manual install.sh re-run, and no phantom-Done false reverts. (Live validation; bundle is its own integration test.)

## Notes & open questions

- **Filename convention**: this bundle is filed today (2026-05-05) but launches AFTER v1.70.0 closes, which may be tomorrow or later. The filing date is the title date (consistent with bundle 2026-05-04's convention).
- **Open question**: should slot 1t (wall-clock cap removal) ship in THIS bundle or be a standalone release? If 1t lands in this bundle, the bundle benefits from its own removed cap. If standalone, it's a smaller surface area. Recommendation: keep in bundle; the bundle's risk profile already includes long-running runs.
- **Open question**: should slot 1q ship as a hotfix v1.70.1 BEFORE this bundle, since it's required for bundle integrity? Recommendation: refinement Cycle 3 to decide. If decision is hotfix-first, Section C is removed from this bundle and the bundle becomes ~46-55 tickets.
- **Pre-flight checklist** (before launching this bundle's pipeline):
  1. `git log --oneline v1.70.0..HEAD` shows zero commits (bundle 2026-05-04 fully landed)
  2. `git tag -l v1.70.0` returns the tag
  3. `gh release view v1.70.0` shows --latest = true
  4. `bash install.sh` runs cleanly with R-ITS-2 parity probe (post-1q-merge or hotfix)
  5. `node ~/.claude/pickle-rick/extension/bin/audit-worker-backends.ts` returns clean
  6. Working tree is clean per slot 1m's `bundle/ac-dr-02.json` workaround promoted to fix
  7. No active sessions older than 24h (orphans demoted per slot 1n recovery)
