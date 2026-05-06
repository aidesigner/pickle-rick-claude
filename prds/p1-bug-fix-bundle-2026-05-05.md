---
title: P1 — Bug-fix bundle 2026-05-05 (local-only, mega)
status: Draft
date: 2026-05-05
priority: P1
type: bug-bundle
scope: local-only  # no release intent; closer/release-gate dropped
peer_prds:
  composes:
    - prds/p1-worker-backend-split-from-manager.md
    - prds/p2-codex-spark-worker-completion-commit-contract-violation.md
    - prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md  # R-CNAR-7 addendum (slot 1g residual)
    - prds/anatomy-park-judge-unreachable-on-worker-convergence.md
    - prds/p2-remove-pipeline-wall-clock-time-cap.md
    - prds/p2-manager-stop-hook-nudge-cadence-wastes-turns.md
    - prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md
    - prds/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md
    - prds/p3-test-flakes-council-publish-and-scope-resolver.md
  shipped_already:
    - prds/p2-install-sh-types-index-stale-on-fast-reinstall.md  # slot 1q shipped 2026-05-05 in commit f6909d78 (Section C ALREADY-SHIPPED below)
  carry_forward_from:
    - prds/p1-bug-fix-bundle-2026-05-04.md  # 9 unshipped tickets folded in as Section CF
  related:
    - prds/large-pipeline-time-budget-undersized.md  # AC-LPB-07 superseded by 1t
refinement:
  cycles: 3
  workers: [requirements, codebase, risk-scope]
  notes: |
    Local-only mega bundle. Refinement should expect ~55-75 atomic tickets:
    1o..1u (skip 1q) + 9 carry-forwards from 2026-05-04. No closer ticket;
    no `gh release create`; audit-canary-flip removed from gate (commit 244b4c51).
---

# PRD — Bug-fix bundle 2026-05-05 (local-only mega)

**LAUNCH PRECONDITIONS**:
- Slot 1q shipped (commit `f6909d78`, 2026-05-05). install.sh now has force-rebuild + md5-parity probe.
- audit-canary-flip removed from gate (commit `244b4c51`). No `gh release create` in this bundle's scope.
- Working tree clean; no active sessions; mux-runner orphans cleared.

## Why one bundle

Bundle 2026-05-04 shipped 33 of 46 atomic tickets (Section A cross-backend leak class + most of B/C/D/E hardening). 9 carry-forwards remain unshipped — pickle-rick's bundle bootstrap machinery + Section H code-quality hardening. New findings 1o through 1u span overlapping subsystems and would re-traverse the same code paths if shipped separately.

- **Slots 1o + 1p + 1r/1s** are about backend hybrid mode and convergence-judge reliability — both touch worker spawn paths and convergence semantics.
- **Slot 1q** (install.sh deploy parity) shipped solo before this bundle launched. Section C in this PRD is now ALREADY-SHIPPED; refinement converts it to REGRESSION-TEST-ONLY.
- **Slots 1m + 1n** are operational/lifecycle papercuts: dirty-tree guard residuals, stop-hook orphan-shadow.
- **Slot 1d** is pre-existing test flakes — local-only goal still wants a green gate, so they land here.
- **Slot 1t** removes a wall-clock cap that almost killed run #5 of the prior bundle; quick LOC, big reliability win.
- **Section CF carry-forwards** are bundle bootstrap machinery (R-BUNDLE-1/2/DISPO-1), Section H code-quality hardening (Wire×1, Harden×2, Audit×2), and AC-TAQ-09 defective fixture. The closer ticket + R-CLOSER-1 from the prior bundle are DROPPED (local-only scope; no release).

Estimated ticket count after refinement: **55-75 atomic tickets**.

## Composition

