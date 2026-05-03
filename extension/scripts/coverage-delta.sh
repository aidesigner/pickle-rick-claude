#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$EXTENSION_ROOT" rev-parse --show-toplevel)"
BASELINE_JSON="$EXTENSION_ROOT/coverage-baseline.json"
CURRENT_JSON="$EXTENSION_ROOT/coverage/coverage-summary.json"
PARSER="${COVERAGE_EXCEPTION_PARSER:-$EXTENSION_ROOT/scripts/parse-coverage-exception.sh}"

if [[ ! -f "$CURRENT_JSON" ]]; then
  echo "[error: run 'npm run coverage' first]" >&2
  exit 2
fi

if [[ -n "${MERGE_BASE:-}" ]]; then
  MERGE_BASE_VALUE="$MERGE_BASE"
else
  MERGE_BASE_VALUE="$(git -C "$REPO_ROOT" merge-base HEAD origin/main)"
fi
export MERGE_BASE="$MERGE_BASE_VALUE"

exception_json="$("$PARSER")"

has_exception_for() {
  local touched_path="$1"
  jq -e --arg path "$touched_path" 'any(.[]?; .path == $path)' >/dev/null <<<"$exception_json"
}

coverage_value() {
  local json_file="$1"
  local suffix="$2"
  local field="$3"

  jq -r --arg suffix "$suffix" --arg field "$field" '
    to_entries
    | map(select(.key | endswith($suffix)))
    | first
    | if . == null then "null" else (.value.lines[$field] // "null") end
  ' "$json_file"
}

is_less_than() {
  awk -v left="$1" -v right="$2" 'BEGIN { exit !(left < right) }'
}

line_delta() {
  awk -v current="$1" -v baseline="$2" 'BEGIN { printf "%d", current - baseline }'
}

regressions=0

while IFS= read -r touched_path; do
  [[ -n "$touched_path" ]] || continue

  generated_path="${touched_path#extension/src/}"
  generated_path="${generated_path%.ts}.js"
  coverage_suffix="/extension/$generated_path"

  baseline_pct="$(coverage_value "$BASELINE_JSON" "$coverage_suffix" pct)"
  current_pct="$(coverage_value "$CURRENT_JSON" "$coverage_suffix" pct)"
  baseline_covered="$(coverage_value "$BASELINE_JSON" "$coverage_suffix" covered)"
  current_covered="$(coverage_value "$CURRENT_JSON" "$coverage_suffix" covered)"

  [[ "$baseline_pct" != "null" ]] || continue
  [[ "$current_pct" != "null" ]] || current_pct=0
  [[ "$baseline_covered" != "null" ]] || baseline_covered=0
  [[ "$current_covered" != "null" ]] || current_covered=0

  covered_delta="$(line_delta "$current_covered" "$baseline_covered")"
  if (( covered_delta >= 5 )); then
    echo "$touched_path: covered lines gain=$covered_delta"
  fi

  if is_less_than "$current_pct" "$baseline_pct"; then
    if has_exception_for "$touched_path"; then
      continue
    fi

    delta="$(awk -v current="$current_pct" -v baseline="$baseline_pct" 'BEGIN { printf "%.2f", current - baseline }')"
    echo "$touched_path: baseline=${baseline_pct}%, current=${current_pct}%, delta=${delta}%" >&2
    regressions=1
  fi
done < <(git -C "$REPO_ROOT" diff --name-only "$MERGE_BASE_VALUE"..HEAD -- 'extension/src/' | sort)

exit "$regressions"
