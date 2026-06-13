# Design Simplification & Autonomy — Meta-PRD (2026-06-13)

**Status:** PLAN ONLY — do not implement. Next step is `/pickle-refine-prd` into atomic tickets (or split into the bundles named below).
**Author:** Operator-requested deep review of the bug-PRD corpus + MASTER_PLAN ("we keep running into similar failures — simplify the design, remove validation that fails pipelines, make the system more autonomous").
**Scope:** PARENT thesis over the whole failure corpus. It does **not** re-derive the session-isolation slice — that is already specified in `prds/p1-fix-plan-session-isolation-and-ground-truth-2026-06-13.md` (R0–R3 + S1–S4), which this PRD adopts as **Workstream W2** below. This PRD adds the two classes that fix-plan does not cover: **validation overreach (W1)** and **simplification governance (W5)**, plus elevates **work-preservation (W3)** and **recover-don't-park (W4)** from per-incident recipes to runtime defaults.

---

## Thesis — three structural defects generate ~80% of recurring incidents

A read of ~25 bug PRDs + the Open Findings ledger shows the recurring failures are not 25 unrelated bugs. They collapse into **three structural defects**, each independently confirmed by miner counts:

| Defect | One-line shape | Confirmed evidence | The fix is to *subtract*, not add |
|---|---|---|---|
| **D1 — Validation overreach** | a gate is too strict / too literal / trusts the wrong signal and **halts legitimate work**; the "fix" is almost always a new escape hatch, never removal | **11+ distinct gate false-positive bugs**; **8 of 11 "fixed" by adding a skip-flag or annotation grammar**, only 3 by loosening/removing. Skip-flag namespace has grown to **5 names**. `check-readiness` is a catch-all that keeps *gaining* failure modes. | Loosen/remove the check; consolidate flags; make greenfield bundles pass **by construction**. |
| **D2 — Wrong-signal completion → work discard** | progress/completion keys on **commits-landed / exit-code / log-token / inferred-status** instead of **ground truth (tree passing gates + ticket frontmatter)**, so good work is parked or discarded | **6 recovery-over-sensitivity bugs + 8 worker-output-loss bugs**; **5 distinct babysitter "recover lost work" recipes**. B-ORSR thesis: *"the pipeline stops not because it can't do the work — it produced genuinely good output — but because its recovery state machine is too trigger-happy on weak evidence."* | Read ground truth at every decisive transition; salvage-before-fail everywhere; recover via ladder, not single-iteration park. |
| **D3 — Simplification debt (accretion)** | the right principles are already written down but the *removal* PRDs sit unshipped; the system reliably **adds** guards and reliably **fails to subtract** them | `R-PIAP` (proportional process) shipped, but `p1-strip-excessive-defense` (~480 LOC), `p2-remove-pipeline-wall-clock-time-cap`, `p3-collapse-quality-gate-skip-flags`, `p1-gate-ergonomics-sweep` are all **DRAFT/OPEN, unshipped**. | A governance rule + a one-time removal sweep, so accretion stops being the default. |

**Unifying principle (north star):**

> **Trust ground truth, scope decisively, validate proportionally, never discard verified work, and prefer subtracting a guard over adding an escape hatch for it.**

This is the same principle the babysitter playbook already encodes *by hand* (frontmatter authority, session-scoped kills, ff-only reattach, skip-flags for greenfield bundles). The defect is that it lives in a human's head and a memory file instead of in the runtime. Every workstream below pushes one facet of it into the system.

---

## Evidence appendix — the corpus, classified

**D1 — Validation overreach (gate false-positives that halted legitimate work).** `check-readiness` family: R-FRA (forward-created paths, **5 incidents across the epic**), R-RFCB (citation blindness — symbol auditor + readiness + ticket-audit all blind to annotations, 3 validator halts one session), R-RHFP (wall-budget exceeded because the *checker itself* timed out at 60s), R-RCEX (external-SDK symbols flagged), R-RPRA (absolute `source_prd` path outside TARGET), R-RTRC-7 (ticket-created telemetry event literals flagged). AC-shape: R-ACSG (oscillating collapse-or-justify gate burned **~9 worker quotas** rejecting properly-consolidated tickets). Dirty-tree preflight: R-GNDT (gitnexus stat-write self-dirties the tree → FATAL on every indexed-repo launch — *the recovery path re-bricked itself*), R-PFNP (nested `docs/`/`prds/` not exempted), R-SMAF (scoped `lint --fix` mutates out-of-scope files → aborts **every iteration**, no skip-flag at all). **Pattern: add strict gate → false-positive on legit work → add skip-flag/annotation → incomplete coverage → next operator hits it → repeat.**

