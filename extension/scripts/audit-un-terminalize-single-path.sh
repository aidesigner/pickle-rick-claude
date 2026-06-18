#!/usr/bin/env bash
# WS2 (B-GROUND2 ticket 005c63c9) un-terminalize single-path enforcement.
#
# INVARIANT: `pickle-recover --reactivate` is the ONLY sanctioned write that flips a
# TERMINAL session ({active:false, step:'completed'}) back to runnable. The defining
# fingerprint of an un-terminalize transition is a single state mutator that sets BOTH
# `active` to `true` AND `step` to a value OTHER than 'completed' (the ticket's wording:
# "active: true / step: away from 'completed'"). At HEAD that fingerprint matches exactly
# one site — pickle-recover.ts:348-353. This is a default-DENY source-grep: any file NOT on
# the sanctioned-writer allowlist that carries the paired fingerprint FAILS the build.
#
# Sanctioned writers (allowlist):
#   - bin/pickle-recover.ts        (the --reactivate primitive — the un-terminalize authority)
#   - bin/setup.ts                 (the --resume reactivation path)
#   - services/state-manager.ts    (WS1 finalizeIfTrulyComplete / finalizeTerminalState —
#                                    forward-listed because it touches `step`; never an
#                                    un-terminalize, but must not false-RED)
#
# Default-DENY everything else. The scan ALSO positive-asserts the authority is reachable:
# pickle-recover.ts MUST carry the paired fingerprint (so the scan can never silently no-op)
# and finalizeIfTrulyComplete MUST exist in state-manager.ts.
#
# Exit 0 = single-path intact. Nonzero = an out-of-allowlist un-terminalize writer (or a
# missing authority). SOURCE_ROOT override (defaults to "$EXTENSION_ROOT/src") lets the
# fail-injection test re-target a TEMP COPY without editing real source.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$EXTENSION_ROOT/src}"

audit_exit_code=0
fail() {
  echo "audit-un-terminalize-single-path: $1" >&2
  audit_exit_code=1
}

if [ ! -d "$SOURCE_ROOT" ]; then
  fail "SOURCE_ROOT not found: $SOURCE_ROOT"
  exit "$audit_exit_code"
fi
if ! command -v node >/dev/null 2>&1; then
  fail "node is required"
  exit "$audit_exit_code"
fi

_uts_script="$(mktemp -t audit-uts.XXXXXX.cjs)"
cat > "$_uts_script" <<'NODE_EOF'
const fs = require("fs");
const path = require("path");

const root = process.env.SOURCE_ROOT;

// Repo-relative paths of the sanctioned un-terminalize writers (default-DENY everything else).
const ALLOWLIST = new Set([
  path.join("bin", "pickle-recover.ts"),   // --reactivate primitive (the authority)
  path.join("bin", "setup.ts"),            // --resume reactivation path
  path.join("services", "state-manager.ts"), // WS1 finalizeIfTrulyComplete (forward-listed)
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue; // *.spec.ts fixtures are not runtime writers
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Extract every balanced-brace `{ ... }` block that follows a mutator-callback arrow
// (`s =>`, `(s) =>`, `(s: State) =>`). These are the state-mutator bodies that the
// StateManager.update / forceWriteMutate sites run. Multi-line aware.
function mutatorBodies(src) {
  const out = [];
  const re = /\(?\s*[A-Za-z_$][\w$]*\s*(?::[^=)]+)?\)?\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

// The un-terminalize fingerprint inside one mutator body:
//   sets active -> true  (active = true | active: true)
//   AND sets step -> a value other than 'completed'
//        (step = ident | step = 'x' | step: 'x', where the string literal is not 'completed').
const ACTIVE_TRUE_RE = /\bactive\s*[:=]\s*true\b/;
const STEP_WRITE_RE = /\bstep\s*[:=]\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$.]*))/g;

function hasUnterminalizeFingerprint(body) {
  if (!ACTIVE_TRUE_RE.test(body)) return false;
  STEP_WRITE_RE.lastIndex = 0;
  let m;
  while ((m = STEP_WRITE_RE.exec(body)) !== null) {
    const literal = m[1] !== undefined ? m[1] : m[2];
    if (literal !== undefined) {
      // String-literal step write: un-terminalize iff NOT 'completed'.
      if (literal !== "completed") return true;
    } else {
      // Identifier/expression step write paired with active:true is also a reactivation.
      return true;
    }
  }
  return false;
}

const offenders = [];
const files = walk(root, []);
let authorityFingerprintSeen = false;

for (const file of files) {
  const rel = path.relative(root, file);
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
  let flagged = false;
  for (const body of mutatorBodies(src)) {
    if (hasUnterminalizeFingerprint(body)) {
      flagged = true;
      if (rel === path.join("bin", "pickle-recover.ts")) authorityFingerprintSeen = true;
    }
  }
  if (flagged && !ALLOWLIST.has(rel)) {
    offenders.push(
      "out-of-allowlist un-terminalize writer (active:true + step!='completed' in one mutator): " + rel,
    );
  }
}

// Positive assertions: the authority must be reachable so the scan can never silently no-op.
if (!authorityFingerprintSeen) {
  offenders.push(
    "authority missing: bin/pickle-recover.ts no longer carries the paired active:true + step:'<non-completed>' " +
    "un-terminalize fingerprint — the --reactivate single-path authority is gone or moved.",
  );
}
const smPath = path.join(root, "services", "state-manager.ts");
let smSrc = "";
try { smSrc = fs.readFileSync(smPath, "utf8"); } catch { /* reported below */ }
if (!/\bfinalizeIfTrulyComplete\b/.test(smSrc)) {
  offenders.push(
    "forward-list target missing: finalizeIfTrulyComplete not found in services/state-manager.ts " +
    "(WS1 helper must remain on the allowlist).",
  );
}

if (offenders.length > 0) { for (const o of offenders) console.log("OFFENDER " + o); }
else console.log("OK");
NODE_EOF

uts_out="$(SOURCE_ROOT="$SOURCE_ROOT" node "$_uts_script" 2>&1)"
rm -f "$_uts_script"

if ! printf '%s\n' "$uts_out" | grep -q '^OK$'; then
  while IFS= read -r line; do
    [ -n "$line" ] && fail "$line"
  done <<< "$uts_out"
fi

if [ "$audit_exit_code" -eq 0 ]; then
  echo "audit-un-terminalize-single-path: OK — un-terminalize single-path intact in $SOURCE_ROOT"
fi

exit "$audit_exit_code"
