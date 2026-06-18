---
title: P1 Design Deepening — B-GROUND2 — completion-authority + recovery-transition single-choke-point consolidation (R-DSAN follow-through)
status: PLAN ONLY — DO NOT IMPLEMENT until B-RESH ships (beta.15) + operator review
priority: P1
filed: 2026-06-18
r_code_prefix: R-GROUND2
backend_constraint: any
parent_thesis: prds/p1-design-simplification-and-autonomy-2026-06-13.md  # R-DSAN
peer_prds:
  related:
    - prds/p2-bug-fix-bundle-b-resh-pipeline-resume-gate-parity-hardening.md  # the point-fixes this generalizes
    - prds/BUG-REPORT-2026-06-18-pipeline-unresumable-after-partial-completion.md  # #122
    - prds/BUG-REPORT-2026-06-17-large-tier-manager-turn-builds-but-does-not-commit.md  # #121
    - prds/BUG-REPORT-2026-06-17-audit-ticket-bundle-extension-relative-path-false-fatal.md  # #120
---

# B-GROUND2 — completion-authority + recovery-transition consolidation

**PLAN ONLY.** This is the R-DSAN follow-through, authored after a 2026-06-18 reflection: the findings from the B-WPEX-AUTO build + the unresumable-pipeline report are not new bugs — they are **D1/D2 recurrences of the structural defects R-DSAN named**, because R-DSAN shipped the right primitives but did not wire them to two seams, and its build-failing enforcement spine has no proxy for them. This PRD makes the proven W4a single-choke-point + build-failing-audit pattern reach those seams, so seam N+1 inherits the behavior for free instead of becoming the next point-fix.

## Thesis — R-DSAN was right and incomplete

R-DSAN (shipped beta.3) named D1 (validation overreach), D2 (wrong-signal completion → work discard), D3 (simplification debt) and the north star: *trust ground truth, validate proportionally, never discard verified work, subtract a guard before adding an escape hatch.* It shipped the primitives — `reconcileTicketTruth`, `salvageTicket`, `routeRecoveryBeforeTerminal`, `pickle-recover` — and **one** build-failing enforcement spine, `audit-design-ground-truth.sh`. The W4a single-choke-point pattern (proven: `halt-or-recover-choke-point.test.js` green) consolidated the **halt/recovery-decision** seam.

**But three findings THIS session (all post-R-DSAN, post-beta.3) are D1/D2 recurrences:**

| Finding | Class | Mechanism | Why R-DSAN didn't catch it |
|---|---|---|---|
| #120 R-ATPR | **D1** | `audit-ticket-bundle` false-fatals extension-relative paths; first reflex was a skip-flag | gate-parity not consolidated — audit and readiness resolve paths differently; the D1 "add an escape hatch" reflex is still the default |
| #121 R-LTMC | **D2** | manager builds large ticket in-turn, completion keyed on turn-return signal not tree-truth | the W2 "ground truth at completion" generalization never reached the **finalize-terminal** seam |
| #122 R-PRESUME | **D2** | false-completion → sticky terminal → unresumable; no sanctioned un-terminalize | the W2.R0 `pickle-recover` keystone (meant to be "the one command for every recovery transition") has a **gap**: it covers resume-from-todo/salvage/reattach/reset but NOT un-terminalize |

**Ground-truth measurement (2026-06-18):** 17 `finalizeTerminalState(` call sites; `pipeline-runner.ts` has 2 with **zero** `reconcileTicketTruth` coverage, `mux-runner.ts` 13 with 7 reconcile refs (not 1:1, not enforced). `audit-design-ground-truth.sh` pins 3 proxies — **none** asserts "finalize-to-completed must check tree-truth for pending tickets." The guard that would have *prevented* #121/#122 does not exist.

**The meta-pattern is the exact one R-DSAN diagnosed and B-RESH is currently repeating:** a fix exists, the next new seam bypasses it, we point-fix the new seam. B-WPEX-AUTO added the detached-worker seam; B-RESH adds the false-completion-guard + reactivate seams. Each is correct and each is a point-fix. B-GROUND2 stops the regress by enforcing the choke point so there is nothing left to bypass.

## Design principles (the law this enforces — inherited from R-DSAN, extended)

1. **One completion authority, enforced.** Every transition to a terminal `step:'completed'` reads tree-truth (frontmatter pending-scan via `reconcileTicketTruth`) — never a turn-return signal, exit code, or inferred status. A build-failing audit proves no finalize site bypasses it.
2. **One recovery command, complete.** Every terminal↔runnable transition — including **un-terminalize** — routes through `pickle-recover`'s primitives. No operator hand-edit of `state.json` is ever the only path.
3. **Gate parity (D1).** Sibling gates (readiness ↔ ticket-audit) resolve the same reference through ONE shared resolver, so a path/symbol that passes one cannot fatal the other. Loosen-or-share, never add a per-gate skip-flag.
4. **Subtract before add.** Each workstream consolidates existing point-fixes into an enforced choke point and DELETES the bypass risk — it does not add a parallel guard.

