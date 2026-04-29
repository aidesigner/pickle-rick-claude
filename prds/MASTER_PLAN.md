# MASTER_PLAN — God Function Remediation

**Last updated**: 2026-04-29 (post god-fn epic + anatomy-park overnight)
**Status**: **God-fn epic SHIPPED end-to-end on codex** — T0–T19 (16 implementation + 4 hardening) all Done; anatomy-park overnight added 59 trap-door fixes on top. Convergence-toolchain-gates v1.58.0 still summarized below. **Active orchestration: Citadel + Hardening Bundle** (`prds/citadel-hardening-bundle.md` — citadel + anatomy-park-followups + watcher-pane-recovery, ~57 tickets) running via `/pickle-pipeline --backend codex`. Other queued PRDs: `god-functions-remediation-phase-2`, `large-tier-stall-recovery` (stale, needs rewrite), `deepseek-integration`.

---

## 1. PRDs

| Path | Status | SHA |
|---|---|---|
| `prds/god-functions-remediation.md` | **Shipped** (2026-04-29) — T0–T19 all Done (16 implementation + 4 hardening) on codex; 27 ESLint-ratchet carve-outs queued for phase 2. | `1658d81` (refined PRD); ESLint closer `7bf3263` |
| (Original, pre-refinement)            | Committed earlier in the day        | `b535e71` |
| `prds/codex-classifier-prompt-leak.md` | **Shipped** (2026-04-26) | `a48097b`, `3bc9bd2`, `a90ed73`, `4b1f784`, `17f6b03` |
| `prds/convergence-toolchain-gates.md` | **Shipped v1.58.0** (2026-04-28) — full 3-phase pipeline: 25 atomic tickets (gate primitive + finalize-gate orchestrator + remediator brief-prep + skill prompt updates + LOA-618 fixture) → anatomy-park surfaced 78 cross-cutting bugs, all fixed (incl. metrics worktree/nested-repo, runner ownership pid stamps, orphan-tmp recovery, hook fallback routing) → szechuan-sauce decomposed god-fns. Phase 1 ran on claude (rate-limited at 5h), phases 2/3 ran on codex (5–10× faster). 122 commits, +19,597/-1,921 LOC. iteration_regressions counter held at 0 throughout — gate didn't false-flag itself. | tag `v1.58.0` |
| **`prds/citadel-hardening-bundle.md`** (active orchestration) | **Queued** (2026-04-29) — `/pickle-pipeline --backend codex` over `prds/citadel.md` + `prds/anatomy-park-followups.md` + `prds/watcher-pane-recovery.md`. Manifest PRD; refiner produces one combined deduped ticket queue (~57 tickets). Sequencing: anatomy-park-followups T3 (microverse codex-relaunch) first (gates citadel's audit-subskill spawn), watcher-pane-recovery second (observability for the run), other followups parallelizable, citadel last. Source PRDs stay independently shippable. | uncommitted (this branch) |
| `prds/large-tier-stall-recovery.md` | Draft (2026-04-27) — 3 atomic tickets (tier-aware circuit-breaker budget, worker resume detection, e2e verification). Targets god-fn T1 codex stall. **NOT started.** Planned v1.57.0 release tag was claimed by cronenberg — retarget to v1.58.0 when picked up. | uncommitted |
| `prds/deepseek-integration.md` | Draft (2026-04-27) — third backend `'deepseek'` riding `claude` CLI via DeepSeek's Anthropic-compat shim; honest identity in state/logs/metrics; ~230 LOC. **NOT started.** | uncommitted |
| `prds/citadel.md` | Draft (2026-04-27, BMAD-merged 2026-04-29) — new `/citadel` command (post-implementation conformance audit: PRD ↔ implementation invariants, AC coverage, sibling guard parity, rule-set invariants, trap-door enforcement) **plus** matched cross-skill updates to `/pickle-refine-prd`, anatomy-park, szechuan-sauce, and cronenberg. Driven by LOA-618 post-mortem. **Absorbed `bmad-inspired-hardening.md`** on 2026-04-29: conformance overlap folded into core (new T17 + AC-CIT-18); remaining BMAD capabilities (`/pickle-readiness`, `/pickle-archaeology`, phase-specialized Morty subagents, `/pickle-correct-course`, `/pickle-debate`, schema migration v2→v3, codex-format pin, hang guards, full risk register R5/R9/R12/R13/R16/R20–R33) preserved verbatim in Appendix. 18 ACs (`AC-CIT-01..18`) + 16 core tasks (T0–T16) + 4 cross-skill (T20–T23) + cronenberg (T13.5) + ~28 BMAD-T## appendix tasks. **NOT started.** | uncommitted (citadel + 3 PRDs landed earlier) |
| `prds/god-functions-remediation-phase-2.md` | Draft (2026-04-28) — follow-up epic for the 27 pre-existing god-functions across 24 files exposed by T14's ESLint ratchet (Phase 1 closer). Each function has a scoped `// eslint-disable-next-line` carve-out from commit `7bf3263`; this epic refactors them and removes the carve-outs. Worst offender: `runGate` in `convergence-gate.ts` (cyclomatic 65, 305 lines). 6 ACs, ~20 atomic tickets sketched. **NOT started.** | committed in this branch |
| `prds/watcher-pane-recovery.md` | Draft (2026-04-28) — single-fix PRD for monitor-window watcher panes that exit on `state.active: false` and don't respawn when mux-runner relaunch brings the session back live. Discovered during the god-fn epic codex run; only `monitor.js` (dashboard) survived a relaunch, the other three watcher panes stayed at `zsh` prompts. 7 ACs, 4 atomic tickets. **NOT started.** | committed in this branch |
| `prds/anatomy-park-followups.md` | Draft (2026-04-29) — 3 small follow-ups identified by the 5-agent review of the 59-commit anatomy-park overnight run: (T1) trap-door catalog hygiene — split 3 oversized entries (pickle-utils.ts at 4042 chars), standardize ENFORCE clauses to test filenames; (T2) `recoverable-json.test.js` — add dedicated unit tests for the extracted module (currently only via state-manager + caller tests); (T3) extend codex-manager relaunch (`bf4a002`) to `microverse-runner.ts` — anatomy-park hit the same 4h subprocess-error wall that mux-runner now handles. 12 ACs, 3 atomic tickets. **NOT started.** | committed in this branch |
| `prds/openrouter-multi-provider-workers.md` | Draft (2026-04-01) — third-party LLM routing for worker spawn via OpenRouter. **NOT started.** No source impl. Lower priority than current bundle. | committed earlier (`e9e9666`) |
| `prds/tool-error-retry-tracking.md` | Draft (2026-03-31) — intra-session tool-failure tracking with escalating pivot guidance, inspired by OMC Ralph mode. **NOT started.** No source impl. Lower priority than current bundle. | committed earlier (`e9e9666`) |
| `prds/smart-iteration-handoff.md` | Refined draft — reduce wasted iterations 30%+ in microverse / 20%+ in tmux via smarter handoff intelligence. **NOT started.** No source impl. Lower priority than current bundle. | committed earlier (`e9e9666`) |
| Cronenberg meta-router skill | **Shipped v1.57.0** (2026-04-27) — explicit-invocation `/cronenberg` skill with deterministic decision matrix + tmux-detach-safe followup chaining. No PRD; designed inline. | `711f92c` |

The refined PRD includes: corrected line ranges, T0 prelude + T14 closer, goal-level 200 LOC carve-outs, 8-token enumeration, T1 post-pass invariants, T7 dry-run replacement (test seam, NO `--dry-run`), T2 scope clarification (`runIteration` already extracted), per-ticket frontmatter, fixture lockdown protocol, helper-signature spec rule, trap-door preservation, and a 17-row Risks table.

Pre-refinement preserved at `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/prd.md`.

---

## 2. Today's session — 2026-04-26 / 2026-04-27

T0 completed cleanly after a marathon debug session that surfaced and fixed five distinct PRC infrastructure bugs. The release line below is the actual deliverable from this session, alongside T0.

### Releases shipped this session

| Version | Bug fixed |
|---|---|
| `v1.56.0` | Pickle phase didn't pin `command_template`; stale `anatomy-park.md` misrouted resumed workers. Added phase-entry helper `enterPicklePhase()` that pins template + scrubs foreign-phase JSON files. Also added `ignore_dirty_paths` (default `prds/`, `docs/`) to clean-tree check. Microverse pre-flight applies same exclusion + auto-commit stages untracked files. Master plan moved to `prds/MASTER_PLAN.md`. |
| `v1.56.1` | Worker prompt "Write ONLY to `${TICKET_DIR}`" — codex took literally and refused all repo writes. Disambiguated to name ticket-artifact files explicitly and authorize Steps 5/8 to write to project working tree. |
| `v1.56.2` | 38 timing-sensitive tests bumped 3–5x to survive load when codex runs concurrent tool calls during baseline capture. Verified under 2x concurrent runs. |
| `v1.56.3` | Morty workers leaked orchestrator promise tokens upstream. Added `FORBIDDEN_WORKER_TOKENS` + runtime scrub in `spawn-morty.ts` finalize-time, plus prompt-level forbidden list. |
| `v1.56.4` | **Manager itself misuses EPIC_COMPLETED** — conflates per-ticket completion with epic completion. Replaced fail-loud guard with `evaluateEpicCompletion()` recovery state machine: 4-arm decision (genuine / recover_advance / recover_retry / persistent_hallucination). Pipeline survives manager hallucination structurally. Counter persists in `state.false_epic_completed_count`. **This is the fix that finally let T0 complete.** |
| `v1.57.0` | **Cronenberg meta-router shipped** (post-stash, 2026-04-27). New `/cronenberg` skill — explicit-invocation deterministic router that picks the right pickle metaphor + cleanup chain for a build/implement request. Tmux-detach-safe, flag pass-through, persona footprint = one Dispatch line. Unrelated to the god-fn epic; shipped as a side-quest. |
| `v1.58.0` | **Convergence-toolchain-gates shipped** (2026-04-28). New `convergence-gate` primitive (`runGate({mode,scope,checks,allowedPaths})`) + `finalize-gate.ts` post-runner orchestrator + `morty-gate-remediator` agent (mechanical-only autofix worker with snapshot-and-revert protocol) + `check-gate.ts`/`spawn-gate-remediator.ts` CLIs. Wires into `/szechuan-sauce` (line-205 tmux chain) and `/anatomy-park` (Step 6.6 baseline + line-166 chain). 14 new activity events, `iteration_regressions` counter on `MicroverseSessionState`, `gate-commands.json` for pnpm/npm/yarn/cargo/go, baseline schema with `(file, ruleOrCode, occurrence_index)` fingerprint, freshness invariants, R17 OOS handling, R18 dirty-worktree skip, R19 baseline-stale halt, R20 bootstrap recursion (gate-the-gate). Anatomy-park run on this PR exercised the gate against itself and found 78 cross-cutting bugs (CRITICAL/HIGH) across pickle-rick — all fixed in-loop. LOA-618 fixture replay test pinned. Final fixes pre-release: metrics-utils `git log --since` semantic bug (date-only boundary) + worktree commit attribution + 2 P1 findings in convergence-gate.ts (unsafe `as string` cast on empty cmd, silent error swallow on race). |

### T0 deliverables landed

- `extension/REFACTOR_BASELINE.md` — captured `npm test`/`tsc`/`eslint` baseline at HEAD `c205292`
- `extension/REFACTOR_FEASIBILITY.md` — feasibility proof for `_emitDot`/`mux-runner main` extractions, all helpers under cyclomatic-15 ceiling
- `extension/eslint.config.js` — added warn-level `complexity` (15) and `max-lines-per-function` (120) rules + per-file 200-LOC carve-outs for `dot-builder.ts` and `microverse-runner.ts`
- `extension/scripts/smoke-deployed-hooks.sh` — exec'able, exits 0 against deployed stop-hook (verified)
- `extension/tests/fixtures/dot-builder/` — 8 golden DOT fixtures (catastrophic-recovery, competing, convergence, fan-out, isolated-workspace-convergence, microverse, review-ratchet, sequential)
- `extension/tests/fixtures/{microverse,mux-runner,setup,spawn-morty,stop-hook}/` — token, schema, version, mutation fixtures
- T0 frontmatter `status: "Done"`

### What ate the day (so the next session has the receipts)

- v1.56.0 was the structural unblocker — without it, every resume picked up an `anatomy-park.md` template and the codex worker dutifully ran the wrong skill.
- v1.56.1 — codex is a literalist. Any prompt rule with "ONLY" or "NEVER" is read absolutely, even when context makes the intended scope obvious. Future prompt edits in this codebase: enumerate scopes explicitly; never use "ONLY" as a hard constraint.
- v1.56.4 worked exactly as designed: the v1.56.4 run logged **18 `MANAGER_FALSE_EPIC_COMPLETED` markers** during T0 alone. Every one of those was a hallucinated epic completion that would have killed the pipeline pre-fix. Recovery state machine caught all 18.

### Why the run still stopped

After T0 landed and codex advanced to T1 (`f068af3f` — Split `_emitDot`, the largest god function), codex ran for 5 iterations doing research/plan analysis without making implementation commits. Mux-runner's circuit breaker (separate from the EPIC_COMPLETED recovery — this one watches actual progress like ticket-status changes and commits) tripped at iteration 8 and exited. **This is not a hallucination — it's that T1's complexity (905 LOC, 6 helpers, 8 new tests) exceeded codex's per-iteration thinking budget.**

T1 status reset to `Todo` so resume starts fresh.

---

## 2.1 Today's session — 2026-04-28 / 2026-04-29 (god-fn epic SHIPPED on codex)

**Headline**: the god-function refactor epic that previously stalled at T1 with zero edits ran end-to-end on codex backend. T0–T19 (16 implementation + 4 hardening) all landed, then anatomy-park bonus phase added 59 trap-door fixes overnight. **~87 commits, ~10,500 LOC of refactor diff, 0 manual interventions.** The day's work is the validation that codex backend is now production-grade for large refactor epics.

### Releases shipped this session

| Version | What |
|---|---|
| `v1.59.0` | **Codex stall hardening** — P0 contract addendum (commit-required + DEFERRED-on-AC-contradiction + no-harness-exploration), commit-pending probe (handoff.txt nudge on stagnation), per-backend iteration budget (`claude:100, codex:80`), post-flush guard (no false-fail on short post-promise log when commits exist), per-ticket routing heuristic (default off). Plus `--effort low|medium|high` flag plumbing through codex CLI as `-c reasoning.effort=<level>`. |
| `v1.59.1` | **Codex isolation from `~/.codex/` rule files** — `--ignore-rules --ignore-user-config` added to `buildCodexInvocation`. Bypassing the parallel-universe `~/.codex/skills/pickle*` registry that was misdirecting codex mid-iteration with stale paths. The unblocker for the god-fn epic resume. |

### What landed (commit clusters)

| Cluster | Commits | Source |
|---|---|---|
| Codex stall hardening (v1.59.x) | 8 | session work — P0/P1/P2 fixes from RCA |
| Phase 1 god-fn epic (T0–T15) on codex | 18 | codex backend, autonomous |
| Phase 1 hardening + audit (T16–T19) | 6 | codex backend, autonomous |
| Anatomy-park bonus overnight | 59 | codex backend, autonomous (12h run) |
| Lint carve-outs + cleanup | 3 | session work — eslint ratchet exposure handling |
| PRD docs (this update + 3 follow-ups) | 2 | session work |
| **Total** | **~96** | |

### Codex backend validation — pre vs post v1.59.x

| Metric | Pre-v1.59.x (this same session resumed) | Post-v1.59.1 |
|---|---|---|
| T1 outcome | Stalled at iter 5, **zero edits** in 50 min | Done in 14 min, 463 LOC + 116 LOC tests |
| Tickets shipped autonomously | 0 (T0 was already pre-existing) | 19 (T0–T19) |
| Manual interventions during run | constant | zero |
| Wall time for full implementation phase | n/a (never finished) | 3h 41m |
| Self-correction commits | 0 | 2 (T3 complexity cleanup, T5 state-ownership fix) |

### Failure modes surfaced + addressed

| FM | Symptom | Fix |
|---|---|---|
| FM-1 stall-on-judgment | codex loops on AC contradiction without descoping | P0 contract addendum (`v1.59.0`) — descope + DEFERRED note |
| FM-2 stall-on-abstraction | codex explores harness internals (setup.js, mux-runner.js) instead of ticket scope | P0 contract addendum + worker prompt rule |
| FM-3 commit-skip | codex produces edits but never commits, work orphaned at breaker trip | P0 contract addendum + post-flush guard |
| FM-4 stall-on-imaginary-worker | codex narrates a non-existent worker subprocess, polling forever | `--ignore-rules --ignore-user-config` (`v1.59.1`) — bypasses stale `~/.codex/skills/pickle*` |
| Codex 4h subprocess wall | codex CLI session ceiling kills long-running manager | `bf4a002` — auto-relaunch ≤5 retries (mux-runner only; microverse-runner still vulnerable, see `prds/anatomy-park-followups.md`) |

### Why the pipeline stopped at Phase 2/3

Pickle-pipeline was running `pickle → anatomy-park → szechuan-sauce`. Phase 1 (pickle) shipped T0–T19 cleanly. Phase 2 (anatomy-park) ran 12h, completed 70 iterations + 59 trap-door fixes, then hit the same 4h codex-subprocess-error wall — but `microverse-runner.ts` (anatomy-park's engine) doesn't have the relaunch fix that `mux-runner.ts` got in `bf4a002`. Pipeline-runner classified the phase as failed and stopped before Phase 3 (szechuan-sauce) started. **This is the C ticket in `prds/anatomy-park-followups.md`.**

### Net status (verified on disk, 2026-04-29)

| Check | Result |
|---|---|
| Working tree | Clean (only 3 pre-existing PRD drafts untracked) |
| `tsc --noEmit` | Clean |
| `eslint src/ --max-warnings=-1` | 0 errors, 19 advisory warnings |
| Test suite | **3076/3076 pass** (+68 tests added by codex during the epic) |
| 5-agent review verdict | HIGH / HIGH / MEDIUM (behavioral parity / extraction / catalog hygiene) |
| Branch | 4 commits ahead of `origin/main` (cleanup), pushed |

### Two behavioral changes worth flagging in next release notes

- **`max_iterations: 0`** now valid in mux-runner (commit `8105845`) — was rejected before, now treated as "unlimited sentinel". Backward-compatible.
- **Fractional numeric CLI flags now error** (commit `aba7369`) — was silent truncation via `parseInt`, now `Number.isInteger` rejects. `--worker-timeout 1.5` → error; users round to `2`.

---

## 3. Current state (verified on disk, 2026-04-29)

| Item | Value |
|---|---|
| God-fn epic tickets | **T0–T19 all Done** (per §2.1) — 16 implementation + 4 hardening shipped on codex backend |
| Working tree | 2 untracked PRD drafts: `deepseek-integration.md`, `large-tier-stall-recovery.md`. `forgecode-pickle-port.md` deleted (obsolete — DeepSeek PRD supersedes the third-backend story). `bmad-inspired-hardening.md` deleted (merged into `citadel.md`). No code-level dirt. |
| Test suite | **3076/3076 pass** (verified 2026-04-29; 4 timing-sensitive tests bumped: scope-resolver-import-walks `HANG_TIMEOUT_MS` 750ms→2500ms, plumbus-frame-analyzer-hang-guard slack 10s→30s) |
| `eslint src/ --max-warnings=-1` | 0 errors, 19 advisory warnings |
| `tsc --noEmit` | clean |
| Latest release (prose) | **v1.59.1** (codex isolation fix; the unblocker for the god-fn epic resume) |
| Anatomy-park follow-ups | 59 trap-door fixes landed overnight; 3 small follow-ups queued in `prds/anatomy-park-followups.md` |
| Phase-2 epic | 27 god-functions across 24 files queued in `prds/god-functions-remediation-phase-2.md` (T14 ratchet exposure) |

---

## 4. Resume strategy

Original resume strategies (Options A–D) are obsolete; T0–T19 shipped on codex backend per §2.1.

---

## 5. The 20 tickets (in execution order)

All tickets shipped via the 2026-04-28/29 codex run, see §2.1.

| Order | ID | Title | Tier | Min new tests | Status |
|---|---|---|---|---|---|
| 10 | `6f3e3f01` | T0 — Pre-refactor scaffolding **[GATE]** | medium | 0 | **Done** ✅ |
| 20 | `f068af3f` | T1 — Split `_emitDot` (6 topology helpers, 2 post-passes inline) | large | 8 | **Done** ✅ |
| 30 | `53caa9a4` | T2 — Split `mux-runner main` (outer loop only) | large | 4 | **Done** ✅ |
| 40 | `2b4b0501` | T3 — Split `microverse-runner main` | large | 3 | **Done** ✅ |
| 50 | `626cd1d5` | T4 — Split `spawn-morty main` | large | 4 | **Done** ✅ |
| 60 | `5059df9a` | T5 — Split `stop-hook main` (8 token detectors) | large | 9 | **Done** ✅ |
| 70 | `16efc5dc` | T6 — Split `spawn-refinement-team main` | medium | 1 | **Done** ✅ |
| 80 | `7aa55af1` | T7 — Split `pipeline-runner main` (PhaseConfig dispatch) | medium | 1 | **Done** ✅ |
| 90 | `f5ac5de1` | T8 — Split `setup main` | medium | 3 | **Done** ✅ |
| 100 | `a6c9c59b` | T9 — Split `jar-runner main` | medium | 5 | **Done** ✅ |
| 110 | `e54eebf6` | T10 — Split `build()` | small | 3 | **Done** ✅ |
| 120 | `e2e6e1cc` | T11 — Split `fromSpec()` | small | 2 | **Done** ✅ |
| 130 | `189df244` | T12 — Split `ensureMonitorWindow` **[TRAP DOOR]** | small | 2 | **Done** ✅ |
| 140 | `bdfb528b` | T13 — Split `findImporters` **[TRAP DOOR]** | small | 4 | **Done** ✅ |
| 150 | `5fa8759a` | T14 — Epic closer (ESLint→error, single bump, smoke) | trivial | 0 | **Done** ✅ |
| 160 | `e5e73494` | T15 — Wire (Library variant) | medium | 0 | **Done** ✅ |
| 170 | `24cd1805` | T16 — Harden — code quality of refactor diff | large | varies | **Done** ✅ |
| 180 | `9dbd0bfd` | T17 — Audit — data flow integrity | large | varies | **Done** ✅ |
| 190 | `d6e98b45` | T18 — Harden — test quality | large | varies | **Done** ✅ |
| 200 | `7be94584` | T19 — Audit — cross-reference consistency | medium | 0 | **Done** ✅ |

Total minimum new tests from T1–T14: **49**. Hardening tickets added more as findings demanded.

Per-ticket details: `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/<hash>/linear_ticket_<hash>.md`.

---

## 6. Cross-cutting rules (from refined PRD Approach §1–§12)

These apply to every PR in the epic — keep them in mind during code review:

1. **Atomic PRs** — one ticket per PR.
2. **Full gate per PR**: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (plus the 3 hygiene tests fire automatically).
3. **Same-file rebase rule** — T1, T10, T11 all touch `dot-builder.ts` (non-overlapping line ranges; rebase-before-review, not strict numeric order).
4. **Test placement** — unit tests in `extension/tests/`; integration in `extension/tests/integration/`. Both append to `package.json:13`.
5. **`package.json:13` append-at-end protocol** — alphabetize once at T14, never per-PR.
6. **Single version bump at T14** — per-PR commits use `refactor(god-fn):` without bumps. Target version reset (see §5 above).
7. **Fixture lockdown** — refactor PRs cannot modify fixtures inline; mid-epic fixture updates are separate `fixture-update`-labeled PRs.
8. **Helper-signature spec rule** — every helper signature pre-declared in ticket body; discriminated unions over booleans; no mutable-ref side-effects.
9. **Trap-door preservation** — T12 must NOT touch `displayMacNotification` (sibling at `pickle-utils.ts:893+`); T13 helpers stay PRIVATE to `scope-resolver.ts`.
10. **Rollback discipline** — each PR independently revertible.
11. **Reviewer rotation** — single reviewer, ≤24h SLA.
12. **Cohesion > raw line count** — files may grow 5–15% from helper boilerplate; that's fine.

---

## 7. Open questions / pre-implementation gates (resolved)

- **Reviewer assignment** — N/A — codex backend ran autonomously.
- **Branch strategy** — Continued on main per-PR; resolved by execution.
- **Backend choice for T1** — Codex shipped T1 in 14 min (post v1.59.1 fixes).
- **Codex large-tier circuit-breaker tuning** — Pursued separately as `prds/large-tier-stall-recovery.md`.

---

## 8. Bug-class observations (record for future codex prompt design)

Codex backend exhibits a consistent class of failures we hit five times today. Each is now mitigated, but the pattern is worth documenting for future prompt authors:

1. **Codex is a literalist.** Any "ONLY"/"NEVER" rule is read absolutely. Don't write rules whose plain reading contradicts later steps in the same prompt.
2. **Codex bleeds context across nearby instructions.** If `pickle.md` (manager) and `send-to-morty.md` (worker) both define completion tokens and the worker has both in its addDirs, codex can use the wrong one. Mitigation: per-context forbidden lists, runtime token scrubbing (v1.56.3).
3. **Codex confuses scope levels.** Per-ticket completion vs epic completion both look like "I finished" to codex. Mitigation: structural recovery in mux-runner (v1.56.4) — never trust the model's claim of "epic done" without verifying ticket statuses.
4. **Codex stalls on large refactors.** Iteration budgets sized for "implement one helper extraction" don't cover "implement six". Mitigation: tier-aware circuit-breaker budgets (deferred), or hand-do large tickets.
5. **Codex tests are load-fragile.** Wall-clock-bounded tests with `{ timeout: 15_000 }` flake when codex runs them concurrent with its own tool calls. Mitigation: 3–5x budget bumps in v1.56.2.

---

## 9. Quick reference

```
Pipeline session dir:    ~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/   (T0/T1 era; superseded)
Note:                    the post-T19 anatomy-park overnight run was a separate session — see §2.1
Refined PRD (committed): prds/god-functions-remediation.md (SHA 1658d81)
Refinement summary:      $SESSION_ROOT/refinement_summary.md
Per-ticket files:        $SESSION_ROOT/<hash>/linear_ticket_<hash>.md
Pipeline config:         $SESSION_ROOT/pipeline.json
Latest release:          v1.59.1 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.59.1
```
