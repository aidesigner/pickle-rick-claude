#!/usr/bin/env bash
# R-TFP-C2 forward-protection: flags integration tests that spawn bash/sh scripts
# with an explicit timeout <= SUBPROCESS_HEAVY_TIMEOUT_MS and lack serialization.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/tests"
SERIAL_MANIFEST_PATH="$EXTENSION_ROOT/tests/integration/.serial-tests.json"

# SUBPROCESS_HEAVY_PATTERN (source of truth):
#   spawnSync('bash'|'sh', [firstArg, ...], { ..., timeout: N, ... })
#   where firstArg is NOT a '-' flag (i.e., it is a script path/variable)
#   and N <= SUBPROCESS_HEAVY_TIMEOUT_MS (5000)
#
# Allowlist (silences a candidate):
#   1. File path present in tests/integration/.serial-tests.json
#   2. File contains the comment marker: // SERIAL: <reason>
#
# Excluded tiers:
#   @tier: expensive (gated behind RUN_EXPENSIVE_TESTS=1, not part of c=8 surface)

SUBPROCESS_HEAVY_TIMEOUT_MS=5000

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not deployed]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

status=0

# is_in_manifest <rel_path>
# Returns 0 (true) if the relative path is in the serial-tests manifest.
is_in_manifest() {
  local file_rel="$1"
  if [ ! -f "$SERIAL_MANIFEST_PATH" ]; then
    return 1
  fi
  node - "$SERIAL_MANIFEST_PATH" "$file_rel" <<'NODE'
const fs = require('fs');
const [, , manifestPath, fileRel] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const normalized = fileRel.replace(/\\/g, '/');
process.exit(manifest.entries.some((e) => e === normalized) ? 0 : 1);
NODE
}

# find_heavy_candidate <file> <timeout_ms>
# Prints a reason string and exits 0 if the file is a subprocess-heavy candidate.
# Exits 1 if no candidate pattern found.
find_heavy_candidate() {
  local file="$1"
  local timeout_ms="$2"
  node - "$file" "$timeout_ms" <<'NODE'
const fs = require('fs');
const [, , filePath, timeoutMs] = process.argv;
const THRESHOLD = parseInt(timeoutMs, 10);
const content = fs.readFileSync(filePath, 'utf8');

// Skip @tier: expensive — not part of the --test-concurrency=8 surface.
const firstLine = content.split('\n')[0];
if (firstLine.includes('@tier: expensive')) process.exit(1);

// SUBPROCESS_HEAVY_PATTERN:
//   spawnSync('bash'|'sh', [nonFlagFirstArg, ...]) with explicit timeout <= THRESHOLD
//
// The '-' exclusion prevents false positives on inline commands like:
//   spawnSync('bash', ['-lc', 'command -v git'])
//   spawnSync('bash', ['-c', 'echo test'])
const bashSpawnRe = /\bspawnSync\s*\(\s*['"](?:bash|sh)['"]\s*,\s*\[(?!\s*['"][^'"]*-)/g;
let m;
while ((m = bashSpawnRe.exec(content)) !== null) {
  const block = content.slice(m.index, m.index + 600);
  const timeoutMatch = block.match(/\btimeout\s*:\s*([0-9][0-9_]*)\b/);
  if (!timeoutMatch) continue; // no explicit timeout: not flagged by this audit
  const t = parseInt(timeoutMatch[1].replace(/_/g, ''), 10);
  if (t <= THRESHOLD) {
    process.stdout.write(`spawnSync(bash/sh, script, { timeout: ${t} })\n`);
    process.exit(0);
  }
}

process.exit(1); // not a candidate
NODE
}

audit_file() {
  local file="$1"

  if [ ! -f "$file" ]; then
    echo "$file: not found" >&2
    status=1
    return
  fi

  # Derive relative path from EXTENSION_ROOT (e.g. tests/foo.test.js)
  file_rel="${file#"$EXTENSION_ROOT/"}"

  # Run pattern matcher; exit 1 means not a candidate
  candidate_reason="$(find_heavy_candidate "$file" "$SUBPROCESS_HEAVY_TIMEOUT_MS" 2>/dev/null)"
  candidate_exit=$?
  [ "$candidate_exit" -ne 0 ] && return

  # Check allowlist: serial manifest
  if is_in_manifest "$file_rel"; then
    return
  fi

  # Check allowlist: // SERIAL: comment in file
  if grep -q '// SERIAL:' "$file"; then
    return
  fi

  echo "$file_rel: subprocess-heavy candidate not serialized ($candidate_reason)" >&2
  status=1
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    audit_file "$file"
  done
else
  while IFS= read -r file; do
    audit_file "$file"
  done < <(find "$TEST_ROOT" -type f -name '*.test.js' \
    ! -path "$TEST_ROOT/fixtures/*" | sort)
fi

if [ "$status" -eq 0 ]; then
  echo "audit-subprocess-heavy-tests: OK" >&2
fi

exit "$status"
