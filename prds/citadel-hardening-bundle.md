# PRD: Citadel + Hardening Bundle

> **Bundle PRD (manifest)** — this PRD orchestrates a single `/pickle-pipeline --backend codex` run over three independently-authored source PRDs:
> - `prds/citadel.md` — `/citadel` post-implementation conformance audit + cross-skill updates (~50 tickets)
> - `prds/anatomy-park-followups.md` — recoverable-json tests, trap-door catalog hygiene, microverse codex-relaunch (3 tickets)
> - `prds/watcher-pane-recovery.md` — watcher pane respawn on mux-runner relaunch (4 tickets)
>
> The source PRDs remain individually shippable. This file is a single entry point for the refiner; it produces one combined, deduped ticket queue. Total surface: ~57 tickets.

## Background

Three PRDs sat queued after the god-fn epic and anatomy-park overnight runs. Two are tactical hardening of recently-shipped runtime (`anatomy-park-followups`, `watcher-pane-recovery`); one is a strategic new audit skill (`citadel`). They are coupled in one direction:

- Citadel's audit subskill spawns workers and may invoke the microverse-runner. `anatomy-park-followups` T3 (extend codex-manager-relaunch from `mux-runner.ts` to `microverse-runner.ts`) closes a wall the audit will hit on long runs.
- A 57-ticket pipeline must be observable. `watcher-pane-recovery` is the dashboard fix for the bundle's own long run — without it, three of four monitor panes go silent after every phase transition.

