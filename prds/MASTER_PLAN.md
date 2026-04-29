# MASTER_PLAN — God Function Remediation

**Last updated**: 2026-04-28 (post convergence-toolchain-gates v1.58.0 release)
**Status**: God-fn epic T0 complete; T1 still paused, stashed for later resume. Convergence-toolchain-gates **shipped v1.58.0** — full 3-phase pipeline (build + anatomy-park + szechuan-sauce) on codex backend, 25 tickets + 78 anatomy-park findings + szechuan god-fn decomposition, all gates green, 2889/2889 tests pass. Cronenberg meta-router shipped earlier as v1.57.0. Stall-recovery PRD still drafted, not started.

---

## 1. PRDs

| Path | Status | SHA |
|---|---|---|
| `prds/god-functions-remediation.md` | Refined (3-cycle / 3-analyst team). T0 done; T1+ paused. | `1658d81` |
| (Original, pre-refinement)            | Committed earlier in the day        | `b535e71` |
| `prds/codex-classifier-prompt-leak.md` | **Shipped** (2026-04-26) | `a48097b`, `3bc9bd2`, `a90ed73`, `4b1f784`, `17f6b03` |
| `prds/convergence-toolchain-gates.md` | **Shipped v1.58.0** (2026-04-28) — full 3-phase pipeline: 25 atomic tickets (gate primitive + finalize-gate orchestrator + remediator brief-prep + skill prompt updates + LOA-618 fixture) → anatomy-park surfaced 78 cross-cutting bugs, all fixed (incl. metrics worktree/nested-repo, runner ownership pid stamps, orphan-tmp recovery, hook fallback routing) → szechuan-sauce decomposed god-fns. Phase 1 ran on claude (rate-limited at 5h), phases 2/3 ran on codex (5–10× faster). 122 commits, +19,597/-1,921 LOC. iteration_regressions counter held at 0 throughout — gate didn't false-flag itself. | tag `v1.58.0` |
| `prds/large-tier-stall-recovery.md` | Draft (2026-04-27) — 3 atomic tickets (tier-aware circuit-breaker budget, worker resume detection, e2e verification). Targets god-fn T1 codex stall. **NOT started.** Planned v1.57.0 release tag was claimed by cronenberg — retarget to v1.58.0 when picked up. | uncommitted |
| `prds/deepseek-integration.md` | Draft (2026-04-27) — third backend `'deepseek'` riding `claude` CLI via DeepSeek's Anthropic-compat shim; honest identity in state/logs/metrics; ~230 LOC. **NOT started.** | uncommitted |
| `prds/bmad-inspired-hardening.md` | Draft (user authored, 2026-04-2x) — BMAD-inspired hardening practices for the engineering loop. **NOT started.** | uncommitted |
| `prds/citadel.md` | Draft (2026-04-27) — new `/citadel` command (post-implementation conformance audit: PRD ↔ implementation invariants, AC coverage, sibling guard parity, rule-set invariants, trap-door enforcement) **plus** matched cross-skill updates to `/pickle-refine-prd` (T20 AC-shape collapse-or-justify), anatomy-park (T21 phase-2.5 pattern-replay sweep + `pattern_shape` schema), and szechuan-sauce (T22 diff-hygiene gate, T23 trap-door-as-test sweep). Driven by LOA-618 post-mortem: 7 issues that reached code review, 6 of which now have a primary owner + safety net. Reviewed by 5-agent team and rescoped twice (Venn-overlap model: anatomy-park ∩ citadel ∩ szechuan-sauce, slight overlap intentional). 16 core tasks (T0–T16) + 4 cross-skill tasks (T20–T23) + cronenberg integration (T13.5). 17 ACs (`AC-CIT-01..17`). **NOT started.** | uncommitted |
| `prds/god-functions-remediation-phase-2.md` | Draft (2026-04-28) — follow-up epic for the 27 pre-existing god-functions across 24 files exposed by T14's ESLint ratchet (Phase 1 closer). Each function has a scoped `// eslint-disable-next-line` carve-out from commit `7bf3263`; this epic refactors them and removes the carve-outs. Worst offender: `runGate` in `convergence-gate.ts` (cyclomatic 65, 305 lines). 6 ACs, ~20 atomic tickets sketched. **NOT started.** | committed in this branch |
| `prds/watcher-pane-recovery.md` | Draft (2026-04-28) — single-fix PRD for monitor-window watcher panes that exit on `state.active: false` and don't respawn when mux-runner relaunch brings the session back live. Discovered during the god-fn epic codex run; only `monitor.js` (dashboard) survived a relaunch, the other three watcher panes stayed at `zsh` prompts. 7 ACs, 4 atomic tickets. **NOT started.** | committed in this branch |
| `prds/anatomy-park-followups.md` | Draft (2026-04-29) — 3 small follow-ups identified by the 5-agent review of the 59-commit anatomy-park overnight run: (T1) trap-door catalog hygiene — split 3 oversized entries (pickle-utils.ts at 4042 chars), standardize ENFORCE clauses to test filenames; (T2) `recoverable-json.test.js` — add dedicated unit tests for the extracted module (currently only via state-manager + caller tests); (T3) extend codex-manager relaunch (`bf4a002`) to `microverse-runner.ts` — anatomy-park hit the same 4h subprocess-error wall that mux-runner now handles. 12 ACs, 3 atomic tickets. **NOT started.** | committed in this branch |
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

