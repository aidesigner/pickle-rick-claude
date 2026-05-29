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
  // Try exported function first, then non-exported
  let start = source.indexOf(`export function ${name}(`);
  if (start === -1) start = source.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`missing function ${name}`);
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

// --- correctPhantomDoneTickets ---
// R-AFCC-DEEP-3B: decision matrix delegated to batchLoopPhantomDoneKind helper.
// Check: the loop calls the helper before writeTicketStatus.
const phantomBody = extractFunctionBody('correctPhantomDoneTickets');
assertIncludesBefore(
  phantomBody,
  'batchLoopPhantomDoneKind(',
  "if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo')) continue;",
  'correctPhantomDoneTickets',
);

// --- batchLoopPhantomDoneKind ---
// R-RIC-EXPLICIT-4: only `inferred` evidence (gitCommitExists/grep-verified)
// short-circuits; `explicit` and `absent` MUST fall through to the reachability
// gate so a stamped-but-unreachable completion_commit still reverts a phantom Done.
const batchHelperBody = extractFunctionBody('batchLoopPhantomDoneKind');
if (!batchHelperBody.includes('hasCompletionCommit(')) {
  throw new Error("batchLoopPhantomDoneKind: missing hasCompletionCommit call (R-RIC-EXPLICIT-4)");
}
if (!batchHelperBody.includes("evidence.source === 'inferred'")) {
  throw new Error("batchLoopPhantomDoneKind: missing inferred-source check (R-RIC-EXPLICIT-4)");
}
if (!batchHelperBody.includes('phantomDoneShouldKeepDone(')) {
  throw new Error("batchLoopPhantomDoneKind: missing reachability gate for explicit/absent sources (R-RIC-EXPLICIT-4)");
}

// --- validateAutoTicketCompletion ---
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

// --- inspectPhantomDoneTicketFile ---
// R-AFCC-DEEP-3B: decision logic delegated to applyInspectPhantomDoneDecision helper.
const inspectBody = extractFunctionBody('inspectPhantomDoneTicketFile');
if (!inspectBody.includes('applyInspectPhantomDoneDecision(')) {
  throw new Error("inspectPhantomDoneTicketFile: missing applyInspectPhantomDoneDecision delegation (R-AFCC-DEEP-3B)");
}

// --- applyInspectPhantomDoneDecision ---
// Must call hasCompletionCommit before writeTicketStatus (R-ICP-5 gate ordering).
const applyBody = extractFunctionBody('applyInspectPhantomDoneDecision');
assertIncludesBefore(
  applyBody,
  'hasCompletionCommit(',
  'writeTicketStatus(',
  'applyInspectPhantomDoneDecision',
);

console.log('audit-phantom-done-call-sites: all phantom-Done gates consult hasCompletionCommit first');
NODE
