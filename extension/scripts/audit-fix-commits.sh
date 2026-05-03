#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/extension/tests"

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not deployed]" >&2
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

PCRE_ENGINE="grep"
if ! printf '\n' | grep -Pq '^$' >/dev/null 2>&1; then
  if ! command -v perl >/dev/null 2>&1; then
    echo "GNU grep with -P support or perl is required" >&2
    exit 1
  fi
  PCRE_ENGINE="perl"
fi

RESOLVES_RE='^Resolves: prds/p[123]-[a-z0-9-]+\.md#R-(PJV|EQ|PSO|TF|RTC)-[0-9]+a?$'
TEST_TIER_RE='^Test-Tier: (fast|integration|expensive|contract)$'
CANARY_RE='^Canary: (extension/tests/[^[:space:]]+|N/A \(test-flake-fix\)|N/A \(infra-only\))$'
CONTRACT_RE='^Contract: extension/tests/contract/cli-contract\.test\.js$'

merge_base="${MERGE_BASE:-}"
if [ -z "$merge_base" ]; then
  merge_base="$(git merge-base HEAD origin/main)"
fi

status=0

has_trailer() {
  local body="$1"
  local regex="$2"

  if [ "$PCRE_ENGINE" = "grep" ]; then
    printf '%s\n' "$body" | grep -Pq "$regex"
  else
    REGEX="$regex" perl -ne '$matched = 1 if /$ENV{REGEX}/; END { exit($matched ? 0 : 1) }' <<<"$body"
  fi
}

validate_commit() {
  local sha="$1"
  local body="$2"

  if ! has_trailer "$body" "$RESOLVES_RE"; then
    echo "$sha missing:Resolves" >&2
    status=1
  fi

  if ! has_trailer "$body" "$TEST_TIER_RE"; then
    echo "$sha missing:Test-Tier" >&2
    status=1
  fi

  if ! has_trailer "$body" "$CANARY_RE" && ! has_trailer "$body" "$CONTRACT_RE"; then
    echo "$sha missing:Canary" >&2
    status=1
  fi
}

current_sha=""
current_body=""

while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "--END--" ]; then
    if [ -n "$current_sha" ]; then
      validate_commit "$current_sha" "$current_body"
    fi
    current_sha=""
    current_body=""
    continue
  fi

  if [ -z "$current_sha" ]; then
    current_sha="$line"
    continue
  fi

  current_body="${current_body}${line}
"
done < <(git log --grep='^Resolves: prds/' --format='%H%n%B%n--END--' "$merge_base..HEAD")

exit "$status"