| Section | Source PRD | Slot | Priority | Tickets (est.) | Lead requirement |
|---------|-----------|------|----------|----------------|------------------|
| **A** | `p1-worker-backend-split-from-manager.md` | 1o | P1 | 8-10 | R-WBS-1: `state.worker_backend` field + spawn-site precedence |
| **B** | `p2-codex-spark-worker-completion-commit-contract-violation.md` | 1p | P2 | 6-8 | R-CCC-2: post-commit auto-fill helper |
| **B-2** | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` (R-CNAR-7 addendum) | 1g residual | P1 | 3-4 | R-CNAR-7: cap-check guard + self-heal stale per-ticket cache when `current_ticket=null` (fixes resume-stall trap) |
| **C** | `p2-install-sh-types-index-stale-on-fast-reinstall.md` | 1q | **ALREADY-SHIPPED** | 1 (regression-only) | Shipped via `f6909d78` 2026-05-05. Refinement → REGRESSION-TEST-ONLY: assert install.sh has `INSTALL_SKIP_PARITY` + `md5_file` helper + force-rebuild block. |
| **D** | `anatomy-park-judge-unreachable-on-worker-convergence.md` | 1r+1s | P1 | 8-10 | R-AJUR-1: skip guard when metric_type='none'; R-MJU-1: judge_timeout vs stall distinction |
| **E** | `p2-remove-pipeline-wall-clock-time-cap.md` | 1t | P2 | 8-10 | R-NTC-1: stop writing default; R-NTC-2: state-field invariant flip |
| **F** | `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` | 1u | P2 | 5-6 | R-MSCN-1: WAIT_PATTERN_REGEXES; R-MSCN-2: idle-backoff state machine |
| **G** | `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` | 1n | P2 | 4-5 | R-SHB-1: stop-hook tmux_mode default-fallthrough fix |
| **H** | `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` | 1m | P3 | 4-5 | R-PDT-1: dirty-allowed list; R-PDT-2: stable verify-recapture digest |
| **I** | `p3-test-flakes-council-publish-and-scope-resolver.md` | 1d | P3 | 3-4 | flake-stabilization on the two failing tests |
| **J** | Bundle thesis matrix update | — | — | 1 | bundle thesis matrix entry only (no closer; local-only) |
| **CF** | Carry-forwards from bundle 2026-05-04 (see Section CF below) | — | mixed | 9 | AC-TAQ-09 + R-BUNDLE-1/2/DISPO-1 + 5 Section H hardening tickets |

**Total estimate: 56-72 atomic tickets** (refinement may merge or split).

## Section CF — Carry-forwards from bundle 2026-05-04

These 9 tickets were Todo at v1.70.0 close. They land in this bundle. The closer ticket and R-CLOSER-1 from the prior bundle are **DROPPED** — local-only scope; no `gh release create` in this bundle.

| Ticket | Source | Priority | Size | Notes |
|--------|--------|----------|------|-------|
| **AC-TAQ-09** | 2026-05-04 / order 470 | Medium | small | Defective + clean fixture sessions in `extension/tests/fixtures/audit-ticket-bundle/`. 8 fixtures, one per defect class. Fixture dir already exists with one expected.json — needs the rest. |
| **R-BUNDLE-1** | 2026-05-04 / order 660 | High | small | `state.flags.bundle_bootstrap_mode` flag with hardcoded session-hash allowlist. Auto-applies BOTH `skip_readiness_reason` + `skip_ticket_audit_reason`. Activity event `bundle_bootstrap_exemption_applied`. **Unshipped — no implementation found in `extension/src/` for `bundle_bootstrap_mode`.** |
| **R-BUNDLE-2** | 2026-05-04 / order 670 | High | small | Snapshot `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` to `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/`. **Partial — fixture dir exists with sub-dirs `aa001122/`, `bb112233/`, `cc223344/`; refinement should validate completeness against R-XBL-6 + R-TAQ-6 ACs.** |
| **R-BUNDLE-DISPO-1** | 2026-05-04 / order 680 | High | small | Disposition table JSON at `extension/src/data/bundle-disposition-2026-05-04.json` (52 IMPL + 1 DROP + 1 RTO entries). Read by refinement-team analyst prompts (R-TAQ-1, R-XBL-9) and audit-ticket-bundle (R-TAQ-2). **Unshipped — file is missing.** |
| **CF-WIRE** (was order 700) | 2026-05-04 / order 700 | High | large | Wire: integrate bundle subsystems (auto-resume + smoke-gate + audit + bootstrap-mode + watchdog) into a coherent end-to-end path. |
| **CF-HARDEN-CODE** (was order 710) | 2026-05-04 / order 710 | High | large | Harden: code-quality review of bundle subsystems. |
| **CF-AUDIT-DATAFLOW** (was order 720) | 2026-05-04 / order 720 | High | large | Audit: data-flow integrity for bundle subsystems. |
| **CF-HARDEN-TESTS** (was order 730) | 2026-05-04 / order 730 | High | large | Harden: test-quality review of bundle subsystems. |
| **CF-AUDIT-XREF** (was order 740) | 2026-05-04 / order 740 | High | large | Audit: cross-reference consistency for bundle subsystems. |

**Dropped from carry-forward** (local-only scope):
- ~~R-CLOSER-1~~ (closer-release-gate.sh script for `gh release create`) — no release intent in this bundle
- ~~Closer ticket~~ (bump v1.70.0 → v1.71.0 + push 74+ commits + tag) — out of scope

If a future release is desired, R-CLOSER-1 and Closer can be filed as a standalone P1 release-gate PRD; not part of this local-only mega bundle.

## Composition rationale (Risk Register)

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **R1 — Slot 1q must land first** | ~~High~~ **MITIGATED** | Slot 1q shipped solo via `f6909d78` 2026-05-05 BEFORE this bundle launches. install.sh now has force-rebuild + md5-parity probe; activity events guaranteed live. Section C is REGRESSION-TEST-ONLY in this bundle. |
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

1. ~~**Section C MUST come first.**~~ N/A — slot 1q shipped solo via `f6909d78`; Section C is REGRESSION-TEST-ONLY.
2. **Section CF R-BUNDLE-DISPO-1 MUST come first.** The disposition-table JSON is read by refinement analyst prompts on Cycles 2 and 3 — must exist before any refinement of this bundle's tickets.
3. **Section A before Section B.** R-WBS-1 (worker_backend field) enables R-CCC-* worker-side mitigations to be applied without affecting manager.
4. **Section D + Section E independent.** No ordering between judge-unreachable fix and wall-clock cap removal.
5. **Section F (stop-hook nudge cadence) + Section G (stop-hook orphan-shadow) — sister Sections, both touch `stop-hook.ts`.** Land Section F before Section G to avoid merge conflicts in the same handler. Both are P2.
6. **Section H (dirty-tree-guard) independent of all others.**
7. **Section CF Wire/Harden/Audit run LAST** (orders 700-740 from prior bundle). They do code-quality + cross-reference + dataflow validation across ALL preceding sections — must run after the implementation tickets land.
8. **No closer ticket.** Local-only bundle; no `gh release create`. Final commit on `main` is the last Section CF ticket; operator decides whether to push and release later.

## Refinement directives

When `/pickle-refine-prd prds/p1-bug-fix-bundle-2026-05-05.md` runs:

- **Cycle 1 (requirements)**: validate AC machine-checkability of every R-* requirement above. Flag any that read like prose.
- **Cycle 2 (codebase)**: enumerate every file each section touches; flag overlaps with bundle 2026-05-04's commits since they may not yet be deployed at refinement time. Confirm R-WBS-2 spawn-site list against current `mux-runner.ts` line numbers.
- **Cycle 3 (risk-scope)**: stress-test the bundle thesis — could any section be safely DEFERRED to a v1.72.0 follow-up? (Recommendation: 1d test flakes are P3; could defer if the closer's release-gate test_floor is already met without them.)

## Acceptance Criteria

- **AC-BUNDLE-2026-05-05-01** — All 7 source PRDs (1o, 1p, 1r/1s, 1t, 1n, 1m, 1d) plus 9 carry-forwards have refined `R-*` requirements with machine-checkable ACs. Bundle's `refinement_manifest.json` produces atomic tickets matching the section table above. Slot 1q is REGRESSION-TEST-ONLY (already shipped).
- **AC-BUNDLE-2026-05-05-02** — `bundle-thesis-matrix.md` is updated with this bundle's row; per-source-PRD AC->ticket coverage is 100%.
- **AC-BUNDLE-2026-05-05-03** — Bundle ends with a clean working tree on local `main` and a green local gate (lint + tsc + audits + `npm test:fast` + `npm test:integration` — `audit-canary-flip` is no longer in the gate per commit `244b4c51`). NO `gh release create`; NO version bump; NO push. Closer ticket is explicitly absent.
- **AC-BUNDLE-2026-05-05-04** — Post-bundle audit confirms: every Section's lead trap-door entry exists in `extension/CLAUDE.md`; every new activity event (`worker_backend_resolved`, `completion_commit_auto_filled`, `completion_commit_inferred_from_git`, `time_cap_disabled_default`, `bundle_bootstrap_exemption_applied`, etc.) is registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json` and the peripheral count assertion in `tests/activity-event-payload.test.js` is updated.
- **AC-BUNDLE-2026-05-05-05** — Bundle ran end-to-end with no operator manual reset of `start_time_epoch`, no manual install.sh re-run, and no phantom-Done false reverts. (Live validation; bundle is its own integration test.)
- **AC-BUNDLE-2026-05-05-06** — All 9 Section CF carry-forwards from bundle 2026-05-04 are either Done or REGRESSION-TEST-ONLY. R-BUNDLE-DISPO-1's JSON file exists at `extension/src/data/bundle-disposition-2026-05-04.json` and is referenced by refinement analyst prompts.

