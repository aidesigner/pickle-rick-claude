# R-DSAN W1/W5 Disposition — WS-E Close-Out

**Ticket:** 14f192ce (B-DSAN2, WS-E / AC-E1)
**Source PRD:** `prds/p1-design-ground-truth-efficacy-followup-2026-06-14.md`
**R-DSAN AC list source:** `prds/p1-design-simplification-and-autonomy-2026-06-13.md`
**Date:** 2026-06-15
**HEAD baseline:** entry `start_commit` 4f7b79f4

## Summary

This is the WS-E close-out record for the R-DSAN W1/W5 remnants. It **enumerates** each of the ten W1/W5 acceptance criteria against HEAD — it does NOT "verify against the list." Every AC is dispositioned with a landing commit SHA, the load-bearing source `file:line`, and the oracle test that proves the behavior.

**Finding: all ten ACs are PRESENT at HEAD.** They were shipped by the B-PROPORTION bundle as **v2.0.0-beta.3** (`prds/MASTER_PLAN.md` row 114: "✅ SHIPPED v2.0.0-beta.3 (W1+W5)"). Zero items are absent → zero items to re-ship.

Per the WS-E scope constraint, this workstream adds **no new guard, no new skip-surface, and no new test** — and reverts no shipped R-DSAN code (additive-only). Because zero items are absent, there is nothing to re-ship as code; the deliverable is this durable disposition record. Adding a presence-assertion test or a skip-flag here would itself violate WS-E and the W5b subtract-before-add governance rule this very PRD established.

Two ACs — **W1b-1** and **W5b-1** — carry moderate-confidence oracles of the governance / prompt-audit class (prompt-string audit and meta-lint-wiring-by-documentation respectively, rather than a live-invocation behavioral test). This is stated honestly per item below; per the research self-review (`research_review.md`) this is the correct oracle class for prompt-governed / documentation-level ACs.

## Sibling cross-check

No sibling B-DSAN2 ticket maps to any W1/W5 AC — all siblings map to AC-A1 through AC-E2 (ground-truth / completion / validation categories). Every W1/W5 AC is therefore dispositioned against HEAD directly, with no "covered by sibling" shortcut.

## Per-AC Disposition

