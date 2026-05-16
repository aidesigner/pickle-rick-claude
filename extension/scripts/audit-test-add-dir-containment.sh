#!/usr/bin/env bash
# audit-test-add-dir-containment.sh
#
# R-WSRC-4: static-analysis pair for the runtime assertion in
# `buildClaudeWorkerInvocation` (PICKLE_TEST_MODE sandbox check). Catches test
# fixtures that propagate REPO_ROOT (or process.cwd / __dirname) into a worker
# spawn's `working_dir` BEFORE the runtime check could fire — i.e. when the
# test harness never sets PICKLE_TEST_MODE=1.
#
# Failure mode this prevents:
#   A test sets `working_dir: REPO_ROOT` in state.json, spawns mux-runner.js,
#   which spawns a real or stubbed claude subprocess with
#   `--dangerously-skip-permissions --add-dir <real-repo>`. If the worker-gate
#   SIGTERM fails to propagate (R-MRWG-2), the orphan retains write access to
#   the operator's real working tree.
#
# Scope: greps test files for `working_dir.*REPO_ROOT`,
# `working_dir.*process\.cwd`, and `working_dir.*__dirname` patterns.
# Reports a violation only when:
#   (a) the match is NOT annotated with `// @add-dir-safe:` on the same or
#       preceding line, AND
#   (b) the test file contains a worker-spawn indicator (spawnSync/spawn against
#       mux-runner.js, spawn-morty.js, or a `claude` / `codex` binary) — pure
#       state-classifier unit tests that never reach buildClaudeWorkerInvocation
#       cannot leak --add-dir args and are skipped.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/tests"

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not present]" >&2
  exit 0
fi

status=0

PATTERN='working_dir[^A-Za-z0-9_].*(REPO_ROOT|process\.cwd|__dirname)'
# Spawn indicators we care about: anything that ultimately reaches
# `buildClaudeWorkerInvocation` (worker spawns). Only mux-runner.js,
# spawn-morty.js, or invocations with `claude` / `codex` as the executable
# (NOT as a substring like `pickle-rick-claude`).
SPAWN_INDICATOR='(spawn|spawnSync|execFile)[A-Za-z]*\([^)]*(mux-runner\.js|spawn-morty\.js|TMUX_RUNNER_BIN|MUX_RUNNER_BIN|MORTY_BIN|["'\'']claude["'\'']|["'\'']codex["'\'']|/claude["'\''[:space:]]|/codex["'\''[:space:]])'

file_spawns_worker() {
  local file="$1"
  grep -qE "$SPAWN_INDICATOR" "$file" 2>/dev/null
}

audit_file() {
  local file="$1"

  # Skip the regression test that intentionally exercises bad inputs.
  case "$file" in
    */backend-spawn-add-dir-sandbox.test.js) return ;;
  esac

  if ! grep -nE "$PATTERN" "$file" >/dev/null 2>&1; then
    return
  fi

  # Skip files that never spawn a worker subprocess — they cannot leak
  # --add-dir into a claude/codex invocation no matter what working_dir says.
  if ! file_spawns_worker "$file"; then
    return
  fi

  while IFS= read -r match_line; do
    [ -z "$match_line" ] && continue
    local ln
    ln="${match_line%%:*}"
    local content
    content="${match_line#*:}"

    # Allow inline annotation on the same line.
    case "$content" in
      *"@add-dir-safe"*) continue ;;
    esac

    # Walk back through blank lines for the preceding annotation.
    local probe=$((ln - 1))
    local prev_content=""
    while [ "$probe" -ge 1 ]; do
      local line
      line="$(sed -n "${probe}p" "$file")"
      case "$line" in
        "") probe=$((probe - 1)); continue ;;
        *"@add-dir-safe"*) prev_content="$line"; break ;;
        *) break ;;
      esac
    done
    case "$prev_content" in
      *"@add-dir-safe"*) continue ;;
    esac

    echo "$file:$ln R-WSRC-4 working_dir bound to REPO_ROOT/process.cwd/__dirname without @add-dir-safe annotation" >&2
    echo "  matched: $content" >&2
    status=1
  done < <(grep -nE "$PATTERN" "$file" 2>/dev/null)
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    audit_file "$file"
  done
else
  while IFS= read -r file; do
    audit_file "$file"
  done < <(find "$TEST_ROOT" -type f -name '*.test.js' | sort)
fi

if [ "$status" -eq 0 ]; then
  echo "audit-test-add-dir-containment: all worker-spawning test fixtures sandbox working_dir under os.tmpdir() (or carry @add-dir-safe annotation)"
fi

exit "$status"