Bundling them lets refinement deduplicate the small overlap (anatomy-park-followups T3 ↔ citadel's audit-subskill spawn assumptions; watcher-pane-recovery ↔ pipeline-runner phase-transition ownership) and produces one tmux session instead of three.

## Scope

This bundle delivers the union of the three source PRDs, in one ticket queue, executed in one `/pickle-pipeline --backend codex` session.

### Section A — Watcher Pane Recovery (4 tickets, source: `prds/watcher-pane-recovery.md`)

Replace the silent-pane-after-relaunch failure mode. `ensureMonitorWindow()` must respawn `log-watcher.js`, `morty-watcher.js` / `refinement-watcher.js`, and `raw-morty.js` when their panes are at a shell prompt and `state.active: true`. Idempotent on alive panes. Ownership transitions in `pipeline-runner` re-trigger the sweep so watcher panes follow phase transitions.

Implementation files: `mux-runner.ts`, `pipeline-runner.ts`, `monitor.js`, plus tests in `extension/tests/`. Full ticket breakdown lives at `prds/watcher-pane-recovery.md` §Atomic Tickets.

### Section B — Anatomy-Park Followups (3 tickets, source: `prds/anatomy-park-followups.md`)

Three small follow-ups identified by the 5-agent review of the 59-commit anatomy-park overnight run:
- **B-T1** Trap-door catalog hygiene: split entries >1500 chars into atomic `INVARIANT/BREAKS/ENFORCE` triples; standardize ENFORCE to test filenames.
- **B-T2** New `extension/tests/recoverable-json.test.js` — at least 6 cases covering orphan-tmp promotion, live-PID skip, dead-PID promotion, missing base, corrupt base, multiple competing tmps, non-matching files. Real filesystem (mkdtemp), no mocks.
- **B-T3** Extend codex-manager-relaunch from `mux-runner.ts` (`evaluateCodexManagerRelaunch`) to `microverse-runner.ts`. Reuse `state.codex_manager_relaunch_count`, `Defaults.CODEX_MANAGER_RELAUNCH_CAP`, `codex_manager_relaunch` activity event. Codex backend only.

Full ticket detail lives at `prds/anatomy-park-followups.md` §Atomic Tickets.

### Section C — Citadel (~50 tickets, source: `prds/citadel.md`)

New `/citadel` post-implementation conformance audit phase, plus matched updates to `/pickle-refine-prd`, `/anatomy-park`, `/szechuan-sauce`, and `/cronenberg`. Driven by the LOA-618 post-mortem (5-agent audit found 8 issues the pipeline missed: 2 AC violations, 5 untested trap-doors, 1 cross-cutting bug across sibling routes).

Citadel runs as a phase between `pickle` and `anatomy-park` in `pipeline-runner.ts`, blocking only on Critical (or High with `--strict`). Anatomy-park and szechuan-sauce read its JSON report.

Citadel also absorbs `bmad-inspired-hardening.md` (deleted 2026-04-29). Conformance overlap (BMAD P0 AC-machine-checkability + contract-resolution) is folded into core T17. Remaining BMAD capabilities (`/pickle-readiness`, `/pickle-archaeology`, phase-specialized Morty subagents, `/pickle-correct-course`, `/pickle-debate`, schema migration v2→v3, codex-format pin, hang guards, full risk register) are preserved verbatim in `prds/citadel.md` Appendix.

Full ticket detail lives at `prds/citadel.md` §Tasks (T0–T16 core + T20–T23 cross-skill + T13.5 cronenberg + ~28 BMAD-T## appendix).

## Sequencing (refiner: respect this order)

1. **Section B-T3** (microverse codex-relaunch) **first** — citadel's audit subskill may invoke microverse-runner; B-T3 makes that path relaunch-safe before citadel exercises it.
2. **Section A** (watcher-pane-recovery) **second** — observability for the long run that follows.
3. **Section B-T1, B-T2** — independent, parallelizable with section A.
4. **Section C** (citadel) **last** — depends on B-T3 for relaunch safety; benefits from section A's observability during its long codex run.

## Acceptance Criteria

This bundle is **Done** when every AC from the three source PRDs is met. The refiner must produce tickets whose verification asserts each:

### Section A — Watcher Pane Recovery (7 ACs, full text in `prds/watcher-pane-recovery.md`)
- [ ] **AC-WPR-01..07** as defined verbatim in source PRD.

### Section B — Anatomy-Park Followups (13 ACs, full text in `prds/anatomy-park-followups.md`)
- [ ] **AC-APF-A1..A4** (catalog hygiene)
- [ ] **AC-APF-B1..B3** (recoverable-json tests)
- [ ] **AC-APF-C1..C6** (microverse codex-relaunch)

### Section C — Citadel (18 ACs, full text in `prds/citadel.md`)
- [ ] **AC-CIT-01..18** as defined verbatim in source PRD.

### Bundle-level integration ACs
- [ ] **AC-BUNDLE-01** Single tmux session runs the full ticket queue end-to-end on `--backend codex` without the watcher panes going silent at any phase transition (validates section A integrates with the pipeline this PRD itself runs through).
- [ ] **AC-BUNDLE-02** `pipeline-runner.ts` Citadel phase reads `<session>/anatomy-park.json` and `<session>/szechuan-sauce.json` correctly when present, exits clean when absent — no double-counting or orphaned-finding errors. Validated against a fixture session that runs all three phases.
- [ ] **AC-BUNDLE-03** During the bundle's own run, `microverse-runner.ts` sees zero `codex_manager_relaunch_count` increments above `Defaults.CODEX_MANAGER_RELAUNCH_CAP` (validates B-T3 is correctly capped before citadel exercises the relaunch path).
- [ ] **AC-BUNDLE-04** Refinement deduplicates the codex-manager-relaunch overlap: the refined ticket queue contains exactly one ticket implementing the microverse relaunch (B-T3), not two (one from anatomy-park-followups and one from citadel's spawn assumptions).

## Non-goals

- This bundle does **not** include `god-functions-remediation-phase-2.md` (refactor epic, not bug fixes — separate pipeline).
- This bundle does **not** include `large-tier-stall-recovery.md` (stale, needs PRD rewrite first).
- This bundle does **not** include `deepseek-integration.md` or the three unindexed PRDs (`openrouter-multi-provider-workers`, `tool-error-retry-tracking`, `smart-iteration-handoff`).
- The bundle PRD is a **manifest** — it does not duplicate ticket content from the source PRDs. The refiner must read all three source PRDs to produce the queue.

## Verification Plan

1. **Refinement pass** produces a ticket queue that covers every AC above. Refiner manifest must list source-PRD origin per ticket (`source: prds/watcher-pane-recovery.md`, etc.) for traceability.
2. **Pipeline run** (`/pickle-pipeline prds/citadel-hardening-bundle.md --backend codex`) builds → anatomy-park → szechuan-sauce on the unified queue.
3. **Per-section validation**: each source PRD's verification plan applies in full (see source PRDs §Verification Plan). The bundle adds AC-BUNDLE-01..04.
4. **Toolchain gate** (v1.58+): the convergence-toolchain-gate runs at finalize-time on every phase. Zero new failures vs. baseline required for clean exit.

## Files Likely Touched

Union of the three source PRDs' "Files Likely Touched" sections. The largest contributors (citadel) hit:
- `extension/src/bin/citadel.ts` (NEW)
- `extension/src/bin/pipeline-runner.ts` (Citadel phase integration)
- `extension/src/services/citadel-*.ts` (NEW — task implementations T3–T11)
- `extension/src/bin/setup.ts` (`prd_path`, `start_commit`)
- `.claude/commands/citadel.md` (NEW slash command)
- `.claude/commands/cronenberg.md`, `pickle-refine-prd.md`, `anatomy-park.md`, `szechuan-sauce.md` (cross-skill updates)
- Plus all files listed in `prds/anatomy-park-followups.md` §Files Likely Touched and `prds/watcher-pane-recovery.md` §Files Likely Touched.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| RB1 | Refinement produces duplicate tickets for the codex-manager-relaunch overlap | AC-BUNDLE-04 + explicit dedup directive in §Sequencing |
| RB2 | Citadel scope dominates and watcher-pane / anatomy-park-followups tickets get scheduled last (low pipeline coverage) | Sequencing §1–3 forces tactical fixes first; refiner ordering directive enforces it |
| RB3 | Watcher panes go silent during the bundle's own run before AC-WPR-01 lands | Run section A tickets before section C. AC-BUNDLE-01 validates this empirically |
| RB4 | Total ticket count (~57) exceeds tmux session token budget on codex backend | Bundle is approved for codex backend specifically (--backend codex; ~5–10× faster than claude per master plan); single session feasible. If exceeded, split at section boundaries |
| RB5 | Citadel's `pipeline-runner.ts` phase integration conflicts with watcher-pane-recovery's phase-transition ownership changes (both touch the same file) | Sequencing puts section A before section C; refiner must produce ordered tickets so the watcher fix lands before citadel's phase code modifies pipeline-runner |

## Linked context

- Source PRDs: `prds/citadel.md`, `prds/anatomy-park-followups.md`, `prds/watcher-pane-recovery.md`
- Master plan reference: `prds/MASTER_PLAN.md` §1 (Citadel + Hardening Bundle row)
- Predecessor work: god-fn epic (T0–T19, 2026-04-29), convergence-toolchain-gates v1.58.0, anatomy-park overnight (59 commits)
- LOA-618 post-mortem: drives citadel's design (`prds/citadel.md` §Background)
