# MASTER_PLAN — God Function Remediation

**Last updated**: 2026-04-25 (end of day)
**Status**: Pipeline paused mid-T0 implement phase after SIGHUP from concurrent pickle session. State recoverable.

---

## 1. PRDs

| Path | Status | SHA |
|---|---|---|
| `prds/god-functions-remediation.md` | Refined (3-cycle / 3-analyst team) | `1658d81` |
| (Original, pre-refinement)            | Committed earlier in the day        | `b535e71` |

The refined PRD includes: corrected line ranges, T0 prelude + T14 closer, goal-level 200 LOC carve-outs, 8-token enumeration, T1 post-pass invariants, T7 dry-run replacement (test seam, NO `--dry-run`), T2 scope clarification (`runIteration` already extracted), per-ticket frontmatter, fixture lockdown protocol, helper-signature spec rule, trap-door preservation, and a 17-row Risks table.

Pre-refinement preserved at `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/prd.md`.

---

## 2. What we did today

1. **Audited** `extension/src/` with 4 parallel Explore agents → identified **13 god functions** across 11 files (worst: `_emitDot` at 905 LOC; `mux-runner main` at 460 LOC, 66 branches).
2. **Drafted** the initial PRD (13 atomic tickets + epic AC + risks).
3. **Refined** via `/pickle-refine-prd` → 3 cycles × 3 analysts (requirements / codebase / risk-scope) → all 9 succeeded → 49 P0/P1 findings adopted.
4. **Decomposed** into **20 atomic tickets** with frontmatter (priority, complexity_tier, min_new_tests, fixture_dependencies, file_dependencies, trap_door_risk, signature_spec):
   - **T0** (gate): pre-refactor scaffolding — fixtures, ESLint flat-config carve-outs, feasibility proof, baseline doc, smoke script
   - **T1–T13**: one extraction per god function (with corrections from refinement: line ranges, post-pass invariants, scope freezes)
   - **T14** (closer): promote ESLint to `error`, alphabetize `package.json:13`, single `1.54.2 → 1.55.0` bump, run deployed-hooks smoke
   - **T15**: wire (Library variant)
   - **+4 hardening tickets**: code quality, data flow audit, test quality, cross-reference audit
5. **Launched** the full pipeline (`/pickle-pipeline --backend codex`) — codex backend on all three phases (build → anatomy-park → szechuan-sauce).
6. **Pipeline ran for ~7.5 minutes** on T0 — completed research + plan phases, stopped before implement when a concurrent pickle session sent SIGHUP at 11:01:47 (timestamp matches new tmux session creation).

---

## 3. Current state (verified on disk)

| Item | Value |
|---|---|
| Session root | `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/` |
| `state.json`: active | `false` |
| `state.json`: step | `research` |
| `state.json`: current_ticket | `6f3e3f01` (T0) |
| `pipeline-status.json` | `cancelled` (status field) |
| `pipeline-cancel` sentinel | exists, contents: `SIGHUP` |
| T0 artifacts | `research_2026-04-25.md` (9.2K), `plan_2026-04-25.md` (5.7K), `worker_session_77275.log` (701K) |
| Source tree | clean — `git status` shows no in-flight refactor edits; T0 had not yet entered implement phase |
| tmux | `pipeline-9152e64b` is dead. `pickle-49a70650` (your separate attractor epic) is alive. |

---

## 4. How to resume tomorrow

### Option A: continue the existing run (cheapest — research/plan already paid for)

```bash
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b

# 1. Clear cancellation signals
rm "$SESSION_ROOT/pipeline-cancel"

# 2. Reset pipeline status (the runner overwrites this on next start, but be tidy)
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" active true "$SESSION_ROOT"

# 3. Re-create the tmux session (do NOT call setup.js again — it was the
#    session-map writer that triggered the cross-session SIGHUP last time)
tmux new-session -d -s pipeline-9152e64b -c /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude

# 4. Relaunch the runner
tmux send-keys -t pipeline-9152e64b:0 \
  "node \$HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js $SESSION_ROOT; read" Enter

# 5. Attach to monitor
tmux attach -t pipeline-9152e64b
```

The runner will see existing `pipeline.json` (phases, target, codex backend) and resume PHASE 1/3 PICKLE on T0. Mux-runner reads state.json — since research + plan artifacts already exist on disk, it should advance directly to the implement phase.

**Cross-session safety**: if your attractor pickle session is still running (`pickle-49a70650`), avoid invoking `setup.js --tmux` in either session simultaneously — that's the suspected SIGHUP trigger. Pause attractor work briefly during step 3 above to be safe.

### Option B: hand off T0 manually (if you want to inspect/edit before resuming)

