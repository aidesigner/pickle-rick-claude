---
title: P2 — Remove the bare `/pickle` non-tmux build loop; consolidate on `/pickle-tmux` / `/pickle-zellij` / `/pickle-pipeline`; keep `/pickle-refine-prd`
status: Queued (P2)
filed: 2026-05-18
priority: P2
type: deprecation-removal
code: R-PNTR
bundle: B-PNTR
related:
  - prds/p1-szechuan-sauce-judge-etimedout-baseline-measurement.md  # B-SJET-2 (Finding #47) — the bare /pickle in-session loop's stop-hook noise surfaced the issue during B-SJET-2 babysitter run
  - .claude/commands/pickle.md  # the surface to remove
  - .claude/commands/pickle-tmux.md  # the survivor (multi-iteration build loop with true context isolation)
  - .claude/commands/pickle-zellij.md  # parallel Zellij variant — survives
  - .claude/commands/pickle-pipeline.md  # parent orchestrator — survives (already pickle-tmux internally)
  - .claude/commands/pickle-refine-prd.md  # refinement — EXPLICITLY KEPT
---

# R-PNTR — Remove the bare `/pickle` non-tmux build loop

**Author**: operator + pickle-rick autonomous babysitter session, 2026-05-18 PM
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

## Symptom

Running `/pickle` (bare, no `-tmux`/`-zellij`/`-pipeline` suffix) launches the pickle build lifecycle INSIDE the parent claude session via in-process `spawn-morty.js` calls (Legacy Mode) or `Agent` harness primitives (Teams Mode). Both modes share the same structural problem: there is no true `/clear` between iterations, the stop-hook fires every turn in the parent session, and long epics degrade as context accumulates.

Operator-observed during the B-SJET-2 babysitter run on 2026-05-18: 100+ consecutive turns of "Pickle Rick Loop Active (Iteration 1 of 100)" stop-hook blocks while waiting for pipeline halt signals. Stop-hook noise is the surface symptom; the root issue is that in-session loops cannot give the parent claude session a clean exit while the runtime considers the loop "active".

The tmux variants (`/pickle-tmux`, `/pickle-zellij`) do NOT exhibit this — they spawn workers in detached tmux/Zellij panes with hard isolation between iterations, and the parent session can exit cleanly while workers continue.

## Backend-modulated impact

| Surface | Mode | Stop-hook in parent session? | True `/clear` between iterations? | Recommendation |
|---|---|---|---|---|
| `/pickle` (bare, Legacy Mode) | spawn-morty.js inline | YES — blocks every turn until session inactive | NO — context accumulates in parent | REMOVE |
| `/pickle --teams` (Teams Mode) | Agent harness primitives in parent | YES — same loop | NO — Agent calls reuse parent context | REMOVE (migrate to `/pickle-tmux --teams` per § Migration) |
| `/pickle-tmux` | Detached tmux session | NO — parent exits clean | YES — each iteration starts a fresh claude subprocess | KEEP |
| `/pickle-zellij` | Detached Zellij session | NO | YES | KEEP |
| `/pickle-pipeline` | Wraps `/pickle-tmux` internally | NO | YES | KEEP |
| `/pickle-refine-prd` | Detached refinement workers (spawn-refinement-team.js) | NO — parent observes manifest write and exits | N/A (single-pass refinement, not iterative) | KEEP — operator explicitly retained |
| `/pickle-jar-open` | jar-runner.js batch | NO — own runner | YES — batch isolation | KEEP, but rewire prompt source (see § Implementation) |
| `/pickle-retry` | Retries a single ticket | NO | N/A | KEEP |
| `/pickle-microverse` | metric convergence | NO | YES (own loop) | KEEP |

## Root cause

`/pickle` was the original interactive entrypoint. The codebase evolved to spawn detached tmux runners (`/pickle-tmux`, `/pickle-pipeline`) which structurally avoid the stop-hook contention, but the bare `/pickle` surface remained as a "lightweight single-ticket" affordance. In practice:

- Single-ticket invocations are rare; epics are the dominant case, and epics need tmux isolation.
- The bare `/pickle` Legacy Mode and Teams Mode both share the parent claude session's context window. Long epics (8+ tickets) bloat context and trigger compression, degrading worker quality silently.
- The stop-hook (designed to keep the manager loop alive during a tmux run) doubles as a blocker on the parent session, surfacing as 100+ "Pickle Rick Loop Active" reminders when used inline.

