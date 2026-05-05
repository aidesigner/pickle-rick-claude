#!/usr/bin/env bash
# R-RTRC-5: Audit `extension/.readiness-allowlist.json` schema.
#
# INVARIANT: every entry MUST have a non-empty `ref` AND a non-empty `source`
# field. Entries lacking either are silently dropped at load time
# (`loadReadinessAllowlist` in `extension/src/bin/check-readiness.ts`); this
# lint script is the trip-wire that surfaces missing fields at CI time.
#
# Exits 0 on success, 1 on any malformed entry, 2 on missing/unparsable file
# (note: missing file is intentionally exit 0 — the allowlist is optional).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST_FILE="$EXTENSION_ROOT/.readiness-allowlist.json"

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "[skipped: $ALLOWLIST_FILE not present — allowlist is optional]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 2
fi

node - "$ALLOWLIST_FILE" <<'NODE'
const fs = require('fs');
const [, , file] = process.argv;
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
} catch (err) {
  process.stderr.write(`audit-readiness-allowlist: ${file} — invalid JSON: ${err.message}\n`);
  process.exit(2);
}
if (!Array.isArray(parsed)) {
  process.stderr.write(`audit-readiness-allowlist: ${file} — top-level value must be an array\n`);
  process.exit(1);
}
let failures = 0;
parsed.forEach((entry, i) => {
  if (typeof entry !== 'object' || entry === null) {
    process.stderr.write(`audit-readiness-allowlist: entry [${i}] — not an object\n`);
    failures += 1;
    return;
  }
  const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  if (!ref) {
    process.stderr.write(`audit-readiness-allowlist: entry [${i}] — missing or empty 'ref' field\n`);
    failures += 1;
  }
  if (!source) {
    process.stderr.write(`audit-readiness-allowlist: entry [${i}] (ref=${ref || '<missing>'}) — missing or empty 'source' field; every entry MUST justify itself\n`);
    failures += 1;
  }
});
if (failures > 0) {
  process.stderr.write(`\naudit-readiness-allowlist: ${failures} violation(s) in ${file}\n`);
  process.exit(1);
}
console.log(`audit-readiness-allowlist: ${parsed.length} entries verified in ${file}`);
NODE