## Notes & open questions

- **Filename convention**: this bundle is filed today (2026-05-05) and launches today (post slot-1q ship). Local-only — no release coupling.
- **Open question**: should slot 1t (wall-clock cap removal) ship in THIS bundle or be a standalone release? If 1t lands in this bundle, the bundle benefits from its own removed cap. Recommendation: keep in bundle; the bundle's risk profile already includes long-running runs.
- **Open question**: ~~slot 1q hotfix~~ RESOLVED — slot 1q shipped solo as `f6909d78` 2026-05-05. Section C in this PRD is REGRESSION-TEST-ONLY.
- **Pre-flight checklist** (verified at compose time 2026-05-05):
  1. ✅ `git log` shows commit `f6909d78 fix(install-parity)` shipping slot 1q solo
  2. ✅ `bash install.sh` runs cleanly with new R-ITS-2 parity probe — exercised twice at compose time, all 5 hot files md5-match
  3. ✅ `audit-canary-flip` removed from gate (`244b4c51`); `release-gate-parity` test passes 2/2
  4. ✅ `trap-door-conformance.test.js` 62/62 pass (`49e0ff84` fixed 5 grep-only ENFORCE entries)
  5. ✅ `activity-event-payload.test.js` count assertion updated to 12 events (`1949c6a4`, follow-up to slot 1q)
  6. ⚠️ Pre-existing fast-tier hang: `node --test tests/activity-event-payload.test.js` runs in 67ms standalone but DEADLOCKS under `npm run test:fast` parallel-worker pool. Slot 1q's worker hit this mid-flight; recovery via `pkill -9 -f 'node --test'` worked. Refinement should treat this as an additional finding — OR refine into a new section once root-cause is known.
  7. Working tree clean; no active sessions; orphan tmux sessions present but harmless.

**Pipeline risk on launch:** the activity-event-payload.test.js fast-tier deadlock is the highest known risk. Workers running `npm run test:fast` may hang. Mitigations:
  - Workers' targeted tests typically don't run full fast-tier (gate is per-ticket).
  - If a worker does spawn fast-tier and hangs, mux-runner's worker_timeout_seconds (1200s default) eventually kills it, but burns ~20 min per occurrence.
  - Operator-level mitigation: `pkill -9 -f 'node --test'` to free a hung worker.
  - Section CF could include a new ticket: "diagnose + fix activity-event-payload deadlock under parallel test runner" — recommend refinement Cycle 2 add this if root-cause not in scope of any other ticket.