Tmux runners run `claude -p <prompt>` as a fresh subprocess per iteration, killing parent-context contamination at every boundary. That's the design intent — `/pickle` undermines it.

## Cost of keeping it

| Metric | Value |
|---|---|
| Stop-hook spam observed 2026-05-18 PM | 100+ blocked turns in a single babysitter session |
| Operator-visible drift (per-iteration context bloat) | not directly measurable; symptom: degraded later iterations |
| Surface-area maintenance | `.claude/commands/pickle.md` is 236 lines, 2 modes, both bug-prone |
| Documentation noise | README + every `pickle-*` skill references `/pickle` as fallback |
| Test surface | `jar-runner.ts:120` hardcodes `~/.claude/commands/pickle.md` as prompt template |

## Scope (what this PRD removes)

1. **Delete `.claude/commands/pickle.md`** (the canonical source).
2. **Stop deploying `~/.claude/commands/pickle.md`** (`install.sh` no longer copies it).
3. **Remove `tmux_mode` opt-out path** in `extension/src/bin/setup.ts:862,1013` so all `setup()` invocations default to tmux. Direct invocation with `--no-tmux` (if present) becomes an explicit hard error.
4. **Migrate `--teams` mode** into `/pickle-tmux --teams` (Teams Mode under tmux). Phase-personas dispatch and `morty-phase-*` subagents stay available; only the parent-session execution path changes.
5. **Rewire `jar-runner.ts:120`** to read `~/.claude/commands/pickle-tmux.md` (or a new `pickle-manager-prompt.md` extracted from the shared subset) as its prompt template.
6. **Update README + every cross-reference** in `.claude/commands/*.md`, `extension/src/bin/*.ts`, `extension/src/services/*.ts`, `docs/*.md`, `prds/*.md`, and `CLAUDE.md` so no live document points at `/pickle` (bare).
7. **Update tests** that exercise bare-`/pickle` paths to drive `/pickle-tmux` instead, OR delete the test if it was covering only the now-removed surface.
8. **Tombstone**: emit `pickle_command_deprecated` activity event when any old invocation route is detected; print a one-line migration message and exit.

## Out of scope

- **`/pickle-refine-prd`** — EXPLICITLY KEPT per operator directive 2026-05-18 PM. Refinement is single-pass, runs in detached spawn-refinement-team.js workers, and does NOT have the stop-hook spam problem.
- **`/pickle-zellij`** — alternative tmux replacement; structurally equivalent; keep.
- **`/pickle-pipeline`** — wraps `/pickle-tmux`; keep.
- **`/pickle-jar-open`** — batch queue with own isolation; keep (rewire prompt source).
- **`/pickle-retry`, `/pickle-microverse`, `/pickle-status`, `/pickle-metrics`, `/pickle-standup`** — utility commands; keep unchanged.
- **`tmux_mode` field on `state.json`** — keep the field for backward-compatibility on existing session resume, but new sessions always write `tmux_mode: true`.

## Atomic ticket scope

### R-PNTR-1 (small, ≤30m) — Delete `.claude/commands/pickle.md`

**Files to modify**:
- Delete `.claude/commands/pickle.md` (the source file).
- Update `install.sh` to skip `pickle.md` in the rsync (if present in install logic).

**Acceptance**:
- `ls .claude/commands/pickle.md` returns nonzero.
- After `bash install.sh`, `~/.claude/commands/pickle.md` is absent (existing file may remain on old systems; install.sh does NOT remove it — operators delete it manually OR install.sh adds a one-shot `rm -f` for that path).

### R-PNTR-2 (medium, ≤2h) — Migrate `--teams` mode into `/pickle-tmux --teams`

**Files to modify**:
- `.claude/commands/pickle-tmux.md` — add `## Phase 3.B — Teams Mode (`--teams`)` section copied from `pickle.md:Phase 3.B` (preserve phase-personas dispatch + Agent harness invocation).
- `extension/src/bin/setup.ts` — `--teams` flag now sets `tmux_mode: true, teams_mode: true` jointly. Bare `--teams` without tmux is rejected with a migration hint.
- `extension/src/bin/mux-runner.ts` — Teams Mode runs inside tmux pane; verify Agent harness primitives work from tmux subprocess context (they should — Agent calls are HTTP, not parent-session bound).

**Acceptance**:
- `/pickle-tmux --teams` launches the Teams Mode lifecycle inside a tmux pane.
- No `/pickle --teams` invocation path remains.

