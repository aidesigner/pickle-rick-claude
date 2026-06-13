#!/usr/bin/env bash
# W5b meta-lint: flag any NEW non-unified skip-flag declaration.
#
# INVARIANT: the only sanctioned skip flag for new quality gates is the unified
# `skip_quality_gates_reason` (W1a). This lint scans the `StateFlags` interface
# in `extension/src/types/index.ts` for `skip_*_reason` field declarations and
# fails when one appears that is not in the documented allow-set:
#   - skip_quality_gates_reason  (the unified surface — W1a)
#   - skip_readiness_reason      (legacy back-compat read — W1a)
#   - skip_ticket_audit_reason   (legacy back-compat read — W1a)
#   - skip_smoke_gate_reason     (W1a ruling-2 survivor)
# A new non-unified skip flag is the "second escape hatch" smell the
# subtract-before-add governance rule forbids (extension/CLAUDE.md).
#
# Exit 0 on success, 1 on a new non-unified skip flag, 2 on missing/unreadable
# types file. The types-file path can be overridden via STATE_FLAGS_FILE (used
# by the test harness to inject a poisoned copy).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TYPES_FILE="${STATE_FLAGS_FILE:-$EXTENSION_ROOT/src/types/index.ts}"

if [ ! -f "$TYPES_FILE" ]; then
  echo "[error: $TYPES_FILE not found]" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 2
fi

node - "$TYPES_FILE" <<'NODE'
const fs = require('fs');
const [, , typesFile] = process.argv;

const ALLOWED = new Set([
  'skip_quality_gates_reason',
  'skip_readiness_reason',
  'skip_ticket_audit_reason',
  'skip_smoke_gate_reason',
]);

let text;
try {
  text = fs.readFileSync(typesFile, 'utf-8');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`audit-skip-flag-unification: cannot read ${typesFile}: ${msg}\n`);
  process.exit(2);
}

const startMatch = text.match(/interface\s+StateFlags\s*\{/);
if (!startMatch) {
  process.stderr.write(`audit-skip-flag-unification: no StateFlags interface in ${typesFile}\n`);
  process.exit(2);
}

// Slice from the opening brace to its matching close (depth-counting).
let depth = 0;
let started = false;
let end = -1;
const from = startMatch.index;
for (let i = from; i < text.length; i++) {
  const ch = text[i];
  if (ch === '{') { depth++; started = true; }
  else if (ch === '}') { depth--; if (started && depth === 0) { end = i; break; } }
}
if (end === -1) {
  process.stderr.write('audit-skip-flag-unification: unterminated StateFlags interface\n');
  process.exit(2);
}

const body = text.slice(from, end);
const DECL_RE = /^\s*(skip_[a-z0-9_]*_reason)\??\s*:/gm;
const violations = [];
let m;
while ((m = DECL_RE.exec(body)) !== null) {
  const name = m[1];
  if (!ALLOWED.has(name)) violations.push(name);
}

if (violations.length > 0) {
  for (const name of violations) {
    process.stderr.write(
      `audit-skip-flag-unification: NEW non-unified skip flag '${name}' in StateFlags — ` +
      `new gates must use the unified 'skip_quality_gates_reason' surface (W5b subtract-before-add). ` +
      `If this is a sanctioned survivor, add it to the allow-set with a justification.\n`,
    );
  }
  process.exit(1);
}

console.log('audit-skip-flag-unification: no non-unified skip flags in StateFlags');
NODE
