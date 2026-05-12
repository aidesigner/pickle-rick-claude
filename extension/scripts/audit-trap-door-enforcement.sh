#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
CLAUDE_PATH="${CLAUDE_PATH_OVERRIDE:-$EXTENSION_ROOT/CLAUDE.md}"

if [ ! -f "$CLAUDE_PATH" ]; then
  echo "[skipped: extension/CLAUDE.md not found]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

audit_exit_code=0

fail() {
  echo "$1" >&2
  audit_exit_code=1
}

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-CNAR-1 part 2 cap split)'));

if (!entry) {
  process.stderr.write('R-CNAR-7 trap-door entry not found\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-CNAR-7 trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
NODE
then
  audit_exit_code=1
fi

# Parse ENFORCE: references and check reachability via node so we get the
# same regex as trap-door-conformance.test.js (avoids BSD/GNU grep -P gap).
if ! node - "$CLAUDE_PATH" "$EXTENSION_ROOT" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, claudePath, extensionRoot, repoRoot] = process.argv;

const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');

const VALID_TIERS = new Set(['fast', 'integration', 'expensive', 'contract']);

// Collect all ENFORCE: test file references using the same regex as
// extractEnforceTestFiles() in trap-door-conformance.test.js.
const enforceFiles = new Map(); // relative path -> line number

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('ENFORCE:')) continue;

  // Gather entry text (current line + continuation until next entry/section)
  let entryText = line;
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('## ')) {
    entryText += '\n' + lines[j];
    j++;
  }

  const matches = entryText.matchAll(/\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b/g);
  for (const m of matches) {
    if (!enforceFiles.has(m[1])) {
      enforceFiles.set(m[1], i + 1);
    }
  }
}

let failures = 0;

for (const [rel, lineNum] of enforceFiles) {
  // Resolve: 'extension/tests/...' → repo root; 'tests/...' → extension root
  const absPath = rel.startsWith('extension/')
    ? path.join(repoRoot, rel)
    : path.join(extensionRoot, rel);

  if (!fs.existsSync(absPath)) {
    process.stderr.write(`ENFORCE: line ${lineNum}: missing file: ${rel}\n`);
    failures++;
    continue;
  }

  // Read first meaningful line (skip shebang and blank lines)
  const fileContent = fs.readFileSync(absPath, 'utf8');
  const firstMeaningful = fileContent.split(/\r?\n/).find(
    l => !l.startsWith('#!') && l.trim() !== ''
  ) ?? '';

  const tierMatch = firstMeaningful.match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
  if (!tierMatch || !VALID_TIERS.has(tierMatch[1])) {
    process.stderr.write(
      `ENFORCE: line ${lineNum}: no valid @tier annotation in ${rel} (first line: ${firstMeaningful.substring(0, 80)})\n`
    );
    failures++;
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} ENFORCE reference(s) unreachable\n`);
  process.exit(1);
}

console.log(`audit-trap-door-enforcement: ${enforceFiles.size} ENFORCE reference(s) verified`);
NODE
then
  audit_exit_code=1
fi

if ! bash "$SCRIPT_DIR/audit-phantom-done-call-sites.sh"; then
  audit_exit_code=1
fi

if rg -n -e "npm (ci|install)" \
  "$EXTENSION_ROOT/src/bin/spawn-morty.ts" \
  "$EXTENSION_ROOT/src/bin/mux-runner.ts" >/dev/null; then
  fail 'worker boot paths must reuse extension/node_modules; found npm ci/install in spawn-morty.ts or mux-runner.ts'
fi

exit "$audit_exit_code"