### R-PNTR-3 (small, ≤1h) — Rewire `jar-runner.ts` prompt source

**Files to modify**:
- `extension/src/bin/jar-runner.ts:120` — replace `~/.claude/commands/pickle.md` reference with `~/.claude/commands/pickle-tmux.md` OR extract the shared lifecycle prompt into `.claude/commands/_pickle-manager-prompt.md` (private include) and have both pickle-tmux.md and jar-runner.ts read it.

**Acceptance**:
- `/pickle-jar-open` continues to function unchanged from operator perspective.
- `grep -c "commands/pickle.md" extension/src/bin/jar-runner.ts` = 0.

### R-PNTR-4 (small, ≤1h) — Add deprecation tombstone

**Files to create/modify**:
- `extension/src/bin/pickle-deprecated.ts` (new) — invocation route that prints:
  > `/pickle` is removed. Use `/pickle-tmux <args>` for the build loop, `/pickle-refine-prd <args>` for refinement, `/pickle-pipeline <args>` for the full pipeline.
- Wire the route into any CLI / hook surface that previously dispatched to `pickle.md`.
- Emit `pickle_command_deprecated` activity event with `gate_payload: { attempted_invocation: <original args>, suggested_replacement: <command> }`.

**Acceptance**:
- Old invocation paths return a clear migration message + nonzero exit.
- Activity event emitted on every deprecated-route hit.

### R-PNTR-5 (small, ≤1h) — Update README + cross-references

**Files to modify**:
- `README.md` — replace `/pickle` references with `/pickle-tmux`.
- `.claude/commands/*.md` — remove all "or use /pickle for interactive mode" fallback lines (pickle-tmux.md `Step 1` currently says: "Install tmux: `brew install tmux` or `apt install tmux`, or use /pickle for interactive mode." → change to: "Install tmux: `brew install tmux` or `apt install tmux`. tmux is required.").
- `docs/*.md` — sweep for `/pickle ` (with trailing space, to exclude `pickle-*` matches) and migrate.
- `extension/src/services/pickle-utils.ts` — any `composeManagerPromptFromSkill` references to `pickle.md`.
- `CLAUDE.md` (project root + global) — remove "`/pickle` for 1-2 tickets" workflow guidance; replace with: tmux always.

**Acceptance**:
- `grep -rn "\\b/pickle\\b" .claude/ docs/ prds/ extension/src/ README.md CLAUDE.md | grep -v "pickle-\\|pickle\\." | wc -l` = 0 (only `pickle-*` subcommand matches remain).

### R-PNTR-6 (small, ≤1h) — Test migration

**Files to modify**:
- Any test under `extension/tests/` that invokes bare `/pickle` directly or via `setup({ tmuxMode: false })` — migrate to `tmuxMode: true` OR delete the test if it was covering the now-removed surface.

**Acceptance**:
- `cd extension && npm run test:fast && npm run test:integration` exits 0 with no skipped tests citing `/pickle removed`.

## Hardening tickets (2)

### T-HARDEN-PNTR-DOCS (small, ≤30m) — Documentation sweep

- `prds/MASTER_PLAN.md` — update any historical mention of `/pickle` as recommended path.
- `prds/MASTER_PLAN-archive.md` — leave historical narrative untouched (archive is read-only).
- `.claude/skills/*` if any pickle-related skills exist outside `commands/`.

### T-HARDEN-PNTR-CONFORMANCE (small, ≤30m) — Bundle conformance

- Verify `grep -rn "\.claude/commands/pickle\.md\|/pickle\\b"` returns zero hits across live source/docs.
- Confirm `install.sh` does not regress and re-deploy `pickle.md` on next run.
- Run full release-gate audit (per `extension/CLAUDE.md`).

## Closer (1)

### C-PNTR-CLOSER [manager] (small, ≤30m) — Bundle ship

- Bump version patch +1.
- Rebuild compiled JS.
- `bash install.sh` — confirm `~/.claude/commands/pickle.md` deletion (one-shot `rm -f` in install.sh if added by R-PNTR-1).
- Full release-gate audit.
- Commit + push.
- Update `prds/MASTER_PLAN.md` (move B-PNTR from Active Queue → Shipped).
- `gh release create` with notes summarizing the removal + migration guide.