| AC | One-line AC text | Disposition | Landing commit | Load-bearing source `file:line` | Oracle test |
|---|---|---|---|---|---|
| **AC-W1a-1** | A single `git grep` finds exactly one operator-facing bypass surface (`skip_quality_gates_reason`); legacy flags warn + auto-migrate; documented in one place; trap-door pinned. | PRESENT | `7d1b5274` (W1a collapse quality-gate skip-flags to one skip surface) | resolver `extension/src/bin/mux-runner.ts:3919` (unified flag read first; legacy fallback `:3929-3930`); migration `extension/src/services/state-manager.ts:500-519`; doc `prds/CLAUDE.md` Skip-Flag Conventions + `extension/CLAUDE.md:67`; trap-door `extension/CLAUDE.md:197` | `extension/tests/one-skip-surface.test.js` (6 invariant groups: unified surface, bootstrap, migration, AC-shape fold-in, smoke-gate separation, conflict rule) + meta-lint `extension/scripts/audit-skip-flag-unification.sh` |
| **AC-W1b-1** | Refiner auto-emits canonical forward-creation annotations; a lint finds zero bare `(ticket <8hex>)` forward-refs. | PRESENT | `462d6cf9` (refiner Step 7 auto-emits canonical forward-creation annotations) | prompt `.claude/commands/pickle-refine-prd.md` (Step 7c hygiene block) | `extension/tests/refiner-auto-annotation.test.js:48-65` — **moderate-confidence: prompt-audit class.** Asserts required strings in the deployed prompt text (`:48` AUTO-EMIT canonical annotation, `:55` NEVER emit bare form) + decomposer self-lint regex scan for bare 8-hex forward-refs (`:56-60`). Not a live refiner-invocation test — inherent to prompt-governed behavior, acceptable per PRD scope. |
| **AC-W1b-2** | A bundle where order-70 references an order-10 file → `check-readiness` exits 0 with no skip-flag (path, symbol, event-literal refs). | PRESENT | `462d6cf9` (same as W1b-1) | `extension/src/bin/check-readiness.ts` (readiness resolver, exercised via subprocess) | `extension/tests/refiner-auto-annotation.test.js:74-143` — behavioral subprocess test; all three ref types (path `:99`, symbol `:125`, event-literal `:126`); exit status asserted `=== 0` with no `skip_*` flag |
| **AC-W1c-1** | Contract resolver exceeds wall budget → readiness emits `resolver_indeterminate` (warn) and exits 0; never a `wall_budget_exceeded` halt. | PRESENT | `1f846b97` (resolver_indeterminate named event + DEFAULT_MAX_WALL_MS 120s) | emit site `extension/src/bin/check-readiness.ts:1256` (`event: 'resolver_indeterminate'`); non-block invariant comment `:1301-1302`; event registered `extension/src/types/index.ts:794` | `extension/tests/resolver-indeterminate.test.js` (forces over-budget path, asserts exit 0 + event emitted) + second independent oracle `extension/tests/greenfield-corpus.test.js:139-178` (`--max-wall-ms 1`) |
| **AC-W1d-1** | Scoped run with an out-of-scope `lint --fix` mutation → preflight evaluates only `allowed_paths`, does not abort; nested `packages/*/docs/prd/*.md` churn exempt. | PRESENT | `b07f5eeb` (W1d scope-aware dirty-tree preflight, 3→1 allowlist collapse) | single resolver `extension/src/bin/pipeline-runner.ts:369` (`allowedDirtyPathsForLaunch()`); scope restriction `:407`; preflight integration `:2781`; segment exemption `:92` | `extension/tests/dirty-tree-scope-aware.test.js:36-95` — behavioral subprocess test, 3 cases: out-of-scope lint mutation does not abort; nested `packages/*/docs/prd/*.md` exempt; unscoped run preserves prior behavior |
| **AC-W1e-1** | Greenfield-corpus CI: ≥4 historically-blocking fixtures pass readiness + AC-shape + ticket-audit with zero skip-flags; paired-negative corpus still FAILS. | PRESENT | `f37f86d9` (W1e greenfield-corpus CI — passes-by-construction + paired-negative) | `extension/tests/greenfield-corpus.test.js` + fixtures under `extension/tests/fixtures/greenfield-corpus/` | `extension/tests/greenfield-corpus.test.js` — 4 positive fixtures (LOA-727 AC-shape `:102`, R-FRA forward-created `:112`, forced-budget wall `:140`, R-RTRC-4 deep-path `:182`) each gated by `assertNoSkipFlags()`; 3 paired-negative fixtures (`:204`, `:220`, `:230`) asserted to FAIL |
| **AC-W5a-1** | Wall-clock cap defaults off; a rate-limit reset window no longer exits `limit`/false-success; iteration caps + per-worker timeouts remain the bound. | PRESENT | `891867d7` (W5a regression locks — wall-clock cap default-off + deploy-reversion load-bearing) | default-off `extension/src/bin/setup.ts:261` (`timeLimit: 0`), write gated `:1368`, `time_cap_disabled_default` event `:1417-1424`, `∞` display `:1454`; rate-limit wait no clamp `extension/src/bin/mux-runner.ts:5874-5888` | `extension/tests/wall-clock-cap-removed.test.js` (13h-elapsed session with absent/0 cap never exits `time_limit`; opt-in cap still enforces) + `extension/tests/setup.test.js:410` (fresh session omits `max_time_minutes`, emits `time_cap_disabled_default`) |
| **AC-W5a-2** | Speculative deploy-reversion hardening removed to load-bearing AC only; deploy-reversion regression still passes. | PRESENT — verified-first | `891867d7` (same as W5a-1) | load-bearing fix `bin/release-gate.sh` present; speculative surface confirmed ABSENT (no `verify-deploy-parity` / `deploy_drift_detected` / `finalize-bundle` / `verify-launch` / `deploy-baseline` in `extension/src/`; no such scripts in `extension/bin/`). Commit body: both removal PRDs "entirely already-landed at HEAD." | `extension/tests/deploy-reversion-load-bearing.test.js` — behavioral: exit 0 on version agreement, rejects v1.66.0 reversion class (exit 10). Proves the real fix, not the scaffolding, prevents recurrence. |
| **AC-W5b-1** | `extension/CLAUDE.md` Engineering Rules carries the subtract-before-add governance rule; a meta-lint flags any new gate that adds a non-unified skip-flag. | PRESENT | `65c8e332` (W5b subtract-before-add governance rule + W5c skip-flag budget dashboard) | governance rule `extension/CLAUDE.md:61` (`### Subtract-before-add governance (W5b)`), full rule `:62-72`, enforcement note `:72`; meta-lint `extension/scripts/audit-skip-flag-unification.sh` | `extension/scripts/audit-skip-flag-unification.sh` (the meta-lint, wired into the build gate per project CLAUDE.md) — **moderate-confidence: governance class.** `CLAUDE.md:72` states the lint "fails the build" and the build-gate script sequence includes it; no separate test exercises the meta-lint itself. Acceptable for a governance/documentation AC. |
| **AC-W5c-1** | `/pickle-metrics` reports per-gate skip-flag-use + false-positive counts; an over-budget gate is flagged (keys on skip-flag-use rate only — ruling 3). | PRESENT | `65c8e332` (same as W5b-1) | `extension/src/services/metrics-utils.ts:97-103` (`SKIP_FLAG_BUDGETS`), event names `:85-93`, scan/report `:683-751`; dashboard `extension/src/bin/metrics.ts:426-450` (`OVER — removal candidate`), JSON `:495` | `extension/tests/skip-flag-budget-dashboard.test.js` — behavioral budget computation against synthetic session data with injected skip-flag events; keys on `{source,reason}` from the three existing skip-flag events (ruling 3 — no non-existent `gate_false_positive` event) |

## Spot-verification (performed during this close-out)

The following citations were re-checked against HEAD before this record was written; all resolved:

- `git log --oneline -1` for `7d1b5274`, `891867d7`, `65c8e332`, `462d6cf9` — all four landing commits resolve with matching subjects.
- `extension/src/bin/check-readiness.ts:1256` — `event: 'resolver_indeterminate'` exact match; registered at `extension/src/types/index.ts:794`.
- `extension/src/services/metrics-utils.ts:97` — `SKIP_FLAG_BUDGETS` exact match.
- `extension/CLAUDE.md:61` — `### Subtract-before-add governance (W5b)` exact match.
- `extension/src/bin/pipeline-runner.ts:369` — `allowedDirtyPathsForLaunch` exact match.

## Scope notes

1. `skip_smoke_gate_reason` is explicitly NOT collapsed into the W1a unified surface (ruling 2 — "W1a ruling-2 survivor," `extension/CLAUDE.md:67`).
2. W5c keys on skip-flag-use rate only — the non-existent `gate_false_positive` event is dropped (ruling 3).
3. AC-E2 (subtract-before-add compliance assertion, ticket 85471d8e) is OUT of scope per this ticket's frontmatter.
4. Additive-only: no shipped R-DSAN code is reverted; zero items absent → zero re-ship; no new guard / skip-surface / test added (WS-E).
