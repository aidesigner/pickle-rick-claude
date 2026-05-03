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

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"

merge_base="${MERGE_BASE:-}"
if [ -z "$merge_base" ]; then
  merge_base="$(git merge-base HEAD origin/main)"
fi

status=0
MARKER_RE='t\.todo\(|t\.skip\(|// @xfail: '

has_xfail_marker() {
  grep -Eq "$MARKER_RE"
}

fail() {
  local sha="$1"
  local canary_path="$2"
  local reason="$3"

  echo "$sha $canary_path $reason" >&2
  status=1
}

parent_has_marker() {
  local sha="$1"
  local canary_path="$2"

  git -C "$REPO_ROOT" show "$sha^:$canary_path" 2>/dev/null | has_xfail_marker
}

commit_removes_marker() {
  local sha="$1"
  local canary_path="$2"

  git -C "$REPO_ROOT" diff --unified=0 "$sha^..$sha" -- "$canary_path" |
    grep -E '^-([^-].*)?(t\.todo\(|t\.skip\(|// @xfail: )' >/dev/null
}

commit_has_marker() {
  local sha="$1"
  local canary_path="$2"

  git -C "$REPO_ROOT" show "$sha:$canary_path" 2>/dev/null | has_xfail_marker
}

run_canary_at_commit() {
  local sha="$1"
  local canary_path="$2"
  local result=0

  if ! git -C "$REPO_ROOT" checkout "$sha" -- "$canary_path" >/dev/null 2>&1; then
    return 1
  fi

  if ! (cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test "$canary_path"); then
    result=1
  fi

  if ! git -C "$REPO_ROOT" checkout HEAD -- "$canary_path" >/dev/null 2>&1; then
    result=1
  fi

  return "$result"
}

validate_canary() {
  local sha="$1"
  local canary_path="$2"

  case "$canary_path" in
    extension/tests/audit-*.test.js)
      return
      ;;
  esac

  if ! parent_has_marker "$sha" "$canary_path"; then
    fail "$sha" "$canary_path" "missing-parent-xfail-marker"
    return
  fi

  if ! commit_removes_marker "$sha" "$canary_path"; then
    fail "$sha" "$canary_path" "missing-xfail-marker-removal"
    return
  fi

  if commit_has_marker "$sha" "$canary_path"; then
    fail "$sha" "$canary_path" "xfail-marker-still-present"
    return
  fi

  if ! run_canary_at_commit "$sha" "$canary_path"; then
    fail "$sha" "$canary_path" "canary-test-failed"
  fi
}

validate_commit() {
  local sha="$1"
  local body="$2"
  local canary_path

  while IFS= read -r canary_path; do
    [ -n "$canary_path" ] || continue
    validate_canary "$sha" "$canary_path"
  done < <(printf '%s\n' "$body" | sed -n 's/^Canary: \(extension\/tests\/[^[:space:]]*\)$/\1/p')
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
done < <(git -C "$REPO_ROOT" log --format='%H%n%B%n--END--' --grep='^Canary: extension/tests/' "$merge_base..HEAD")

exit "$status"
