---
title: P1 — Codex manager subprocess executes operator-facing setup.js invocations from skill prompt body
status: Draft
filed: 2026-05-15
priority: P1
type: bug
r_code_prefix: R-CCPM
backend_constraint: any
related:
  - prds/codex-classifier-prompt-leak.md  # R-CCPL (REOPENED P1, Master Plan Finding #1) — Phase 1a-bis successor
  - prds/research-r-ccpl-7fe6da60-2026-05-15.md  # forensic artifact from R-RHGS run
---

# R-CCPM — Codex Manager Prompt Pollution

## Symptom

When `mux-runner.js` spawns the manager subprocess with `--backend codex`, the codex CLI receives the `/pickle.md` skill prompt verbatim as its system prompt. Codex parses the operator-facing `setup.js` invocation examples in that prompt as a task list and EXECUTES them — running `node setup.js --task "..."` itself instead of acting as the manager that calls `spawn-morty.js` for each ticket.

Witnessed in session `2026-05-14-7fe6da60` during the R-RHGS bundle launch:
- Codex manager called `setup.js --task "--resume <SESSION_ROOT>"` (literal echo of `pickle.md` line 19)
- Result: orphan session `2026-05-14-afc7e9df` created
- Result: `state.worker_timeout_seconds` reset from operator-set 2400 → default 1200
- Result: operator forced to switch backend codex → claude mid-pipeline to recover

Same prompt body produces correct manager behavior on the claude backend — claude calls `spawn-morty.js` directly without ever touching `setup.js`. The bug is codex-specific.

## Root cause

The manager spawn payload is loaded from `pickle.md` verbatim — the same artifact that operators read in the `/pickle` slash command. Operator-facing tutorial code blocks like:

> ```bash
> node "$HOME/.claude/pickle-rick/extension/bin/setup.js" <FLAGS> --task "<TASK_TEXT>"
> ```

are documentation when claude reads them and orders when codex reads them. Codex lacks the "this is operator docs, you are the manager" framing that claude infers from training.

R-PIWG-2's Git Boundary Rules block addresses destructive *git* commands but does NOT cover the broader category of "operator-facing CLI invocations the manager subprocess should not run."

## Functional requirements

- **FR-1**: Manager-spawn payload sent to codex MUST include an explicit "you are the manager subprocess" role-framing header that supersedes the operator-facing skill body.
- **FR-2**: The manager-spawn payload MUST NOT include verbatim `setup.js --task` invocation examples that codex could mistake for orders. Replace with a brief note: "setup.js has already been called by the operator; do NOT invoke it again."
- **FR-3**: Runtime guard: when the codex manager subprocess emits a tool-call attempting `node setup.js` (any args), `mux-runner.ts` MUST log `codex_manager_self_bootstrap_attempted` (created by R-CCPM-5) activity event and surface the misbehavior in stderr. This is a defensive measure independent of FR-1/FR-2.
- **FR-4**: Orphan-session reaper: if a session is created under `~/.local/share/pickle-rick/sessions/<date>-<hash>/` while a parent session in the same data root is active, the parent's next iteration MUST detect the orphan and log `orphan_session_detected` with the orphan path. Auto-cleanup is out of scope (manual `rm` by operator after verification).
- **FR-5**: worker_timeout protection: when `state.worker_timeout_seconds` drops below the session's launch-time value during a single pipeline run, the runner MUST restore it on the next iteration boundary and emit `state_worker_timeout_drift_corrected`.

## Acceptance criteria

- **AC-CCPM-1.a** — Codex manager spawn payload includes a "Manager Role Framing" header that begins with `"You are the MANAGER subprocess for this Pickle Rick session."` and ends with `"Do NOT invoke \`setup.js\` — it has already been called."` — Verify: `grep -c "Manager Role Framing" $HOME/.claude/pickle-rick/extension/bin/spawn-morty.js` returns ≥1 OR the equivalent string appears in the codex spawn invocation site — Type: lint
- **AC-CCPM-1.b** — Operator-facing setup.js invocation examples (lines containing `setup.js --task "..."` outside the Manager Role Framing context) are stripped from the codex-mode manager payload — Verify: `extension/tests/codex-manager-prompt-no-setup-examples.test.js` constructs the codex manager spawn payload and asserts zero matches for `/setup\.js\s+--task/` outside the Role Framing region — Type: test
- **AC-CCPM-2.a** — Runtime guard: when `mux-runner.ts` observes a codex tool-call invoking `node setup.js`, it logs `codex_manager_self_bootstrap_attempted` with payload `{ ticket: state.current_ticket || null, attempted_argv: string[], iteration: int }` — Verify: `extension/tests/integration/codex-manager-self-bootstrap-guard.test.js` injects a synthetic tool-call stream and asserts the event fires — Type: test
- **AC-CCPM-3.a** — On the next iteration boundary, the runner scans `~/.local/share/pickle-rick/sessions/` for sessions created AFTER the current session's `state.started_at` AND whose `state.current_sessions.json` entry maps to a non-existent cwd. Each match emits `orphan_session_detected` with `{ orphan_session_path, orphan_started_at, parent_session: session_hash }` — Verify: integration test creates a synthetic orphan and asserts detection event — Type: test
- **AC-CCPM-4.a** — `state.worker_timeout_seconds` drift correction: track `state.worker_timeout_launch_value` at setup time. If runtime value ever drops below launch value, restore on next iteration and emit `state_worker_timeout_drift_corrected` with `{ launch_value, observed_value, restored_to }` — Verify: integration test bumps worker_timeout, simulates drift, asserts restoration — Type: test
- **AC-CCPM-5.a** — Trap door pinned at `extension/src/bin/CLAUDE.md` documenting the H-D root cause + the FR-1/FR-2/FR-3 contract. PATTERN_SHAPE: codex manager spawn payload MUST NOT contain `\bsetup\.js\s+--task\b` outside a Role Framing comment block.
- **AC-CCPM-5.b** — Three new activity events — `codex_manager_self_bootstrap_attempted` (created by R-CCPM-5), `orphan_session_detected` (created by R-CCPM-5), and `state_worker_timeout_drift_corrected` (created by R-CCPM-5) — registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json` `oneOf` + `EVENT_CASES` + `EVENT_NAMES` + `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION` (full triangle).
- **AC-CCPM-Release** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast && npm run test:integration` exits 0.

