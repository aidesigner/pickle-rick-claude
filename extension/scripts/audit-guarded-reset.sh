#!/usr/bin/env bash
# audit-guarded-reset.sh — H3 forward-protection (ticket 0d1590f4).
#
# Fails (exit 1, file:line on stderr) when extension/src/ contains a
# destructive git operation outside the guarded helper:
#   - raw `git reset --hard` (shell-string or array form)
#   - `resetToSha(...)` call without an archive context (no `reason:` arg)
#   - directory-scoped `git restore` (`git restore .` / trailing-slash target)
#     or programmatic array-form restore
#   - directory-scoped `git checkout --` (`git checkout -- .` / trailing-slash
#     target). Explicit-file-list forms (`git checkout -- <paths...>`) stay
#     allowed, matching the R-WSRC-GR hook contract in config-protection.ts
#   - `git clean` / array-form clean / buildCleanArgs() outside the helper
#
# Allowlist: services/git-utils.ts (helper internals), __tests__/fixtures.
# GUARDED_RESET_SRC_OVERRIDE points the scan at a fixture tree for tests.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_ROOT="${GUARDED_RESET_SRC_OVERRIDE:-$EXTENSION_ROOT/src}"

if [ ! -d "$SRC_ROOT" ]; then
  echo "[error: scan root not found: $SRC_ROOT]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

if ! node - "$SRC_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , srcRoot] = process.argv;

const ALLOWLIST_FILES = new Set(['services/git-utils.ts']);
const ALLOWLIST_PATH_SEGMENTS = ['__tests__', 'fixtures'];

function walkTsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(abs, acc);
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(abs);
  }
  return acc;
}

function isAllowlisted(rel) {
  if (ALLOWLIST_FILES.has(rel)) return true;
  const segments = rel.split(path.sep);
  return ALLOWLIST_PATH_SEGMENTS.some((seg) => segments.includes(seg));
}

/** Comment line: `//`, `*` (block-comment body), or `/*` prefix after trim. */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * From the char offset of `resetToSha(`'s opening paren, return the balanced
 * call-argument text (bounded to 4000 chars so a pathological file can't
 * wedge the gate).
 */
function extractCallText(content, openParenIdx) {
  let depth = 0;
  const cap = Math.min(content.length, openParenIdx + 4000);
  for (let i = openParenIdx; i < cap; i++) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return content.slice(openParenIdx, i + 1);
    }
  }
  return content.slice(openParenIdx, cap);
}

const CHECKS = [
  {
    name: 'raw `git reset --hard` (use resetToSha with an archive context)',
    pattern: /git\s+reset\s+--hard|['"]reset['"]\s*,\s*['"]--hard['"]/,
  },
  {
    name: 'directory-scoped `git restore` (name exact files, never a directory)',
    pattern: /git\s+restore\s+(?:--\s+)?(?:\.(?:$|[\s'"`])|[^\s'"`<-][^\s'"`]*\/)|\[\s*['"]restore['"]\s*[,\]]/,
  },
  {
    name: 'directory-scoped `git checkout --` (name exact files, never a directory)',
    pattern: /git\s+checkout\s+--\s+(?:\.(?:$|[\s'"`])|[^\s'"`]*\/)|['"]checkout['"]\s*,\s*['"]--['"]\s*,\s*['"](?:\.|[^'"]*\/)['"]/,
  },
  {
    name: 'raw `git clean` outside the guarded helper',
    pattern: /git\s+clean\b|\[\s*['"]clean['"]\s*[,\]]|buildCleanArgs\s*\(/,
  },
];

const violations = [];
const files = walkTsFiles(srcRoot);

for (const abs of files) {
  const rel = path.relative(srcRoot, abs);
  if (isAllowlisted(rel)) continue;

  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  // Line-scoped pattern checks (comment-aware).
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    for (const check of CHECKS) {
      if (check.pattern.test(line)) {
        violations.push(`${rel}:${idx + 1}: ${check.name}`);
      }
    }
  });

  // resetToSha(...) calls must carry an archive context (a `reason:` arg).
  const callRe = /\bresetToSha\s*\(/g;
  let m;
  while ((m = callRe.exec(content)) !== null) {
    const lineNum = content.slice(0, m.index).split('\n').length;
    const line = lines[lineNum - 1] ?? '';
    if (isCommentLine(line)) continue;
    // declaration, not a call: `function resetToSha(...)`
    if (/function\s+$/.test(content.slice(Math.max(0, m.index - 20), m.index))) continue;
    const callText = extractCallText(content, m.index + m[0].length - 1);
    if (!/\breason\s*:/.test(callText)) {
      violations.push(`${rel}:${lineNum}: resetToSha() without archive context (pass { cwd, sessionDir, ticketDir, reason } as the 4th argument)`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('audit-guarded-reset: unguarded destructive git operation(s) in src/:\n');
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

console.log(`audit-guarded-reset: ${files.length} file(s) scanned, no unguarded destructive callsites`);
NODE
then
  exit 1
fi

exit 0
