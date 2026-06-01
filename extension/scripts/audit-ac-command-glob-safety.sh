#!/usr/bin/env bash
# R-VSGE-2: Forward-protection audit for unquoted glob hazards in AC commands.
#
# Usage:
#   audit-ac-command-glob-safety.sh
#       Assert no 'shell: true' on the criterion-command path in ac-phase-gate.ts.
#       Exits non-zero (regression) if the pattern is found.
#
#   audit-ac-command-glob-safety.sh --lint <manifest.json>
#       WARN (exit 0, stderr) for any criterion whose STRING command trips
#       containsUnquotedGlobHazard. Hazard predicate is delegated to
#       verify-command-safety.js — no inline regex copy (R-FRA-2 pattern).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

AC_GATE_SRC="$EXTENSION_ROOT/src/services/ac-phase-gate.ts"
VERIFY_SAFETY_JS="$EXTENSION_ROOT/services/verify-command-safety.js"

if ! command -v node >/dev/null 2>&1; then
  echo "[error] node is required" >&2
  exit 1
fi

# --- Part (a): assert no shell: true on criterion-command path ---

if [ ! -f "$AC_GATE_SRC" ]; then
  echo "[error] ac-phase-gate.ts not found: $AC_GATE_SRC" >&2
  exit 1
fi

if grep -qE 'shell: *true' "$AC_GATE_SRC"; then
  echo "[FAIL] shell: true detected in criterion-command path: $AC_GATE_SRC" >&2
  echo "       Criterion commands MUST NOT use shell: true (R-VSGE-1 regression)" >&2
  exit 1
fi

echo "shell: true check passed — not present in $(basename "$AC_GATE_SRC")"

# --- Part (b): --lint <manifest.json> mode ---

if [ "${1:-}" != "--lint" ]; then
  exit 0
fi

MANIFEST="${2:-}"
if [ -z "$MANIFEST" ]; then
  echo "[error] --lint requires a manifest path" >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "[error] manifest not found: $MANIFEST" >&2
  exit 1
fi

if [ ! -f "$VERIFY_SAFETY_JS" ]; then
  echo "[error] verify-command-safety.js not found: $VERIFY_SAFETY_JS" >&2
  exit 1
fi

# Delegate hazard predicate to verify-command-safety.js (ESM).
# NO inline containsUnquotedGlobHazard regex — imported from verify-command-safety.js.
node - "$MANIFEST" "$EXTENSION_ROOT" <<'NODE'
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const [, , manifestFile, extensionRoot] = process.argv;

async function main() {
  const modUrl = pathToFileURL(
    path.join(extensionRoot, 'services', 'verify-command-safety.js')
  ).href;
  const { containsUnquotedGlobHazard } = await import(modUrl);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
  } catch (err) {
    process.stderr.write('[error] cannot parse manifest: ' + err.message + '\n');
    process.exit(1);
  }

  let criteria;
  if (Array.isArray(raw)) {
    criteria = raw;
  } else if (raw && typeof raw === 'object') {
    criteria = raw.acceptance_criteria ?? raw.acceptanceCriteria ?? [];
    if (!Array.isArray(criteria)) {
      process.stderr.write('[error] manifest must contain an acceptance_criteria or acceptanceCriteria array\n');
      process.exit(1);
    }
  } else {
    process.stderr.write('[error] manifest root must be an object or array\n');
    process.exit(1);
  }

  let warnCount = 0;
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== 'object') continue;
    const cmd = criterion.command;
    if (typeof cmd !== 'string') continue; // array-form is glob-safe by design
    if (containsUnquotedGlobHazard(cmd)) {
      const id = criterion.id || '<no-id>';
      process.stderr.write(
        '[warn] criterion ' + id + ': string command contains unquoted glob hazard — ' +
        'quote globs or convert to string[] form: ' + JSON.stringify(cmd) + '\n'
      );
      warnCount += 1;
    }
  }

  if (warnCount > 0) {
    process.stderr.write('\naudit-ac-command-glob-safety: ' + warnCount + ' warning(s) in ' + manifestFile + '\n');
  } else {
    process.stdout.write('audit-ac-command-glob-safety: no glob hazards found in ' + manifestFile + '\n');
  }

  process.exit(0);
}

main().catch(function(err) {
  process.stderr.write('[fatal] ' + err.message + '\n');
  process.exit(1);
});
NODE