## Implementation notes

**Files likely touched:**
- `extension/src/bin/spawn-morty.ts` (or wherever the codex manager invocation is built — possibly `mux-runner.ts` itself for tmux_mode codex spawns)
- `extension/src/services/backend-spawn.ts` (codex spawn envelope construction)
- `extension/src/bin/mux-runner.ts` (runtime guard on codex tool-call stream)
- `extension/src/bin/setup.ts` (worker_timeout_launch_value persistence)
- `extension/src/types/index.ts` (VALID_ACTIVITY_EVENTS + State schema extension)
- `extension/src/types/activity-events.schema.json` (3 new event definitions + oneOf)
- `extension/src/bin/CLAUDE.md` (trap door)
- 4 new tests + payload-test EVENT_CASES rows

**Bundle composition:** Single-PRD bundle, 5 tickets (R-CCPM-1..5). Each ticket is atomic (one AC family per ticket). Suggested ordering:
1. R-CCPM-1 (Manager Role Framing + payload de-pollution)
2. R-CCPM-2 (Runtime guard against codex `setup.js` tool-calls)
3. R-CCPM-3 (Orphan session detection)
4. R-CCPM-4 (worker_timeout drift correction)
5. R-CCPM-5 (Trap door + event triangle conformance)

**Backend:** Run on **claude backend** (codex is the target being fixed; using it during the build would create chicken-and-egg). After the bundle ships and is deployed via `bash install.sh`, retest with codex backend on a small follow-up PRD.

## Pre-flight risks

- **R-CCPL classifier interaction**: R-CCPL's v1.74.0 classifier fix scrubs the `EPIC_COMPLETED` token from the manager prompt. R-CCPM-1 may additionally scrub setup.js invocations from the same manager prompt. Make sure both scrub paths compose cleanly — likely both consume the same `pickle.md` source and apply post-load transformations.
- **Operator UX preservation**: The operator-facing `/pickle` slash command still needs the setup.js examples in `pickle.md` for documentation purposes. R-CCPM-1 transforms or wraps them only when loading into the manager-spawn payload, not when serving the slash command itself.
- **Test backend constraint**: Tests asserting codex manager behavior need to mock the codex tool-call stream (don't spawn real codex during fast-tier). Pattern is established in `extension/tests/mux-runner-classifier.test.js`.

## Out of scope

- Refactoring `pickle.md` to be entirely manager-safe (would lose operator-facing tutorial value). The scrub/wrap happens at spawn-payload-build time, not at file-author time.
- Auto-deleting orphan sessions (AC-CCPM-3.a is detection-only; cleanup remains operator-initiated until safety is proven).
- Fixing R-CCPL classifier prompt-leak (separate concern, already shipped in v1.74.0; this PRD is the H-D successor, not the H-A/H-B/H-C path).

## Bundle-level acceptance criteria

- AC-BUNDLE-01 — Full test gate green: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast && npm run test:integration` exits 0.
- AC-BUNDLE-02 — Trap door pinned + 3 new activity events satisfy the schema/EVENT_CASES/spawn-refinement triangle (covered by AC-CCPM-5).
- AC-BUNDLE-03 — `bash install.sh` deploys cleanly (no parity-check mismatch).
- AC-BUNDLE-04 — Post-ship validation pipeline: launch any small PRD with `--backend codex` and confirm the codex manager calls `spawn-morty.js` only (not `setup.js`) and no orphan session appears.

## Why P1

- Direct operator-visible damage: every codex pipeline launch loses ~10-30min to orphan-cleanup + backend-fallback.
- Recurrence is deterministic on every fresh codex pipeline that uses the `/pickle.md` skill (not flaky).
- Forces operators to choose claude backend, defeating the codex-first design goal.
- The fix is local to the spawn payload (no operator workflow change, no cross-cutting refactor).

## NOT in Scope (deferred to later bundles)

- Worktree isolation R-PIWG-3 (deferred from R-RHGS; durable concurrent-git fix).
- LLM-judge stabilization R-PRJT/R-SLLJ/R-MBLE (Master Plan Findings #16/#17/#26).
- mux-runner claude max-turns relaunch R-MMTR (Master Plan Finding #19).
