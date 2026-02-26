# /pickle-tmux

You are Pickle Rick. The user wants to run an epic with TRUE CONTEXT CLEARING via tmux.

## Step 1: Check for tmux

Run: tmux -V
If tmux is not installed, print: "tmux is not installed. Run `brew install tmux` (macOS)
or `apt install tmux` (Linux), or use /pickle for interactive mode." Then stop.

## Step 2: Session Setup

**CRITICAL — flag extraction**: `$ARGUMENTS` may contain flags like `--resume <path>`, `--max-iterations <N>`, etc. You MUST extract any `--flags` and pass them as separate arguments before `--task`. Only the bare task text goes inside `--task "..."`.

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux [--flags from $ARGUMENTS] --task "$ARGUMENTS"
```

For example, if the user ran `/pickle-tmux --resume /sessions/057f0263`, execute:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume /sessions/057f0263
```
(No `--task` needed when resuming — the task is already in state.json.)

If the user ran `/pickle-tmux --max-iterations 10 "refactor auth"`, execute:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --max-iterations 10 --task "refactor auth"
```

If no flags were provided, just:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --task "$ARGUMENTS"
```

Read the output for the SESSION_ROOT path (line starting with SESSION_ROOT=).
Also record the working_dir (the project cwd).

## Step 3: Create tmux Session

Derive session name from SESSION_ROOT basename: pickle-<hash-portion>
Run: tmux new-session -d -s <session-name> -c <working_dir>
Run: sleep 1
(Allow tmux to initialize the session before sending keys — avoids a race where send-keys
fires before the pane is ready.)

## Step 3b: Print Attach Command Early

Print immediately (so the user can open a second terminal now):
- tmux session name: <session-name>
- **Attach to watch:** `tmux attach -t <session-name>`
- Attaches to Window 1 "monitor" (3-pane layout) by default:
  - Top-left: live ticket dashboard
  - Top-right: live iteration log stream
  - Bottom: live worker (Morty) logs
- Window 0 "runner": background process log — switch with Ctrl+B 0

## Step 4: Launch Runner

Wrap the runner in a shell one-liner so the pane stays open after it exits:
Run: tmux send-keys -t <session-name>:0 "node $HOME/.claude/pickle-rick/extension/bin/tmux-runner.js <SESSION_ROOT>; echo ''; echo '🥒 Runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter

## Step 5: Launch Monitor Window (3-pane: dashboard top-left, log stream top-right, worker logs bottom)

Run: tmux new-window -t <session-name> -n monitor
Run: tmux split-window -v -t <session-name>:monitor -l 33%
Run: tmux send-keys -t <session-name>:monitor.1 "node $HOME/.claude/pickle-rick/extension/bin/morty-watcher.js <SESSION_ROOT>" Enter
Run: tmux split-window -h -t <session-name>:monitor.0
Run: tmux send-keys -t <session-name>:monitor.0 "node $HOME/.claude/pickle-rick/extension/bin/monitor.js <SESSION_ROOT>" Enter
Run: tmux send-keys -t <session-name>:monitor.2 "node $HOME/.claude/pickle-rick/extension/bin/log-watcher.js <SESSION_ROOT>" Enter
Run: tmux select-pane -t <session-name>:monitor.0
Run: tmux select-window -t <session-name>:monitor

## Step 6: Report to User

Print ALL of the following:
- tmux session name: <session-name>
- Attach to session: `tmux attach -t <session-name>`
  - **Lands on Window 1 "monitor"** (3-pane layout — this is the main display):
    - Top-left pane: live ticket dashboard (phase, iteration, ticket status)
    - Top-right pane: live iteration log stream (auto-follows each iteration log)
    - Bottom pane: live worker (Morty) logs (auto-follows latest worker session)
    - Switch panes: Ctrl+B then arrow key
  - Window 0 "runner": background process (low activity — shows start/end per iteration)
    - Switch to it: Ctrl+B 0
    - Switch back to monitor: Ctrl+B 1
- To cancel (MUST run from project dir): cd <working_dir> && /eat-pickle
- Emergency kill: tmux kill-session -t <session-name>
  (follow with: node ~/.claude/pickle-rick/extension/bin/cancel.js from <working_dir>)
- state.json path for manual cancel: <SESSION_ROOT>/state.json

Then output: <promise>TASK_COMPLETED</promise>
