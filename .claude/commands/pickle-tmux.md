Launch a Pickle Rick epic in tmux with true context clearing between iterations — best for large epics with 8+ tasks.

# /pickle-tmux

<!-- BEGIN GIT_BOUNDARY_RULES -->
## Git Boundary Rules (READ FIRST — applies to every step)

You are pinned to the current branch. The pipeline owns branch state.

PROHIBITED commands (worker MUST NOT run):
- branch / HEAD mutation: `git checkout <ref>`, `git switch`, `git reset --hard`, `git reset`
- remote interaction: `git pull`, `git push`, `git fetch --prune`
- working-tree displacement: `git stash`, `git stash push`
- history rewriting: `git rebase`, `git commit --amend`
- direct `.git/` modification (any tool)

Enforced at runtime by `config-protection.ts` (R-WSRC-GR trap door); attempting a prohibited verb returns `{decision: 'block'}`.

ALLOWED mutating commands:
- `git add <paths>` (only paths inside your ticket's scope)
- `git commit` (with your scope's edits)
- `git restore <paths>` (path-scoped working-tree restore, non-destructive)
- `git restore --source <ref> --staged --worktree <paths>` (path-scoped rollback from a SHA)

To inspect another ref without changing branch state: `git show <ref>:<path>` or `git log <ref>`. If the working tree has unwanted edits from a failed validation, use `git restore` with the exact paths — never the broad sweep.
<!-- END GIT_BOUNDARY_RULES -->


## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux` or `apt install tmux`, or use /pickle for interactive mode." Stop.

## Step 2: Session Setup
Extract flags from `$ARGUMENTS` (`--resume <path>`, `--max-iterations <N>`, `--backend <claude|codex|hermes>`, etc.). Pass flags before `--task`. Task text goes in `--task "..."`.

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux <FLAGS> --task "<TASK_TEXT>"
```
No flags: `setup.js --tmux --task "$ARGUMENTS"`.
Resume example: `setup.js --tmux --resume /sessions/057f0263` (no --task needed).
Flags+task example: `setup.js --tmux --max-iterations 10 --task "refactor auth"`
Backend example: `setup.js --tmux --backend codex --task "refactor auth"` routes worker/manager spawns through `codex exec`; `setup.js --tmux --backend hermes --task "scaffold CLI smoke tests"` routes through `hermes chat -q`. Backend persists in `state.json` and survives resume.
Teams example: `setup.js --tmux --teams --max-parallel 5 --task "refactor auth"` runs **Teams Mode under tmux** (see below). `--teams` is always passed together with `--tmux`; the in-session `/pickle --teams` build loop was removed.

Extract `SESSION_ROOT=<path>` and `working_dir` from output.

## Teams Mode (--teams)

`--teams` runs the build loop with harness-native subagents on a team instead of per-ticket `claude -p`
subprocesses. It now runs **under tmux** — `/pickle-tmux --teams` passes `--tmux --teams` to `setup.js`
jointly, so the session is created with `tmux_mode: true` **and** `teams_mode: true`. The bare
`/pickle --teams` (in-session) path was removed in R-PNTR-4; `setup.js` rejects a `--teams` invocation that
lacks `--tmux` with a migration hint.

- **Claude backend only.** `setup.js` rejects `--teams --backend codex` / `--backend hermes` (codex+teams
  conflict, preserved). The codex/hermes safe path is the default `mux-runner` subprocess loop.
- **`--max-parallel <N>`** (requires `--teams`) caps worker concurrency; defaults to 5.
- **Orchestration.** Under tmux, `mux-runner` spawns the manager with the manager-lifecycle template
  (`_pickle-manager-prompt.md`), whose **Phase 3.B — Teams Mode** block fires when `state.teams_mode === true`.
  The manager drives the team via the harness primitives `TeamCreate` → `TaskCreate` (one per ticket) →
  `Agent` (one call per phase) → `TaskUpdate(status="completed")`.
- **`morty-phase-*` subagents preserved.** Each ticket dispatches the six phase teammates —
  `morty-phase-researcher`, `morty-phase-planner`, `morty-phase-implementer`, `morty-phase-verifier`,
  `morty-phase-reviewer`, `morty-phase-simplifier` — each producing its phase artifact, with
  `validate-teams-ticket.js` gating completion. Same 8-phase lifecycle and artifact contract as the
  subprocess path.

To launch: include `--teams` in `$ARGUMENTS`; Step 2 forwards it alongside `--tmux`. Everything else
(tmux session, runner pane, monitor) is identical to a non-teams `/pickle-tmux` launch.

## Skip-flag overrides

If pipeline launch halts at a quality gate, edit `${SESSION_ROOT}/state.json` and add:
```json
"flags": { "skip_quality_gates_reason": "<reason string>" }
```
This unified flag (R-QGSK-2, `b2ddf584`) covers both readiness AND ticket-audit gates.

**Legacy**: `state.flags.skip_readiness_reason` and `state.flags.skip_ticket_audit_reason` are still honored but emit a deprecation warning. Migrate to the unified flag.

Use a short reason string for any override. mux-runner records the bypass in activity and then proceeds on the next launch.

## Step 3: tmux Session
Session name: `pickle-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```
Print attach command immediately: `tmux attach -t <name>` (Window 1 "monitor" = 4-pane; Window 0 "runner" = background, Ctrl+B 0).

## Step 4: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js <SESSION_ROOT>; echo ''; echo 'Runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter
```

### Codex Backend

For `--backend codex`, this tmux-direct launch path is the safety boundary: the tmux pane runs `mux-runner` directly under the shell, and `codex exec` appears only as a child process spawned by mux-runner.

Target process tree: `zsh -> tmux pane -> node .../mux-runner.js -> codex exec`.

Do NOT keep a long-lived codex session as the parent of mux-runner, and do NOT treat "codex launches /pickle-tmux and then watches it for hours" as an equivalent setup. The safe arrangement is mux-runner in pane 0 directly under the shell; codex is the worker child, not the parent of mux-runner.

## Step 5: Monitor (4-pane)
mux-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.

## Step 6: Report
Print: session name, `tmux attach -t <name>`, window layout (monitor: dashboard top-left / log-stream top-right / morty-logs bottom-left / raw-morty bottom-right; runner: Ctrl+B 0), cancel: `cd <working_dir> && /eat-pickle`, emergency: `tmux kill-session -t <name>` then `node ~/.claude/pickle-rick/extension/bin/cancel.js`, state path: `<SESSION_ROOT>/state.json`.

Output: `<promise` + `>TASK_COMPLETED</promise>`