## Acceptance criteria

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-PNTR-01 | `.claude/commands/pickle.md` deleted from source repo. | `git ls-files .claude/commands/pickle.md` empty after bundle. | R-PNTR-1 |
| AC-PNTR-02 | `/pickle-tmux --teams` launches Teams Mode inside tmux; `morty-phase-*` subagents still available. | Integration test launches `/pickle-tmux --teams` against a 3-ticket fixture; asserts tmux pane started + Teams Mode active. | R-PNTR-2 |
| AC-PNTR-03 | `/pickle-jar-open` functional with new prompt source; no reference to `pickle.md` in `jar-runner.ts`. | Grep + integration test against a 2-task jar fixture. | R-PNTR-3 |
| AC-PNTR-04 | Old `/pickle` invocation route prints migration message + emits `pickle_command_deprecated` activity event. | Unit + integration test. | R-PNTR-4 |
| AC-PNTR-05 | No live document references bare `/pickle` (only `pickle-*` subcommands remain). | Grep assertion across `.claude/`, `docs/`, `prds/` (excluding archive), `extension/src/`, `README.md`, `CLAUDE.md`. | R-PNTR-5 |
| AC-PNTR-06 | Test suite exits 0 with no `/pickle removed` skipped tests. | `cd extension && npm run test:fast && npm run test:integration`. | R-PNTR-6 |
| AC-PNTR-07 | Bundle ship: version bumped, install.sh idempotent, gh release published. | git log + gh release view. | C-PNTR-CLOSER |

## Out of scope (explicit)

- Renaming `/pickle-tmux` to `/pickle` for ergonomics — separate UX decision; this PRD only removes the dual-surface confusion.
- Removing `tmux_mode` field from `state.json` schema — leave for backward compat; new sessions always write `true`.
- Killing `--teams` mode entirely — Teams Mode survives under tmux per R-PNTR-2.
- Adding a Zellij variant of Teams Mode — separate PRD if requested.
- `/pickle-refine-prd` — explicitly KEPT.

## Trap doors

- **R-PNTR-1 (file deletion)**: `git ls-files .claude/commands/pickle.md` returns empty after the diff lands.
- **R-PNTR-2 (Teams under tmux)**: integration test for `--teams` mode runs inside a tmux pane fixture; asserts pane created + Agent harness call shape preserved.
- **R-PNTR-3 (jar-runner rewire)**: `grep -c "pickle.md" extension/src/bin/jar-runner.ts` = 0 after diff.
- **R-PNTR-4 (tombstone event)**: `pickle_command_deprecated` event in `VALID_ACTIVITY_EVENTS` registry; schema-conformance test added per R-PDD-oneOf 5-touchpoint pattern.
- **R-PNTR-5 (cross-reference sweep)**: grep assertion in conformance doc enumerates every live file that previously cited `/pickle`.

## Post-validation gaps

1. Verify all third-party / community guides / Anthropic Skill registry references to `/pickle` (out-of-repo) — update if any.
2. Confirm `claude-hud` statusline integration does not depend on `tmux_mode: false` detection.
3. Confirm `/pickle-pipeline --no-refine` still works after the migration (it should — it doesn't touch `/pickle`).
4. Decide whether to ALIAS `/pickle` → `/pickle-tmux` (deprecation soft-redirect) instead of hard-remove. Default in this PRD: hard remove with tombstone migration message. Operator may flip to alias if community usage signals warrant.

## Related findings / bundles

- **B-SJET-2** (in-flight 2026-05-18) — the babysitter run that surfaced the stop-hook spam. NOT a blocker for this bundle.
- **Working Rule 1** — this is a P2 cleanup. Open P1 ceiling (currently B-SSDF + B-QSRC + B-SJET-2 in-flight = 3 at ceiling) is unaffected; this bundle queues behind P1 drain.
- **Phase-personas dispatch (`pickle-agent-teams.md`)** — Teams Mode survives under tmux; no design rollback.

## Bundle sizing

- **Atomic**: R-PNTR-1 through R-PNTR-6 (6 tickets, all small/medium).
- **Hardening**: T-HARDEN-PNTR-DOCS + T-HARDEN-PNTR-CONFORMANCE (2 small).
- **Closer**: C-PNTR-CLOSER (manager, small).
- **Total**: ~9 tickets, ≤8h codex / ≤12h claude.
- Refinement recommended before launch — paths to `jar-runner.ts:120` and the `--teams` mode migration deserve a 3-cycle refinement pass to catch hidden coupling.