T0 is scaffold-only (no source-logic changes). You can:
1. Read `$SESSION_ROOT/6f3e3f01/research_2026-04-25.md` and `plan_2026-04-25.md`.
2. Implement the plan by hand (it's ~12 fixture files + 1 ESLint append + 1 smoke script).
3. Mark T0 done in its frontmatter (`status: Done`) and advance `current_ticket` to `f068af3f` (T1).
4. Restart pipeline at T1 via Option A.

### Option C: full restart (NOT recommended — discards the 7.5 min of T0 thinking)

Don't do this. T0's research + plan are good and save real time on T1's same-file rebase coordination.

---

## 5. The 20 tickets (in execution order)

| Order | ID | Title | Tier | Min new tests |
|---|---|---|---|---|
| 10 | `6f3e3f01` | T0 — Pre-refactor scaffolding (fixtures, ESLint carve-outs, feasibility) **[GATE]** | medium | 0 |
| 20 | `f068af3f` | T1 — Split `_emitDot` (6 topology helpers, 2 post-passes inline) | large | 8 |
| 30 | `53caa9a4` | T2 — Split `mux-runner main` (outer loop only) | large | 4 |
| 40 | `2b4b0501` | T3 — Split `microverse-runner main` (200 LOC carve-out) | large | 3 |
| 50 | `626cd1d5` | T4 — Split `spawn-morty main` (`finalize` stays nested closure) | large | 4 |
| 60 | `5059df9a` | T5 — Split `stop-hook main` (8 token detectors + alias-equivalence) | large | 9 |
| 70 | `16efc5dc` | T6 — Split `spawn-refinement-team main` | medium | 1 |
| 80 | `7aa55af1` | T7 — Split `pipeline-runner main` (PhaseConfig dispatch, NO `--dry-run`) | medium | 1 |
| 90 | `f5ac5de1` | T8 — Split `setup main` (NEW `tests/setup.test.js`) | medium | 3 |
| 100 | `a6c9c59b` | T9 — Split `jar-runner main` (line range corrected; tier promoted) | medium | 5 |
| 110 | `e54eebf6` | T10 — Split `build()` | small | 3 |
| 120 | `e2e6e1cc` | T11 — Split `fromSpec()` | small | 2 |
| 130 | `189df244` | T12 — Split `ensureMonitorWindow` **[TRAP DOOR]** | small | 2 |
| 140 | `bdfb528b` | T13 — Split `findImporters` **[TRAP DOOR]** | small | 4 |
| 150 | `5fa8759a` | T14 — Epic closer (ESLint→error, single 1.55.0 bump, smoke) | trivial | 0 |
| 160 | `e5e73494` | T15 — Wire (Library variant) | medium | 0 |
| 170 | `24cd1805` | Harden — code quality of refactor diff | large | varies |
| 180 | `9dbd0bfd` | Audit — data flow integrity | large | varies |
| 190 | `d6e98b45` | Harden — test quality | large | varies |
| 200 | `7be94584` | Audit — cross-reference consistency | medium | 0 |

Total minimum new tests from T0–T14: **49**. Hardening tickets add more as findings demand.

Per-ticket details: `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/<hash>/linear_ticket_<hash>.md`.

---

## 6. Cross-cutting rules (from refined PRD Approach §1–§12)

These apply to every PR in the epic — keep them in mind during code review:

1. **Atomic PRs** — one ticket per PR.
2. **Full gate per PR**: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (plus the 3 hygiene tests fire automatically).
3. **Same-file rebase rule** — T1, T10, T11 all touch `dot-builder.ts` (non-overlapping line ranges; rebase-before-review, not strict numeric order).
4. **Test placement** — unit tests in `extension/tests/`; integration in `extension/tests/integration/`. Both append to `package.json:13`.
5. **`package.json:13` append-at-end protocol** — alphabetize once at T14, never per-PR.
6. **Single version bump at T14** (`1.54.2 → 1.55.0`) — per-PR commits use `refactor(god-fn):` without bumps.
7. **Fixture lockdown** — refactor PRs cannot modify fixtures inline; mid-epic fixture updates are separate `fixture-update`-labeled PRs.
8. **Helper-signature spec rule** — every helper signature pre-declared in ticket body; discriminated unions over booleans; no mutable-ref side-effects.
9. **Trap-door preservation** — T12 must NOT touch `displayMacNotification` (sibling at `pickle-utils.ts:893+`); T13 helpers stay PRIVATE to `scope-resolver.ts`.
10. **Rollback discipline** — each PR independently revertible.
11. **Reviewer rotation** — single reviewer, ≤24h SLA.
12. **Cohesion > raw line count** — files may grow 5–15% from helper boilerplate; that's fine.

---

## 7. Outstanding pre-implementation questions

- **Reviewer assignment** — refined PRD §11 requires a named reviewer with ≤24h SLA. Not assigned yet. Decide before T0 lands.
- **Branch strategy** — refined PRD §6 says all PRs land on `refactor/god-fn-epic` branch with one cumulative `1.55.0` bump at T14. Confirm vs landing each PR directly on `main`.
- **Codex backend timing** — at the moment SIGHUP arrived, T0's worker had completed research/plan in ~7.5 min. Extrapolating to T1 (large tier, 8 new tests) suggests 30-60 min/large ticket on codex. Total epic ETA: ~12-18 hours of pipeline time. Run during low-conflict windows (no other pickle sessions).

---

## 8. Quick reference

```
Pipeline session dir:    ~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/
Pre-refinement PRD:      $SESSION_ROOT/prd.md
Refined PRD (committed): prds/god-functions-remediation.md (SHA 1658d81)
Refinement summary:      $SESSION_ROOT/refinement_summary.md
Per-ticket files:        $SESSION_ROOT/<hash>/linear_ticket_<hash>.md
T0 research:             $SESSION_ROOT/6f3e3f01/research_2026-04-25.md
T0 plan:                 $SESSION_ROOT/6f3e3f01/plan_2026-04-25.md
Worker transcript:       $SESSION_ROOT/6f3e3f01/worker_session_77275.log
Pipeline config:         $SESSION_ROOT/pipeline.json
Cancel signal (rm to resume): $SESSION_ROOT/pipeline-cancel
```
