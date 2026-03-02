#!/bin/bash
# Deterministic 3-pane tmux monitor layout.
# Usage: tmux-monitor.sh <session-name> <session-root> [pickle|meeseeks]
set -e

NAME="$1"
SESSION_ROOT="$2"
MODE="${3:-pickle}"
EXT="$HOME/.claude/pickle-rick/extension"

if [ -z "$NAME" ] || [ -z "$SESSION_ROOT" ]; then
  echo "Usage: tmux-monitor.sh <session-name> <session-root> [pickle|meeseeks]" >&2
  exit 1
fi

# Create window and split: top-left (0), bottom (1 after vsplit), then split top into 0 and 1
tmux new-window -t "$NAME" -n monitor
tmux split-window -v -t "$NAME:monitor" -l 33%
tmux split-window -h -t "$NAME:monitor.0"

# Pane 0 = top-left (dashboard)
tmux send-keys -t "$NAME:monitor.0" "node $EXT/bin/monitor.js $SESSION_ROOT" Enter
# Pane 1 = top-right (log stream)
tmux send-keys -t "$NAME:monitor.1" "node $EXT/bin/log-watcher.js $SESSION_ROOT" Enter

# Pane 2 = bottom — varies by mode
if [ "$MODE" = "meeseeks" ]; then
  tmux send-keys -t "$NAME:monitor.2" "tail -F $SESSION_ROOT/mux-runner.log" Enter
else
  tmux send-keys -t "$NAME:monitor.2" "node $EXT/bin/morty-watcher.js $SESSION_ROOT" Enter
fi

tmux select-pane -t "$NAME:monitor.0"
tmux select-window -t "$NAME:monitor"
