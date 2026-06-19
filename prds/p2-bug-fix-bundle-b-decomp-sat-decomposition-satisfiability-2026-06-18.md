---
title: P2 Bug-Fix Bundle — B-DECOMP-SAT — decomposition satisfiability (R-DPMC-1/-3)
status: APPROVED
priority: P2
filed: 2026-06-18
r_code_prefix: R-DPMC
backend_constraint: any
source_bug_report: prds/BUG-REPORT-2026-06-18-decomp-nestjs-provider-module-coscope-deadlock.md
parent_thesis: prds/p1-design-simplification-and-autonomy-2026-06-13.md  # R-DSAN D1/D2 — gate-creates-a-failure-mode class
peer_prds:
  shipped:
    - prds/p1-design-ground-truth-2-completion-and-recovery-consolidation-2026-06-18.md  # B-GROUND2 — already closed R-DPMC-2 (the orchestration/graduation half)
basis: 2026-06-18 codex-backend /pickle-pipeline on loanlight-api LOA-1359 (external repo); code-confirmed from worker logs
---

# B-DECOMP-SAT — decomposition satisfiability

The **D4 "decomposition produces an unsatisfiable ticket"** class: `/pickle-refine-prd` cut a ticket
that forward-creates a NestJS provider its **same-ticket** controller consumes, but omitted the owning
`*.module.ts` from the ticket's file allowlist. Registering the provider requires editing the module's
`providers` array; the module was out of scope; the scope fence (correctly) blocked the edit → the
ticket `3829966b` was **unsatisfiable** → 9 worker respawns / iters 39–46 / 0 commits → medium-tier
circuit breaker tripped at 9/24 → 14 tickets stranded.

**Scope: R-DPMC-1 and R-DPMC-3 only.** R-DPMC-2 (breaker-terminated pickle phase must not silently
graduate to anatomy-park) **already shipped** in B-GROUND2 v2.0.0-beta.16 (WS1 — one
`finalizeIfTrulyComplete` graduation gate keyed on done+commit counts). This bundle is the
**decomposition-layer** half: stop producing the unsatisfiable ticket in the first place (R-DPMC-1),
and stop one such ticket from burning the whole breaker budget when it does slip through (R-DPMC-3).

**The fence is NOT the bug.** The per-file scope fence behaved exactly as designed — it stopped a
cross-ticket contamination. Do **NOT** loosen it. The defect is upstream, at decomposition time:
the ticket was cut without the registration site it structurally needs. This is a `R-DSAN` D1/D2
recurrence — *a correct guard exposing a missing upstream invariant* — so the honest fix is upstream
co-scoping, not a second escape hatch around the fence.

---

## Ground truth (verified 2026-06-18, this repo)

| Fact | Location | Implication for the fix |
|---|---|---|
| There is **no codified "co-location" rule** today | `spawn-refinement-team.ts` analyst prompts (`:530–596`); `.claude/commands/pickle-refine-prd.md` Step 7a checklist (`:185–200`, 7 defect classes) | The bug report's "mirror the existing schema↔`relations.ts` rule" is aspirational — that rule lives only in analyst judgment. R-DPMC-1 adds **one general coupling rule** to the existing 7-class checklist, not a new mechanism. |
| Codegraph is **default-on**, exposes `searchNodes()` / `getCallers()` / `getImpactRadius()` | `extension/src/services/codegraph-service.ts:141–222`; kill-switch `PICKLE_CODEGRAPH=off` | The graph can answer "what registers/calls an **existing** symbol" — but a **forward-created** provider is **not in the graph yet**, and the refiner does **not import** codegraph today. Graph-derivation is the right *principle* but adding the wiring is *new machinery*. See Simplification Review. |
| Scope fence emits `worker_edit_outside_scope` with `gate_payload.staged_paths_outside_scope` | `check-scope-diff.ts:170–181` | R-DPMC-3 can key its counter on this existing event + path — no new emission needed. |
| **No per-ticket scope-fence counter exists**; zero-progress counts already live in `state.worker_artifact_progress[ticketId]` | `mux-runner.ts` R-WMWA-1 (~`:5397–5440`); skip threshold `PICKLE_WMW_SKIP_K` (default 5) | R-DPMC-3 reuses the existing progress record + the existing skip threshold pattern — a sibling counter, not new state machinery. |
| `markTicketSkipped()` flips status only — does **not** persist a reason | `pickle-utils.ts:1230–1238`; Failed-tier reasons use `upsertFrontmatterField(..., 'failed_reason', ...)` | R-DPMC-3 extends `markTicketSkipped` to persist a `skipped_reason` (reuses `upsertFrontmatterField`), matching the Failed-tier precedent. |