## Workstreams (PLAN — refine into atomic tickets when greenlit)

### WS1 — Completion-authority single choke point *(D2 keystone; generalizes B-RESH W2)*
**`[B-RESH lands the false-completion guard at the EPIC/all-done seam → WS1's delta is universalization + enforcement.]`** Route ALL 17 `finalizeTerminalState({step:'completed'})` sites (current + future, both files) through one `finalizeIfTrulyComplete(session)` helper that re-scans frontmatter via `reconcileTicketTruth` and refuses `completed` when any ticket is non-`Done`/`Skipped` (excluding the legitimate `exit_reason:'limit'`/operator-cap terminals). Add a **4th proxy to `audit-design-ground-truth.sh`**: a raw `finalizeTerminalState({step:'completed'})` not routed through the helper FAILS the build. Single-choke-point `git grep` + a `completion-finalize-choke-point.test.js` lint (mirroring `halt-or-recover-choke-point.test.js`), incl. a synthetic-bypass red case.

### WS2 — Recovery-transition single command *(closes the W2.R0 gap; generalizes B-RESH W3)*
**`[B-RESH lands pickle-recover --reactivate → WS2's delta is making it the ONLY un-terminalize path + enforcement.]`** Every terminal↔runnable transition routes through `pickle-recover` primitives; `--reactivate` becomes the sanctioned un-terminalize. Audit/lint proves no `state.json` `active`/`step` un-terminalize write exists outside `pickle-recover` + the sanctioned setup/resume path. Document the full recovery-transition matrix (the 5 babysitter recipes → one command) in `extension/CLAUDE.md`.

### WS3 — Gate-parity shared resolver *(D1; generalizes B-RESH W1 + closes #120 class)*
**`[B-RESH lands the audit hallucinated-premise suffix-match → WS3's delta is a SHARED resolver, not two copies.]`** `check-readiness` and `audit-ticket-bundle` resolve a path/symbol reference through ONE shared module (extend `forward-ref-annotation.ts` / the R-RTRC-4 normalizer) so gate parity is structural, not two independently-maintained matchers that drift (the #120 root cause). Lint: no inline path-resolution regex in either consumer.

### WS4 — Recurrence dashboard wired to the classes *(D3; makes the next regress visible)*
Extend the W5c `/pickle-metrics` skip-flag dashboard to also count **finalize-refused** and **gate-parity-divergence** events, so the data — not a human's session-end reflection — surfaces the next D1/D2 seam before it becomes a P0.

## Reconciliation with B-RESH (no rework, strict sequencing)

B-RESH ships the **point-fixes** (W1 audit suffix-match, W2 false-completion guard at the EPIC seam, W3 reactivate, W4 wedge). B-GROUND2 assumes B-RESH has shipped and builds the **consolidation + enforcement on top** — it does not re-implement any B-RESH AC. Strict ordering: **B-RESH ships beta.15 FIRST**, then B-GROUND2 generalizes. Nothing here builds concurrently with B-RESH (same files).

| B-RESH point-fix (lands first) | B-GROUND2 generalization |
|---|---|
| W2 false-completion guard (EPIC seam) | WS1: universalize to all 17 sites + 4th build-failing proxy |
| W3 `pickle-recover --reactivate` | WS2: make it the ONLY un-terminalize path + lint |
| W1 audit hallucinated-premise suffix-match | WS3: shared resolver (delete the second copy) |
| W4 wedge on iteration-log mtime | — (standalone; no consolidation needed) |

## Simplification Review (subtract-before-add)
1. **Necessary?** Yes — the recurrence is measured (3 D1/D2 findings post-R-DSAN), not vibes. But scoped to a FOCUSED deepening (extend a proven pattern to 2 seams), NOT a full R-DSAN-style re-derivation.
2. **Reuse not add?** Every WS reuses a shipped primitive (`reconcileTicketTruth`, `pickle-recover`, the R-RTRC-4 normalizer, the `audit-design-ground-truth.sh` spine, the `/pickle-metrics` dashboard) + the proven W4a choke-point+lint pattern. The only net-new code is the choke-point helpers + audit proxies — which exist to DELETE bypass risk.
3. **Guards brittle complexity?** WS1/WS2 SUBTRACT the sticky-terminal + no-un-terminalize failure modes; WS3 collapses two path resolvers to one; none adds a skip-flag.
4. **Subtract?** Net removal: 17 ad-hoc finalize sites → 1 choke point; 2 path resolvers → 1; the 5 babysitter recovery recipes → 1 command; the per-gate skip-flag reflex → enforced parity.

**DO NOT IMPLEMENT.** Next action: ship B-RESH (beta.15); operator review of this plan; then `/pickle-refine-prd` into atomic tickets and drain via the standard pipeline.
