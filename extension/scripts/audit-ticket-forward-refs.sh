#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SESSION_DIR="${1:-}"
if [ -z "$SESSION_DIR" ]; then
  SESSION_DIR="${SESSION_ROOT:-}"
fi

if [ -z "$SESSION_DIR" ]; then
  echo "[error] usage: $0 <session-dir>" >&2
  exit 1
fi

if [ ! -d "$SESSION_DIR" ]; then
  echo "[error] directory not found: $SESSION_DIR" >&2
  exit 1
fi

# Delegate annotation grammar check to R-FRA-6 shared predicate via Node helper.
# NO inline FORWARD_REF_ANNOTATION_RE — imported from forward-ref-annotation.js.
node - "$SESSION_DIR" "$EXTENSION_ROOT" <<'NODE'
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const [, , sessionDir, extensionRoot] = process.argv;

async function main() {
  const modUrl = pathToFileURL(
    path.join(extensionRoot, 'services', 'forward-ref-annotation.js')
  ).href;
  const { FORWARD_REF_ANNOTATION_RE } = await import(modUrl);

  const ticketFiles = [];
  function scanDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.name.endsWith('.md')) {
        ticketFiles.push(full);
      }
    }
  }
  scanDir(sessionDir);

  let hasUnannotated = false;
  for (const file of ticketFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const issues = checkForwardRefs(content, FORWARD_REF_ANNOTATION_RE);
    for (const issue of issues) {
      process.stderr.write(
        `[error] ${path.relative(sessionDir, file)}: unannotated forward-ref: ${issue}\n`
      );
      hasUnannotated = true;
    }
  }

  process.exit(hasUnannotated ? 2 : 0);
}

function checkForwardRefs(content, forwardRefRe) {
  const issues = [];
  const lines = content.split('\n');
  let inFilesCreate = false;

  for (const line of lines) {
    if (/^##\s+Files?\s+to\s+create/i.test(line)) {
      inFilesCreate = true;
      continue;
    }
    if (/^##/.test(line)) {
      inFilesCreate = false;
      continue;
    }
    if (!inFilesCreate) continue;

    const backtickRe = /`([^`]+)`/g;
    let match;
    while ((match = backtickRe.exec(line)) !== null) {
      const token = match[1];
      if (!looksLikeFilePath(token)) continue;
      const segment = line.slice(match.index);
      const re = new RegExp(forwardRefRe.source, forwardRefRe.flags.replace('g', ''));
      if (!re.test(segment)) {
        issues.push(token);
      }
    }
  }
  return issues;
}

function looksLikeFilePath(token) {
  return token.includes('/') || /\.\w{1,5}$/.test(token);
}

main().catch((err) => {
  process.stderr.write('[fatal] ' + err.message + '\n');
  process.exit(1);
});
NODE