---

## Acceptance criteria

### AC-R-DPMC-1 (P1) — registration co-location in decomposition

**Invariant:** *when a ticket forward-creates a "registerable" symbol (one that must be enrolled in a
container/registry to be usable — a NestJS `@Injectable()` provider, a Drizzle schema table needing a
`relations.ts` entry, a route handler needing a router registration) AND a **same-ticket** file
consumes it, the ticket's file allowlist MUST include the registration site.* State this as **one
general coupling rule**, not a per-framework enumeration.

**Primary intent — graph-derived (favored; tradeoff flagged):** the operator steer is to derive
co-location from the dependency graph rather than maintain a growing per-framework list. Where the
consumer and the registration container already exist at HEAD, codegraph can identify the registration
site (e.g. the `*.module.ts` that declares the consuming controller) via `searchNodes`/`getCallers`.
**Honest gaps (flagged, see Simplification Review):** (a) the new symbol is *forward-created* so it is
not in the graph — only the consumer + container are; (b) the refiner does not consume codegraph today,
so wiring it in is **new machinery during a simplification arc**; (c) generic call-graph edges may not
model framework-specific "registered-in-container" membership. Because of (a)–(c), graph-derivation is
specified as an **optional assist that surfaces candidate registration sites**, NOT the shippable floor.

**Shippable floor — general-coupling checklist rule (reuse, no new machinery):**
1. Add a **new failure-mode class** to the Step 7a decomposition checklist
   (`.claude/commands/pickle-refine-prd.md`) and the analyst prompt
   (`spawn-refinement-team.ts`): *"registration co-location — a forward-created registerable symbol
   consumed in the same ticket must co-scope its registration site (`*.module.ts` providers array /
   `relations.ts` / router)."* One general rule; NestJS-DI and schema↔`relations.ts` are **worked
   examples** of it, not separate enumerated rules.
2. The rule text appears in **both** surfaces (skill checklist + analyst prompt), verified the same way
   the forward-ref grammar is tested (a prompt-content/grep test).

**Verification (machine-checkable):**
- A test asserts the registration-coupling rule text is present in the analyst prompt section and the
  Step 7a checklist (grep/structural test, mirrors the existing forward-ref grammar tests). — Type: test
- A test asserts the Step 7a failure-mode checklist enumerates the new class. — Type: test
- (If the graph-assist is built) a test that, given a fixture where consumer + container exist at HEAD
  and the ticket forward-creates a provider, the refiner surfaces the container as a candidate
  allowlist entry. Deferred unless graph-assist ships. — Type: integration

**Out of scope for AC-1:** loosening the fence; enumerating one rule per framework; building a
provider/registry parser.

### AC-R-DPMC-3 (P2) — unsatisfiable-ticket fast-fail (behavioral subtraction)

**Invariant:** *a single deadlocked ticket must fail **one**, not stall **all**.* When a ticket records
**≥N consecutive** `worker_edit_outside_scope` blocks on the **same** out-of-scope path with **zero
commits**, mark it `Skipped` (reason `scope_fence_blocks_required_path:<path>`) and continue to the next
ticket — rather than respawning until the breaker budget is exhausted and downstream tickets are
stranded.

**Verification (machine-checkable):**
- A per-ticket consecutive-same-path scope-fence-block counter lives in
  `state.worker_artifact_progress[ticketId]` (sibling to the zero-progress count), reset on any commit
  or any block on a *different* path. — Type: integration