## 3. Current state (verified on disk, 2026-04-27 13:21Z)

| Item | Value |
|---|---|
| Session root | `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/` |
| `state.json: active` | `false` |
| `state.json: step` | `research` |
| `state.json: current_ticket` | `f068af3f` (T1) |
| `state.json: command_template` | `pickle.md` ✅ (v1.56.0 fix held) |
| `state.json: false_epic_completed_count` | `18` (proof v1.56.4 fired and recovered) |
| `pipeline-status.json` | `failed` (circuit-breaker exit; not relaunch-blocking) |
| `pipeline-cancel` sentinel | absent |
| Working tree | 5 untracked PRD drafts (`bmad-inspired-hardening`, `citadel`, `convergence-toolchain-gates`, `deepseek-integration`, `large-tier-stall-recovery`) + this `MASTER_PLAN.md` modification. No code-level dirt. |
| Source tree | T0 deliverables committed; no in-flight T1 edits |
| tmux | `pipeline-9152e64b` is dead. |
| Tickets done | 1 of 20 (T0 / `6f3e3f01`) |
| Tickets in progress | 0 (T1 reset to Todo) |
| Tickets pending | 19 |

T1 has research/plan artifacts on disk from the failed run (5 worker-session logs, plan/research markdown). Resuming T1 will reuse those if the prompt instructs, or restart fresh if cleared.

---

## 4. Resume strategy

### Option A: hand-execute T1 with claude backend (recommended)

T1 is mechanical extraction (split `_emitDot` into 6 topology helpers + 2 inline post-passes per the refined PRD). Codex stalled on it because of complexity, not capability gaps. Claude with full file context will burn through it cleanly in 30–60 minutes.

```bash
# Edit state.json directly OR launch /pickle on T1's ticket file with --backend claude
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b
# Switch backend for one ticket
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" backend claude "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" start_time_epoch "$(date +%s)" "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" iteration 0 "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" current_ticket f068af3f "$SESSION_ROOT"
rm -f "$SESSION_ROOT/pipeline-cancel"

tmux new-session -d -s pipeline-9152e64b -c /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
tmux send-keys -t pipeline-9152e64b:0 \
  "node \$HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js $SESSION_ROOT; read" Enter
tmux attach -t pipeline-9152e64b
```

After T1 lands, switch `state.backend` back to `codex` for T2+ if desired — most remaining tickets are smaller-scope splits where codex performed acceptably.

### Option B: bump circuit-breaker budget for large-tier tickets, retry codex on T1

Currently 5 iterations × ~10 min = 50 min before stall. T1 needs more. Code change in `mux-runner.ts` to read `linear_ticket_*.md` frontmatter `complexity_tier` and use a tier-keyed budget (`large` = 12, `medium` = 6, `small` = 4). Modest scope, would land as v1.56.5. Then retry codex.

### Option C: pure hand-execution for T1 by user (no agent)

T1 is the kind of work a senior dev does in 90 minutes. The refined PRD has the helper signatures spelled out. If the agent loops are getting tedious, this is the fastest path to "T1 done, resume codex on T2."

Whichever option, **T1's research/plan artifacts at `$SESSION_ROOT/f068af3f/` are good context** — codex did real analysis there even if it didn't commit code. Worth reading before starting.

### Option D: full restart from T0 (NOT recommended)

