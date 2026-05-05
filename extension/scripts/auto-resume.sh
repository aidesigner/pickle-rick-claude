#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"
MAX_RETRIES="${PICKLE_AUTO_RESUME_MAX_RETRIES:-10}"
PROGRESS_THRESHOLD=3
BANNER_THRESHOLD=3
MAX_WALL_SECONDS="${PICKLE_AUTO_RESUME_MAX_WALL_SECONDS:-7200}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
usage: auto-resume.sh <session-dir>

Foreground wrapper that relaunches mux-runner.js after a pipeline_phase_incomplete exit.

Environment:
  PICKLE_AUTO_RESUME_ON_CAP_HIT=1       enable auto-resume (required to activate loop)
  PICKLE_AUTO_RESUME_MAX_RETRIES        max relaunch count (default: 10)
  PICKLE_AUTO_RESUME_MAX_WALL_SECONDS   max wall-clock seconds before stopping (default: 7200)
  PICKLE_INSTALL_ROOT                   override extension root (default: ~/.claude/pickle-rick)

FOREGROUND ONLY: setsid, nohup, disown, and detach are forbidden. The wrapper dies with the
parent shell. Child mux-runner is killed when the wrapper receives SIGTERM or SIGINT.

Stop conditions (any one triggers halt):
  - exit_reason is not 'pipeline_phase_incomplete'
  - MAX_RETRIES exhausted
  - wall-clock exceeds MAX_WALL_SECONDS
  - no progress (same ticket + done count) for >= PROGRESS_THRESHOLD consecutive retries
EOF
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "[auto-resume] error: session-dir argument required" >&2
  echo "usage: auto-resume.sh <session-dir>" >&2
  exit 1
fi

SESSION_DIR="$1"
STATE_JSON="$SESSION_DIR/state.json"

if [[ ! -d "$SESSION_DIR" ]]; then
  echo "[auto-resume] error: session directory not found: $SESSION_DIR" >&2
  exit 1
fi

MUX_RUNNER="$EXTENSION_ROOT/extension/bin/mux-runner.js"

if [[ ! -f "$MUX_RUNNER" ]]; then
  echo "[auto-resume] error: mux-runner not found: $MUX_RUNNER" >&2
  exit 1
fi

# Without the enable flag, run exactly once and exit — no loop.
if [[ "${PICKLE_AUTO_RESUME_ON_CAP_HIT:-}" != "1" ]]; then
  exec node "$MUX_RUNNER" "$SESSION_DIR"
fi

# Foreground child tracking. INVARIANT: no setsid/nohup/disown/detach — wrapper MUST die with
# parent shell. Child PID is tracked so signals forwarded via trap kill the child immediately.
CHILD_PID=""

_kill_child() {
  if [[ -n "$CHILD_PID" ]]; then
    kill "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
  fi
}

trap '_kill_child; exit 130' INT
trap '_kill_child; exit 143' TERM
trap '_kill_child; exit 129' HUP

_read_state_field() {
  local field="$1"
  node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const v = s[process.argv[2]];
  process.stdout.write(v != null ? String(v) : '');
} catch { process.stdout.write(''); }
" "$STATE_JSON" "$field" 2>/dev/null || true
}

_count_done_tickets() {
  node -e "
const fs = require('fs'), path = require('path');
const dir = process.argv[1];
let n = 0;
try {
  for (const hash of fs.readdirSync(dir)) {
    const ticketPath = path.join(dir, hash, 'linear_ticket_' + hash + '.md');
    if (!fs.existsSync(ticketPath)) continue;
    if (/^status:\s*Done\s*$/m.test(fs.readFileSync(ticketPath, 'utf8'))) n++;
  }
} catch {}
process.stdout.write(String(n));
" "$SESSION_DIR" 2>/dev/null || echo "0"
}

start_epoch="$(date +%s)"
retry=0
prev_done=""
prev_ticket=""

echo "[auto-resume] starting loop (max_retries=$MAX_RETRIES, session=$SESSION_DIR)" >&2

while true; do
  node "$MUX_RUNNER" "$SESSION_DIR" &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""

  exit_reason="$(_read_state_field exit_reason)"

  if [[ "$exit_reason" != "pipeline_phase_incomplete" ]]; then
    echo "[auto-resume] stopped: exit_reason='$exit_reason'" >&2
    break
  fi

  retry=$((retry + 1))

  if [[ "$retry" -ge "$MAX_RETRIES" ]]; then
    echo "[auto-resume] stopped: exhausted max retries ($MAX_RETRIES)" >&2
    break
  fi

  now_epoch="$(date +%s)"
  elapsed=$((now_epoch - start_epoch))
  if [[ "$elapsed" -ge "$MAX_WALL_SECONDS" ]]; then
    echo "[auto-resume] stopped: wall-clock limit reached (${elapsed}s >= ${MAX_WALL_SECONDS}s)" >&2
    break
  fi

  if [[ "$retry" -gt "$BANNER_THRESHOLD" ]]; then
    echo "[auto-resume] WARNING: retry $retry/$MAX_RETRIES — pipeline_phase_incomplete persists (${elapsed}s elapsed)" >&2
  fi

  cur_ticket="$(_read_state_field current_ticket)"
  cur_done="$(_count_done_tickets)"

  if [[ -n "$prev_done" && "$cur_done" == "$prev_done" && "$cur_ticket" == "$prev_ticket" && "$retry" -ge "$PROGRESS_THRESHOLD" ]]; then
    echo "[auto-resume] stopped: no progress after $retry retries (ticket=$cur_ticket, done=$cur_done)" >&2
    break
  fi

  prev_done="$cur_done"
  prev_ticket="$cur_ticket"

  echo "[auto-resume] retry $retry/$MAX_RETRIES (done=$cur_done, ticket=$cur_ticket, elapsed=${elapsed}s)" >&2
done
