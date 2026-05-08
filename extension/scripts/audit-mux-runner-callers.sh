#!/usr/bin/env bash
# audit-mux-runner-callers.sh
#
# AC-ICP-07: Verify that every site which spawns mux-runner.js has explicit
# handling for exit code 3 (PipelineRunnerExitCode.PhaseIncomplete /
# iteration_cap_exhausted). Fail CI when a new caller is added without it.
#
# Detection heuristics:
#   TypeScript: runnerScript: 'mux-runner.js'     (phase config that triggers spawn)
#   Shell:      node.*mux-runner\.js on a non-comment, non-string line
#
# Code-3 handling accepted (per file):
#   pipeline-runner.ts  → PhaseIncomplete
#   auto-resume.sh      → pipeline_phase_incomplete
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_DIR="$EXTENSION_ROOT/src"
SCRIPTS_DIR="$EXTENSION_ROOT/scripts"

status=0

fail() {
  printf '%s\n' "$1" >&2
  status=1
}

echo "audit-mux-runner-callers: scanning for mux-runner.js spawn sites"

# ── TypeScript source files ──────────────────────────────────────────────────
# Spawn pattern: runnerScript: 'mux-runner.js' (phase config property in pipeline-runner)
while IFS= read -r file; do
  # Check if this file contains the runnerScript config pointing at mux-runner.js
  if grep -q "runnerScript.*'mux-runner\.js'" "$file" 2>/dev/null; then
    case "$file" in
      */pipeline-runner.ts)
        if ! grep -q "PhaseIncomplete" "$file"; then
          fail "pipeline-runner.ts spawns mux-runner.js but is missing 'PhaseIncomplete' code-3 handling"
        fi
        ;;
      *)
        fail "NEW mux-runner.js spawn site without registered code-3 handling: $file"
        fail "  Register the file in audit-mux-runner-callers.sh with its code-3 handling pattern."
        ;;
    esac
  fi
done < <(find "$SRC_DIR" -type f -name '*.ts' 2>/dev/null | sort)

# ── Shell scripts ────────────────────────────────────────────────────────────
# Spawn pattern: node invocation targeting mux-runner.js on a non-comment line
# We look for lines that have both 'node' as an executable AND 'mux-runner.js',
# excluding comment lines and the audit script itself.
while IFS= read -r file; do
  case "$file" in
    # Skip this audit script — it only mentions mux-runner.js in comments
    */audit-mux-runner-callers.sh) continue ;;
  esac

  found_spawn=0
  while IFS= read -r line; do
    # Skip comment lines (shell: # prefix)
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      "#"*) continue ;;
    esac
    # Match: line contains node invocation + mux-runner.js
    case "$line" in
      *"node"*"mux-runner.js"*)
        found_spawn=1
        break
        ;;
    esac
  done < "$file"

  if [ "$found_spawn" -eq 0 ]; then
    continue
  fi

  case "$file" in
    */auto-resume.sh)
      if ! grep -q "pipeline_phase_incomplete" "$file"; then
        fail "auto-resume.sh spawns mux-runner.js but is missing 'pipeline_phase_incomplete' code-3 handling"
      fi
      ;;
    *)
      fail "NEW mux-runner.js spawn site without registered code-3 handling: $file"
      fail "  Register the file in audit-mux-runner-callers.sh with its code-3 handling pattern."
      ;;
  esac
done < <(find "$SCRIPTS_DIR" -type f -name '*.sh' 2>/dev/null | sort)

if [ "$status" -eq 0 ]; then
  echo "audit-mux-runner-callers: all mux-runner.js spawn sites have explicit code-3 handling"
fi

exit "$status"
