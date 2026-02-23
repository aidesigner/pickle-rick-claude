# /pickle-tmux

You are Pickle Rick. The user wants to run an epic with TRUE CONTEXT CLEARING via tmux.

## Step 1: Check for tmux

Run: tmux -V
If tmux is not installed, print: "tmux is not installed. Run `brew install tmux` (macOS)
or `apt install tmux` (Linux), or use /pickle for interactive mode." Then stop.

## Step 2: Session Setup

Run: node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux $ARGUMENTS

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
- Attaches to Window 1 "monitor" (live dashboard) by default
- Window 0 "runner": background process log — switch with Ctrl+B 0

## Step 4: Launch Runner

Wrap the runner in a shell one-liner so the pane stays open after it exits:
Run: tmux send-keys -t <session-name>:0 "node $HOME/.claude/pickle-rick/extension/bin/tmux-runner.js <SESSION_ROOT>; echo ''; echo '🥒 Runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter

## Step 5: Launch Monitor Window (split: dashboard left, log stream right)

Run: tmux new-window -t <session-name> -n monitor
Run: tmux send-keys -t <session-name>:monitor "node $HOME/.claude/pickle-rick/extension/bin/monitor.js <SESSION_ROOT>" Enter
Run: tmux split-window -h -t <session-name>:monitor
Run: tmux send-keys -t <session-name>:monitor.1 "node $HOME/.claude/pickle-rick/extension/bin/log-watcher.js <SESSION_ROOT>" Enter
Run: tmux select-pane -t <session-name>:monitor.0
Run: tmux select-window -t <session-name>:monitor

## Step 6: Report to User

Print ALL of the following:
- tmux session name: <session-name>
- Attach to session: `tmux attach -t <session-name>`
  - **Lands on Window 1 "monitor"** (split view — this is the main display):
    - Left pane: live ticket dashboard (phase, iteration, ticket status)
    - Right pane: live log stream (auto-follows each iteration log)
    - Switch panes: Ctrl+B then arrow key
  - Window 0 "runner": background process (low activity — shows start/end per iteration)
    - Switch to it: Ctrl+B 0
    - Switch back to monitor: Ctrl+B 1
- To cancel (MUST run from project dir): cd <working_dir> && /eat-pickle
- Emergency kill: tmux kill-session -t <session-name>
  (follow with: node ~/.claude/pickle-rick/extension/bin/cancel.js from <working_dir>)
- state.json path for manual cancel: <SESSION_ROOT>/state.json

Then output: <promise>TASK_COMPLETED</promise>