**D2 — Wrong-signal completion + work discard.** Over-sensitivity (Class A): R-CHTS/B-ORSR (single non-progressing iteration → `closer_handoff_terminal` park, **≥6× one epic**), R-ONPD (oversized tickets that never converge; converged-plan-with-output treated identically to zero-output), R-PDUP (phantom roster dups re-build shipped work), R-CMWL (codex 60-min wall read as completion), R-CCPM (manager hallucinates a wedge and SIGTERMs healthy mux), R-WPEX (0-byte worker logs read as silent death). Work-loss (Class B): R-WCUC (no-progress keys on commits-landed → gate-passing uncommitted work discarded; **dominant codex failure, 6/8 non-trivial tickets**), R-XCOR/R-XSPA-2 (signal-shutdown exits 0 / cancel orphans a committed ticket and marks Failed), R-MWIS (silent worker exit strands 22/22-green uncommitted work), R-HUNG (re-login strands a completed worker 46 min), phantom-Done backfill (inferred completion re-backfills to a 1.9MB state.json freeze). **5 babysitter recovery recipes** exist purely to undo this: ff-only reattach · verify+commit+Done · clean+reset-to-Todo · patch-state+relaunch · kill-strays+reconcile+relaunch.

**D3 — Simplification debt (principles written, removals unshipped).** Already-articulated principles worth promoting to law: *"Scale the phase set, not the clock"* (R-PIAP, shipped v1.84.0); *"AC-DR-04c is the only AC that prevents the bug from recurring … don't add defense pre-emptively"* (p1-strip-excessive-defense, draft); *"the cap turns rate-limit recovery into pipeline death … reports as success, not failure"* (p2-remove-wall-clock, draft); *"there is no use case in which an operator wants to bypass one gate but not the other"* (p3-collapse-skip-flags, draft); *"greenfield bundles should pass gates by construction"* (p1-gate-ergonomics-sweep, open).

---

## Reconciliation with B-RRH — the design rework is *justified by* the point-fixes, not a parallel rebuild

