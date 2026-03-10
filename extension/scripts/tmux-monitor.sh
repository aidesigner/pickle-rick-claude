#!/bin/bash
# Deterministic 4-pane tmux monitor layout (Matrix edition).
# Usage: tmux-monitor.sh <session-name> <session-root> [pickle|meeseeks|refinement]
set -e

NAME="$1"
SESSION_ROOT="$2"
MODE="${3:-pickle}"
EXT="$HOME/.claude/pickle-rick/extension"

if [ -z "$NAME" ] || [ -z "$SESSION_ROOT" ]; then
  echo "Usage: tmux-monitor.sh <session-name> <session-root> [pickle|meeseeks]" >&2
  exit 1
fi

# Create window and build 2x2 grid:
#   ┌──────────────┬──────────────┐
#   │ 0: monitor   │ 1: log-watch │  60%
#   ├──────────────┼──────────────┤
#   │ 2: workers   │ 3: raw-morty │  40%
#   └──────────────┴──────────────┘
tmux new-window -t "$NAME" -n monitor
tmux split-window -v -t "$NAME:monitor" -l 40%
tmux split-window -h -t "$NAME:monitor.0"
tmux split-window -h -t "$NAME:monitor.2"

# Pane 0 = top-left (dashboard)
tmux send-keys -t "$NAME:monitor.0" "node $EXT/bin/monitor.js $SESSION_ROOT" Enter
# Pane 1 = top-right (log stream)
tmux send-keys -t "$NAME:monitor.1" "node $EXT/bin/log-watcher.js $SESSION_ROOT" Enter

# Pane 2 = bottom-left — varies by mode
if [ "$MODE" = "meeseeks" ] || [ "$MODE" = "council" ]; then
  tmux send-keys -t "$NAME:monitor.2" "tail -F $SESSION_ROOT/mux-runner.log" Enter
elif [ "$MODE" = "refinement" ]; then
  tmux send-keys -t "$NAME:monitor.2" "node $EXT/bin/refinement-watcher.js $SESSION_ROOT" Enter
else
  tmux send-keys -t "$NAME:monitor.2" "node $EXT/bin/morty-watcher.js $SESSION_ROOT" Enter
fi

# Pane 3 = bottom-right (raw morty feed)
tmux send-keys -t "$NAME:monitor.3" "node $EXT/bin/raw-morty.js $SESSION_ROOT" Enter

tmux select-pane -t "$NAME:monitor.0"
tmux select-window -t "$NAME:monitor"
