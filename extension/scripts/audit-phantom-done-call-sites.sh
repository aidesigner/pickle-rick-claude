#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$EXTENSION_ROOT/src/bin/mux-runner.ts"

if [ ! -f "$TARGET" ]; then
  echo "audit-phantom-done-call-sites: missing $TARGET" >&2
  exit 1
fi

node - "$TARGET" <<'NODE'
const fs = require('fs');

const [, , filePath] = process.argv;
const source = fs.readFileSync(filePath, 'utf8');

function extractFunctionBody(name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) {
    throw new Error(`missing export function ${name}`);
  }
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`missing opening brace for ${name}`);
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function assertIncludesBefore(body, needle, beforeNeedle, label) {
  const needleIndex = body.indexOf(needle);
  if (needleIndex === -1) throw new Error(`${label}: missing "${needle}"`);
  const beforeIndex = body.indexOf(beforeNeedle);
  if (beforeIndex === -1) throw new Error(`${label}: missing "${beforeNeedle}"`);
  if (needleIndex > beforeIndex) {
    throw new Error(`${label}: "${needle}" must appear before "${beforeNeedle}"`);
  }
}

const phantomBody = extractFunctionBody('correctPhantomDoneTickets');
assertIncludesBefore(
  phantomBody,
  'const evidence = hasCompletionCommit(',
  "if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo')) continue;",
  'correctPhantomDoneTickets',
);
if (!phantomBody.includes("if (evidence.source !== 'absent') continue;")) {
  throw new Error("correctPhantomDoneTickets: missing absent-source guard");
}

const validateBody = extractFunctionBody('validateAutoTicketCompletion');
assertIncludesBefore(
  validateBody,
  'const evidence = hasCompletionCommit(',
  "return { action: 'skip', reason: 'no_commit_referencing_ticket_since_current_set' };",
  'validateAutoTicketCompletion',
);
if (!validateBody.includes("if (evidence.source === 'absent')")) {
  throw new Error("validateAutoTicketCompletion: missing absent-source branch");
}

const inspectBody = extractFunctionBody('inspectPhantomDoneTicketFile');
assertIncludesBefore(
  inspectBody,
  'const evidence = hasCompletionCommit(',
  "const wrote = writeTicketStatus(sessionDir, ticketId, priorStatus);",
  'inspectPhantomDoneTicketFile',
);

console.log('audit-phantom-done-call-sites: all phantom-Done gates consult hasCompletionCommit first');
NODE