B-RRH (`prds/p1-bug-mega-bundle-b-rrh-runtime-recovery-resilience-hardening.md`, drain row 111, ship-ready) is the **per-incident point-fix** of the same weekend. It already lands the individual seam fixes this PRD generalizes. **Nothing below re-implements a B-RRH AC** — the design bundles assume B-RRH has shipped and build the *consolidation + the genuinely-uncovered prevention* on top. This is the rationalization: the recurring meta-failure is **"a fix existed but the next new seam bypassed it"** (R-WMNP respawned in-phase forever though the ladder existed; R-CHTS-CODEX's 4 codex sites each needed separate wiring). B-RRH wires ~8 salvage seams *by hand*; the design rework's entire value is making seam **N+1** inherit the behavior for free.

| B-RRH AC (point-fix, lands first) | Design workstream that generalizes it | Delta AFTER B-RRH ships |
|---|---|---|
| **A0** event taxonomy (`pickle_incomplete`, `crashed_ticket_files_quarantined`, `ticket_ladder_exhausted`…) | W2/W3/W4 | **Reuse** the frozen events — no new taxonomy. |
| **A1** Done-guard re-reads frontmatter before charging no-progress | W4 + `reconcileTicketTruth()` | A1 *is* the frontmatter-truth read at one seam; W4 makes it the single shared read all seams call. |
| **A2** `ticket_ladder_exhausted` advances while a runnable Todo remains | W4 (recover-don't-park) | Consolidate A2 + B-ORSR ladder + the codex sites into **one** `haltOrRecover` choke point. |
| **A3** scoped source-signature (peer-session `prds/` churn ignored) | W2.R1-adjacent | Landed; W2.R1 adds *process*-scoping (kills), a different surface. |
| **A4** phase-aware progress credit (oversized false-flag) | W4 | Landed point-fix; W4 evidence-gates the decision it feeds. |
| **A5 / B1–B6 / C6a** rate-limit park, resume, ceiling, breaker immunity | — | **Fully owned by B-RRH** — out of design scope. |
| **C1/C2** pickle completion gated on all-tickets-Done + `pickle_incomplete` sentinel | **W2.R2** (frontmatter-truth advance) | **Largely landed.** Delta: extend the same predicate to the codex `EPIC_COMPLETED`-token path (S4) via the shared `reconcileTicketTruth()`, so it's one predicate not two. |
| **C3** committed ticket never Failed-flipped (both sites) | **W3** salvage | Landed per-seam; W3 routes both sites through `salvageTicket()`. |
| **C4** is-ancestor-guarded reset (H1 `detectAndRecoverHeadRegression`) on real `resetToSha` callers | **W3** | Landed per-caller; W3 makes `salvageTicket()` own "never reset over uncommitted/committed work" so new callers can't regress it. |
| **C5** resume ff-reattaches an orphaned commit | **W3** + **W2.R0** | Landed; `pickle-recover --resume-from-todo` reuses C5's reattach instead of a manual `git merge --ff-only`. |
| **C6/C7** CPU watchdog + conformance-present salvage of a hung/silent worker | **W3** | Landed per-seam (silent-exit/`/login`-hang); W3 = same archive-before-destroy default. |
| **C8** dirty-tree quarantine (archive-not-destroy, truncation-FATAL) | **W3** | Landed; W3 elevates "archive gate-failing diff + reset to Todo" to the shared default at every seam. |
| **D1/D2** promote-once inferred→explicit + bounded activity log | **W3 #4** | Landed (phantom-Done backfill). |
| **D3/D4/D5** `prd_path` populated on paused-refine→resume + citadel self-heal | **W2.R3** (prior art) | Landed — fix-plan already credits B-RRH here. |
| **E1–E6** forward-created validator awareness (extends R-FRA-6: bundle-creation index, command-string/table coverage, contract-resolver annotation honor) | **W1b** | **Largely landed.** Delta: W1b keeps only what E1–E6 leaves uncovered (event-literal refs per R-RTRC-7; the *refiner auto-emits* the annotation so the operator never hand-annotates). |
| **E7** review-hammer cross-file scope · **E8** flake-tolerant release gate | — (R-RGED / release-gate family) | Out of design scope. |

**Net effect — the design bundles SHRINK once B-RRH lands:**
- **B-GROUND (W2+W3+W4)** is mostly a **consolidation refactor**: extract `reconcileTicketTruth()` (from A1/C1/C2), `salvageTicket()` (from C3/C4/C5/C6/C7/C8/D1), and `haltOrRecover()` (from A2 + B-ORSR + the codex sites) into three primitives every current **and future** seam routes through — proven by a single-choke-point `git grep` + forward-protection lint. Its only genuinely *net-new* code is the prevention B-RRH never touches: **W2.R0** `pickle-recover` command, **W2.R1** session-scoped kills (R-CSI — not in B-RRH at all), **W2.R3a** stale-pin re-pin (R-RSPIN-A — B-RRH does `prd_path` but not the branch/SHA pin).
- **B-PROPORTION (W1+W5)** drops W1b to a thin delta (E1–E6 did the heavy lifting); its real content is **W1a** collapse-skip-flags, **W1c** resolver-indeterminate-not-defect, **W1d** scope-aware dirty-tree *preflight* (B-RRH C8 is the crash-quarantine, not the launch preflight; R-SMAF shipped only the microverse one), **W1e** greenfield-corpus CI, and **W5** removals + governance.

**Therefore the design rework is not redundant with the point-fixes — it is the step that makes them durable.** Each AC below is annotated `[B-RRH lands X → delta Y]` so refinement builds only the delta.

---

## Design principles (the law W1–W5 enforce)

1. **Ground truth beats ambient signals.** Every decisive transition (phase-advance, mark-Done, no-progress, completion, kill-target) reads tree-state-passing-gates + ticket frontmatter + live HEAD — never commits-landed, exit-code, log-token, inferred status, or binary name. *(D2)*
2. **Validation is proportional and self-clearing.** A greenfield/refined bundle passes the gates **by construction**. A gate that false-blocks legitimate work N times is loosened or removed — not given another escape hatch. Forward-creation is a first-class refinement *output* (auto-annotated), not an operator burden. *(D1)*
3. **Never discard verified work.** Salvage-before-fail is a runtime default at every fail/cancel/timeout/exit seam — not a babysitter recipe. Gate-passing tree changes are committed before any Failed-flip or reset; gate-failing diffs are archived, never `reset --hard`'d away. *(D2)*
4. **Recover, don't park.** A single weak-evidence failure runs an autonomous recovery ladder (re-pin / resume-from-lowest-Todo / split / salvage) before any human handoff. When recovery genuinely can't proceed, there is **one sanctioned, hook-safe command** to perform every recovery transition. *(D2 + the R0 keystone)*
5. **Subtract before you add.** Adding a guard requires (a) a documented escape hatch in the same change, and (b) a stated recurrence budget; a guard that exceeds its budget is removed. The existing drafted removals ship as a one-time sweep. *(D3)*

---

## Workstream W1 — Validation proportionality & escape-hatch consolidation  *(P1; the D1 keystone — closes the largest unaddressed class)*

**Closes:** the readiness/AC-shape/dirty-tree false-positive family (R-FRA, R-RFCB, R-RHFP, R-RCEX, R-RPRA, R-RTRC-7, R-ACSG, R-SMAF residue, R-GNDT-class). Consolidates the drafted-but-unshipped `p1-gate-ergonomics-sweep` + `p3-collapse-quality-gate-skip-flags`.

**Current anti-pattern.** Each gate that false-blocks spawns a new skip-flag or annotation grammar with incomplete coverage; greenfield/refined bundles fail by structural false-positive; the checker's *own* timeout is reported as a defect in the work; the operator must discover hidden flags and hand-annotate forward-creations the refiner could have emitted.

**Simplifying design.**
- **W1a — One skip surface.** Finish collapsing all gate-bypass flags to the single `skip_quality_gates_reason` (legacy `skip_readiness_reason`/`skip_ticket_audit_reason` already auto-migrate; add `--skip-ac-shape-gate` and any dirty-tree bypass to the same surface). One flag, one reason string, documented in one place.
- **W1b — Refiner emits annotations, operator does not.** `[B-RRH E1–E6 lands the validator-side awareness (bundle-creation index, command-string/table coverage, contract-resolver annotation honor) → W1b's delta is the *producer* side + event-literal gap.]` After B-RRH, the checkers already honor annotations; W1b makes `/pickle-refine-prd` Step 7 **auto-emit** the canonical `(created by ticket <8hex>)` (and `(forward-created)` for self-creates) so the operator never hand-annotates and the decomposer never emits the non-canonical `(ticket <hash>)`, plus closes the event-literal ref gap (R-RTRC-7) if E1–E6 leaves it. The bundle-creation index itself is B-RRH E1–E6; W1b consumes it, doesn't rebuild it.
- **W1c — A checker that can't finish is not a defect verdict.** When a readiness sub-checker exhausts its wall budget (the contract/symbol resolver on a large monorepo), it emits an **`indeterminate`** result that does **not** halt the bundle — never a `wall_budget_exceeded` *finding against the work*. Raise the default resolver budget and make it the indeterminate path, not the fail path.
- **W1d — Scope-aware dirty-tree (generalize R-SMAF).** Every clean-tree precondition (pipeline-runner, microverse-runner, anatomy/szechuan) evaluates dirtiness **only over `allowed_paths`** (via the existing `filterByScope`), and matches `docs/`/`prds/` segments at any depth. Out-of-scope autofix churn is ignored, not aborted on.
- **W1e — Greenfield passes by construction (regression corpus).** A standing fixture corpus of real greenfield/refined bundles (the ones that historically false-blocked: LOA-727 AC-shape, the 5 R-FRA forward-created bundles, the wall-budget monorepo) runs in CI; the gates must pass them with **no skip-flag**.

**Acceptance criteria.**
- [ ] AC-W1a-1: a single `git grep` finds exactly one operator-facing bypass surface (`skip_quality_gates_reason`); legacy flags warn + auto-migrate; `prds/CLAUDE.md` documents one flag. Trap-door pinned.
- [ ] AC-W1b-1: refine a forward-creating bundle; every hardening-ticket `MODIFIED_FILES` path either resolves at HEAD or carries the canonical `(created by ticket <8hex>)`; a lint finds **zero** bare `(ticket <8hex>)` forward-refs.
- [ ] AC-W1b-2: a bundle where ticket order 70 references a file declared by ticket order 10 → `check-readiness` exits 0 with **no skip-flag**. Same for symbol and event-literal refs.
- [ ] AC-W1c-1: force the contract resolver to exceed its wall budget → readiness emits `resolver_indeterminate` (warn) and exits 0; it never emits a `wall_budget_exceeded` finding that halts.
- [ ] AC-W1d-1: scoped run with an out-of-scope `lint --fix` mutation → preflight evaluates only `allowed_paths`, does not abort; nested `packages/*/docs/prd/*.md` churn is exempt.
- [ ] AC-W1e-1: the greenfield-corpus CI fixture (≥4 historically-blocking bundles) passes readiness + AC-shape + ticket-audit with zero skip-flags; a new false-positive regression fails CI.

---

## Workstream W2 — Session isolation & ground-truth at resume/completion  *(P1; ADOPTS the 2026-06-13 fix-plan verbatim)*

This workstream **is** `prds/p1-fix-plan-session-isolation-and-ground-truth-2026-06-13.md` (R0 recovery primitive, R1 session-scoped process isolation, R2 frontmatter-truth phase-advance, R3 re-pin/bundle-aware readiness, S1–S4 hygiene). It is the prevention slice of principles 1 + 4 for the launch/resume/signal seams. **Do not re-author** — refine that file directly. Its R0 (`pickle-recover`) is the sanctioned recovery command principle 4 requires; its R2 frontmatter-authority advance gate is the principle-1 instance for phase completion.

**Cross-binding to this PRD:** W2.R2 (phase completion = frontmatter, not exit-code/token) and W3 (salvage-before-fail) are the same principle at two seams — refine them so they share one ground-truth helper (`reconcileTicketTruth(session)`), not two parallel scanners.

---

## Workstream W3 — Salvage-before-fail as a runtime default  *(P1; the D2 work-loss keystone — retires 5 babysitter recipes)*

**Closes:** R-WCUC (uncommitted gate-passing work discarded), R-XCOR/R-XSPA-2 (cancel/signal orphans a committed ticket + Failed-flips it), R-MWIS (silent-exit strands green work), R-MCDT (mid-implement crash leaves non-gate-passing dirty tree), R-HUNG (re-login strands completed worker), phantom-Done backfill. The shipped R-WCUC fix commits gate-passing work *but still parks*; this generalizes it to **every fail/cancel/timeout/exit seam** and pairs it with W4 so it continues instead of parking.

**`[B-RRH lands the per-seam fixes → this workstream's delta is the shared helper]`.** B-RRH already implements salvage at each seam individually: C3 (committed-not-Failed, both sites), C4 (is-ancestor reset guard), C5 (resume ff-reattach), C6/C7 (watchdog + conformance salvage), C8 (dirty-tree quarantine), D1/D2 (promote-once + activity cap). **W3 does not re-implement any of these.** It extracts them into one `salvageTicket()` primitive every seam — *including seams added after B-RRH* — must route through, closing the recurrence where a new interruption type (the N+1th seam) silently bypasses the hand-wired fix.

**Current anti-pattern.** Five distinct human recovery recipes exist because the runtime discards or orphans verified work at: no-progress fail, external cancel, signal-shutdown, silent worker exit, manager crash. B-RRH fixes each seam *by hand*; without consolidation the next novel seam regresses (the exact R-WMNP / R-CHTS-CODEX pattern — a fix existed, the new site didn't call it).

**Simplifying design.** Extract B-RRH's per-seam salvage logic into one `salvageTicket(session, ticket)` helper, called at **every** seam (current + future) before any Failed-flip / `resetToSha` / clean-tree relaunch:
1. If the in-scope tree **passes the ticket's gates** → commit it (scoped paths only, never `add -A`/dir-wide `restore`) and mark Done with the real commit. *(retires "verify+commit+Done" + "ff-only reattach")*
2. If the in-scope tree is **dirty but gate-failing** → archive the diff to the session dir and reset the ticket to Todo (so a relaunch re-attempts from a clean base without losing the diff). *(retires "clean+reset-to-Todo" + R-MCDT)*
3. **Never** `git reset --hard` / `git restore <dir>` over uncommitted work; HEAD-regression off a committed ticket auto-ff-reattaches (deploy the H1 `detectAndRecoverHeadRegression` to the resume + cancel seams). *(retires "ff-only reattach" as a manual step)*
4. Completion is keyed on **process exit + tree truth**, not a log-emitted token, so a 0-byte-log exit with green work is salvaged, not stranded (R-MWIS/R-WPEX class).

**Acceptance criteria.**
- [ ] AC-W3-1: integration matrix {no-progress fail, external SIGTERM, signal-shutdown, silent 0-byte worker exit, manager mid-implement crash} × {in-scope tree gate-passing, gate-failing} → gate-passing always committed+Done; gate-failing always archived+Todo; **never** a `reset --hard` over uncommitted work. Assert reflog has no orphaned ticket commit afterward.
- [ ] AC-W3-2: `git grep -nE "reset --hard|git restore|add -A|add \."` in `extension/src` — every destructive/broad git op is preceded by a `salvageTicket` call or scoped to ticket-declared paths; per-site regression + trap door.
- [ ] AC-W3-3: a HEAD that regressed off a committed ticket is auto-ff-reattached at resume and at cancel-teardown (no manual `git merge --ff-only`).
- [ ] AC-W3-4: inferred-completion is promoted to explicit **once** and never re-backfills; activity log is bounded; a 1.9MB-state repro stays under the cap.

---

## Workstream W4 — Recover-don't-park: generalize the autonomy ladder  *(P1; extends B-ORSR beyond its shipped scope)*

**Closes:** R-CHTS-class single-iteration parks that B-ORSR/B-CHTS-CODEX fixed *only for specific seams*; R-ONPD (oversized never-converge); R-WMNP (wmw-auto-skip in-phase respawn loop) — by routing **all** no-progress/handoff sites through one ladder.

**`[B-RRH lands A1/A2 progress accounting → this workstream's delta is the single choke point]`.** B-RRH A1 (Done-guard frontmatter re-read) and A2 (`ticket_ladder_exhausted` advance-while-runnable) add two more correctly-behaving sites — but they are *more* hand-wired sites, not a consolidation. W4 takes A1/A2 + the B-ORSR ladder + the B-CHTS-CODEX codex sites and routes them through **one** `haltOrRecover` decision, so A2's "advance while runnable" can't be the next thing a new site forgets to call.

**Current anti-pattern.** B-ORSR shipped a `RecoveryController` ladder, but new no-progress sites keep bypassing it (R-WMNP respawned in-phase forever; R-CHTS-CODEX's 4 codex sites needed separate wiring). The ladder exists; the wiring doesn't reach every caller — so "trigger-happy park" recurs at the next un-wired site. B-RRH adds correctly-behaving sites without removing the bypass risk; W4 removes the bypass risk.

**Simplifying design.**
- **W4a — Single choke point.** Every no-progress / handoff / self-terminate decision (claude + codex, worker-mode + manager-mode, all caps) routes through **one** `haltOrRecover(session, evidence)` seam. A `git grep` proves there is exactly one decision site; new sites cannot bypass it (lint/trap-door).
- **W4b — Evidence-gated, not count-gated.** The ladder fires recovery (re-pin → salvage → resume-from-lowest-Todo → split oversized → honest-terminal) and only hands off when recovery is genuinely exhausted — never on `consecutive_failed==1`. Oversized-with-converged-plan executes the plan; oversized-with-zero-output splits (the R-ONPD taxonomy).
- **W4c — Caps repopulate from frontmatter.** No-progress caps derive `max_iter` from ground truth, never a stale `undefined` cache that silently disables the cap (R-WMNP root cause).

**Acceptance criteria.**
- [ ] AC-W4a-1: `git grep` shows exactly one `haltOrRecover` decision site; all former `closer_handoff_terminal`/`codex_manager_no_progress`/`wmw-auto-skip` halt sites route through it; a new bypassing halt fails a forward-protection lint.
- [ ] AC-W4b-1: a single non-progressing iteration with gate-passing tree → salvage+continue, **not** park (over {claude, codex} × {worker, manager}).
- [ ] AC-W4b-2: an oversized ticket with a converged plan + worker output executes the plan; one with zero output splits; neither parks for a human.
- [ ] AC-W4c-1: the per-ticket cap is always populated from frontmatter; a stale cache cannot yield `max_iter=undefined` / an unbounded loop. Regression over the R-WMNP repro.

---

## Workstream W5 — Simplification governance + one-time removal sweep  *(P2; stops accretion)*

**Closes:** D3. Ships the drafted-but-unshipped removals and installs the rule that prevents the next round of accretion.

**Simplifying design.**
- **W5a — Ship the removal backlog.** `p2-remove-pipeline-wall-clock-time-cap` (default-off the wall cap — it turns rate-limit recovery into false-success "death"); `p1-strip-excessive-defense-deploy-reversion` (~480 LOC of speculative deploy-reversion hardening; keep only the load-bearing AC). Verify-first each against HEAD (some may already be partially landed).
- **W5b — Governance rule (engineering law).** Add to `extension/CLAUDE.md` Engineering Rules: *"A new gate/guard/defense MUST ship with (1) a documented escape hatch on the unified skip surface and (2) a stated recurrence budget. A guard that false-blocks legitimate work beyond its budget is loosened or removed — never given a second escape hatch. Don't add defense pre-emptively (`p1-strip-excessive-defense`); scale the phase set, not the clock (R-PIAP)."*
- **W5c — Recurrence dashboard.** A metrics view counts skip-flag uses + gate-false-positive activity events per gate; a gate over budget surfaces in `/pickle-metrics` as a removal candidate. The data, not a human's memory, drives the next subtraction.

**Acceptance criteria.**
- [ ] AC-W5a-1: wall-clock cap defaults off; a rate-limit reset window no longer exits `limit`/false-success; iteration caps + per-worker timeouts remain the bound. Regression over the 4h-reset / 30-min-budget repro.
- [ ] AC-W5a-2: the speculative deploy-reversion hardening is removed to the load-bearing AC only; the deploy-reversion regression test still passes (proves the real fix, not the scaffolding, prevents recurrence).
- [ ] AC-W5b-1: `extension/CLAUDE.md` Engineering Rules carries the subtract-before-add governance rule; a meta-lint flags any new gate that adds a non-unified skip-flag.
- [ ] AC-W5c-1: `/pickle-metrics` reports per-gate skip-flag-use + false-positive counts; a gate over its stated budget is flagged.

---

## Recommended sequencing & bundle split

**Hard ordering precondition: B-RRH ships FIRST.** Both design bundles are *consolidation + net-new prevention on top of B-RRH's landed point-fixes* (see Reconciliation table). Launching them before B-RRH would mean refactoring code that's still changing under the closer. The four P1 workstreams are large; refinement decides the exact split. Suggested two-bundle frame:

1. **B-GROUND (P1) = W2 + W3 + W4** — the autonomy core, post-B-RRH. Mostly a **consolidation refactor**: extract `reconcileTicketTruth()` (from B-RRH A1/C1/C2), `salvageTicket()` (from C3/C4/C5/C6/C7/C8/D1), `haltOrRecover()` (from A2 + B-ORSR + codex sites) into three primitives every current + future seam routes through (proven by single-choke-point `git grep` + lint). Net-new code = only what B-RRH never touches: **W2.R0** `pickle-recover` (build first — codifies the playbook into a hook-safe tool, lowest risk), **W2.R1** session-scoped kills (R-CSI), **W2.R3a** stale-pin re-pin (R-RSPIN-A).
2. **B-PROPORTION (P1→P2) = W1 + W5** — validation proportionality + governance, post-B-RRH. W1b shrinks to a thin delta over B-RRH E1–E6 (refiner-emits-annotation producer side + event-literal gap). Real content: **W1a** one skip surface, **W1c** indeterminate-not-defect resolver, **W1d** scope-aware dirty-tree *preflight* (B-RRH C8 is crash-quarantine, not launch preflight), **W1e** greenfield-corpus CI; then **W5** removal backlog + governance rule + recurrence dashboard. W1e is the regression net that keeps W1's loosening honest.

**Dependency note:** B-GROUND's W2.R1 (session-scoped kills, R-CSI) is **not** in B-RRH and is the highest-leverage SIGTERM-storm prevention — if the concurrent-session SIGTERMs recur before B-GROUND is scheduled, pull W2.R1 out as a standalone fast-follow on B-RRH. W1's gate-loosening is independently shippable and removes the most operator friction per ticket.

**Expected outcome.** Closing D1+D2+D3 retires ~9 open findings, the 5 work-loss recovery recipes, and the recurring SIGTERM/park/false-block interventions — converting the babysitter from a required human-in-the-loop into an exception handler that, when it must act, runs **one** sanctioned command.

**DO NOT IMPLEMENT.** Next action: refine W2 from its existing fix-plan; `/pickle-refine-prd` this file for W1/W3/W4/W5 into atomic, machine-checkable tickets; route through the standard pipeline once the concurrent sessions clear and beta.3 has shipped.