T0 is committed. There's nothing to redo there. The session is genuinely past T0.

---

## 5. The 20 tickets (in execution order)

| Order | ID | Title | Tier | Min new tests | Status |
|---|---|---|---|---|---|
| 10 | `6f3e3f01` | T0 — Pre-refactor scaffolding **[GATE]** | medium | 0 | **Done** ✅ |
| 20 | `f068af3f` | T1 — Split `_emitDot` (6 topology helpers, 2 post-passes inline) | large | 8 | Todo (research/plan staged) |
| 30 | `53caa9a4` | T2 — Split `mux-runner main` (outer loop only) | large | 4 | Todo |
| 40 | `2b4b0501` | T3 — Split `microverse-runner main` | large | 3 | Todo |
| 50 | `626cd1d5` | T4 — Split `spawn-morty main` | large | 4 | Todo |
| 60 | `5059df9a` | T5 — Split `stop-hook main` (8 token detectors) | large | 9 | Todo |
| 70 | `16efc5dc` | T6 — Split `spawn-refinement-team main` | medium | 1 | Todo |
| 80 | `7aa55af1` | T7 — Split `pipeline-runner main` (PhaseConfig dispatch) | medium | 1 | Todo |
| 90 | `f5ac5de1` | T8 — Split `setup main` | medium | 3 | Todo |
| 100 | `a6c9c59b` | T9 — Split `jar-runner main` | medium | 5 | Todo |
| 110 | `e54eebf6` | T10 — Split `build()` | small | 3 | Todo |
| 120 | `e2e6e1cc` | T11 — Split `fromSpec()` | small | 2 | Todo |
| 130 | `189df244` | T12 — Split `ensureMonitorWindow` **[TRAP DOOR]** | small | 2 | Todo |
| 140 | `bdfb528b` | T13 — Split `findImporters` **[TRAP DOOR]** | small | 4 | Todo |
| 150 | `5fa8759a` | T14 — Epic closer (ESLint→error, single 1.55.0 bump, smoke) | trivial | 0 | Todo |
| 160 | `e5e73494` | T15 — Wire (Library variant) | medium | 0 | Todo |
| 170 | `24cd1805` | Harden — code quality of refactor diff | large | varies | Todo |
| 180 | `9dbd0bfd` | Audit — data flow integrity | large | varies | Todo |
| 190 | `d6e98b45` | Harden — test quality | large | varies | Todo |
| 200 | `7be94584` | Audit — cross-reference consistency | medium | 0 | Todo |

T14's planned bump target (`1.54.2 → 1.55.0`) is now obsolete — we've already shipped `1.55.0` for an unrelated agent-teams feature (commit `a4662df`), `1.56.4` for this session's PRC fixes, and `1.57.0` for the cronenberg meta-router (commit `711f92c`). Reset T14's bump to whatever the current latest is at the time T14 lands.

Total minimum new tests from T1–T14: **49**. Hardening tickets add more as findings demand.

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

## 7. Open questions / pre-implementation gates

- **Reviewer assignment** — refined PRD §11 requires a named reviewer with ≤24h SLA. Not assigned yet. Decide before T1 lands.
- **Branch strategy** — refined PRD §6 originally called for `refactor/god-fn-epic` branch with single bump at T14. We've already landed multiple commits to `main` directly (release line v1.56.0–v1.56.4). Decide: continue on main per-PR, or carve out a feature branch from current HEAD for T1+? Either works.
- **Backend choice for T1** — see Resume Strategy §4 above. Default recommendation: claude for T1, codex for T2+.
- **Codex large-tier circuit-breaker tuning** — if pursuing Option B in §4, this is the implementation work.

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
Pipeline session dir:    ~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/
Refined PRD (committed): prds/god-functions-remediation.md (SHA 1658d81)
Refinement summary:      $SESSION_ROOT/refinement_summary.md
Per-ticket files:        $SESSION_ROOT/<hash>/linear_ticket_<hash>.md
T1 staged research:      $SESSION_ROOT/f068af3f/research_2026-04-26.md
T1 staged plan:          $SESSION_ROOT/f068af3f/plan_2026-04-26.md
Pipeline config:         $SESSION_ROOT/pipeline.json
Cancel signal (rm to resume): $SESSION_ROOT/pipeline-cancel (currently absent)
Latest release:          v1.57.0 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.57.0
```
