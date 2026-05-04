#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/extension/tests"
QUARANTINE_FILE="$TEST_ROOT/QUARANTINE.md"
BASELINE_FILE="$EXTENSION_ROOT/extension/quarantine-baseline.json"
MECHANISM="skipped via tier-discovery helper's exclude-list"

if [ ! -d "$TEST_ROOT" ]; then
  exit 0
fi

if [ ! -f "$QUARANTINE_FILE" ]; then
  exit 0
fi

status=0

report() {
  echo "$1" >&2
  status=1
}

baseline_count() {
  if [ ! -f "$BASELINE_FILE" ]; then
    echo "0"
    return
  fi

  node -e "
    const data = require(process.argv[1]);
    process.exit(Number.isInteger(data.initial_count) ? 0 : 1);
  " "$BASELINE_FILE" >/dev/null 2>&1 || return 1

  node -e "console.log(require(process.argv[1]).initial_count)" "$BASELINE_FILE"
}

extract_prd_status() {
  local prd_path="$1"

  awk '
    {
      line = $0
      gsub(/\*/, "", line)
      gsub(/`/, "", line)
      if (line ~ /^[[:space:]]*[Ss][Tt][Aa][Tt][Uu][Ss][[:space:]]*:/) {
        sub(/^[[:space:]]*[Ss][Tt][Aa][Tt][Uu][Ss][[:space:]]*:[[:space:]]*/, "", line)
        gsub(/^["'\''[:space:]]+|["'\''[:space:]]+$/, "", line)
        split(line, parts, /[[:space:]]+/)
        print parts[1]
        exit
      }
    }
  ' "$prd_path"
}

field_value() {
  local file="$1"
  local label="$2"

  sed -nE "s/^- ${label}:[[:space:]]*(.*)$/\\1/p" "$file" | head -n 1
}

validate_entry() {
  local entry_file="$1"
  local heading
  local first_failure
  local failure_rate
  local prd_path
  local mechanism
  local prd_status

  heading="$(sed -n '1p' "$entry_file")"
  if ! printf '%s\n' "$heading" | grep -Eq '^## tests/[A-Za-z0-9._/@+-]+$'; then
    report "$QUARANTINE_FILE: invalid quarantine heading: $heading"
    return
  fi

  first_failure="$(field_value "$entry_file" "First failure")"
  if ! printf '%s\n' "$first_failure" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    report "$heading: missing or invalid First failure"
  fi

  failure_rate="$(field_value "$entry_file" "Failure rate")"
  if ! printf '%s\n' "$failure_rate" | grep -Eq '^[0-9]+/100 runs$'; then
    report "$heading: missing or invalid Failure rate"
  fi

  prd_path="$(field_value "$entry_file" "PRD")"
  if ! printf '%s\n' "$prd_path" | grep -Eq '^prds/.+[.]md$'; then
    report "$heading: missing or invalid PRD"
  elif ! git -C "$EXTENSION_ROOT" ls-tree HEAD -- "$prd_path" | grep -q .; then
    report "$heading: PRD path not present at HEAD: $prd_path"
  else
    prd_status="$(extract_prd_status "$EXTENSION_ROOT/$prd_path")"
    case "$prd_status" in
      Draft|InRefinement|InProgress)
        ;;
      Done)
        report "$heading: stale quarantine PRD is Done: $prd_path"
        ;;
      *)
        report "$heading: invalid PRD status '$prd_status': $prd_path"
        ;;
    esac
  fi

  mechanism="$(field_value "$entry_file" "Mechanism")"
  if [ "$mechanism" != "$MECHANISM" ]; then
    report "$heading: Mechanism must be '$MECHANISM'"
  fi
}

initial_count="$(baseline_count)"
if [ "$?" -ne 0 ]; then
  echo "$BASELINE_FILE: initial_count must be an integer" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

entry_count=0
current_entry=""
in_comment=0

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *"<!--"*) in_comment=1 ;;
  esac

  if [ "$in_comment" -eq 0 ]; then
    case "$line" in
      "## tests/"*)
        entry_count=$((entry_count + 1))
        current_entry="$tmp_dir/entry-$entry_count.md"
        printf '%s\n' "$line" > "$current_entry"
        ;;
      *)
        if [ -n "$current_entry" ]; then
          printf '%s\n' "$line" >> "$current_entry"
        fi
        ;;
    esac
  fi

  case "$line" in
    *"-->"*) in_comment=0 ;;
  esac
done < "$QUARANTINE_FILE"

if [ "$entry_count" -gt $((initial_count + 5)) ]; then
  report "$QUARANTINE_FILE: $entry_count quarantine entries exceeds limit $((initial_count + 5))"
fi

entry_index=1
while [ "$entry_index" -le "$entry_count" ]; do
  validate_entry "$tmp_dir/entry-$entry_index.md"
  entry_index=$((entry_index + 1))
done

exit "$status"