- After the Nth consecutive same-path block (threshold reuses/derives from `PICKLE_WMW_SKIP_K`), the
  ticket flips to `Skipped` with `skipped_reason: scope_fence_blocks_required_path:<path>` persisted to
  frontmatter (extend `markTicketSkipped` to persist a reason via `upsertFrontmatterField`). — Type: integration
- A `pickle_ticket_skipped_unsatisfiable` activity event is emitted with the path and block count;
  the pipeline advances to the next Todo ticket (no breaker-budget burn). — Type: integration
- The breaker budget is **not** consumed by a fast-failed unsatisfiable ticket (the remaining tickets
  still build). — Type: integration

**Threshold note:** reuse the existing `PICKLE_WMW_SKIP_K` skip threshold rather than introducing a new
env var, unless a distinct default is justified; if distinct, document it in `extension/CLAUDE.md`.

---

## Out of scope
- **The scope fence** (`check-scope-diff.ts`) — behaved correctly; do not loosen. Loosening reopens the
  cross-ticket-contamination class the fence exists to prevent.
- **R-DPMC-2** — already shipped in B-GROUND2 (do not re-implement the graduation gate).
- **A general framework-DI parser** — over-engineering; the general coupling rule + optional graph
  assist is sufficient.

## Simplification Review (subtract-before-add)

1. **Necessary at all?** R-DPMC-1 is the root-cause fix (no new runtime gate — it's a decomposition
   heuristic in an existing prompt/checklist). R-DPMC-3 is the only net-new runtime branch (a counter +
   a skip path) and is explicitly P2/optional. Both are necessary to close the D4 class; neither adds a
   new operator-facing flag or state-machine.
2. **Reuse not add?** YES, throughout. R-DPMC-1 extends the **existing** 7-class failure-mode checklist
   and the **existing** analyst prompt — it adds **one general rule**, deliberately NOT a per-framework
   list (that would be the "growing list of guards" anti-pattern the operator named). R-DPMC-3 reuses
   `state.worker_artifact_progress` (the existing progress record), the existing `PICKLE_WMW_SKIP_K`
   threshold, `markTicketSkipped`, and `upsertFrontmatterField` — a sibling counter + a reason string,
   no parallel mechanism.
3. **Guards existing brittle complexity?** The fence is **not** brittle here — it behaved correctly, so
   the default "loosen the false-blocking gate" move does **not** apply. The honest fix is the upstream
   invariant the fence exposed. **Tradeoff flagged:** the graph-derived path *would* add machinery
   (wire codegraph into the refiner) during a simplification arc, and has a real feasibility gap
   (forward-created symbols aren't in the graph). That is exactly why the shippable floor is the
   reuse-the-checklist rule and graph-derivation is an optional, deferred assist — favoring the
   principle without paying the machinery cost prematurely.
4. **What can this SUBTRACT?** R-DPMC-3 **subtracts a failure mode**: "one deadlocked ticket burns the
   entire breaker budget and strands all downstream work" becomes "fail-one, continue." R-DPMC-1
   **subtracts a class of unsatisfiable tickets at the source** — fewer respawn loops, fewer breaker
   trips, fewer babysitter recoveries. No flag or state-field additions for R-DPMC-1; R-DPMC-3 adds one
   counter field and reuses the existing reason-string convention.

## Cross-links
- Source: `prds/BUG-REPORT-2026-06-18-decomp-nestjs-provider-module-coscope-deadlock.md`
- R-DPMC-2 (shipped): `prds/p1-design-ground-truth-2-completion-and-recovery-consolidation-2026-06-18.md` (B-GROUND2 WS1)
- Forward-ref grammar (the test pattern R-DPMC-1's prompt-content test mirrors): `prds/CLAUDE.md` "Forward-Reference Annotation Grammar"; `extension/src/services/forward-ref-annotation.ts`
- Scope fence (correct — not the bug): `check-scope-diff.ts` + R-PIPE-4 prompt fence
- Design thesis: `feedback_pickle_rick_autonomy_north_star` (D1/D2 — a guard creating a failure mode that needs another guard); `feedback_analyze_failures_then_subtract_not_add_guards` (one mechanism, not a growing per-framework list)
