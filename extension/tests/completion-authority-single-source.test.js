// @tier: fast
// AC-D4 completion-authority single-source-of-truth invariant.
//
// Complements the AC-D3 shell spine (extension/scripts/audit-design-ground-truth.sh).
// The shell spine owns the `evaluateEpicCompletion({` call-floor; this node test owns
// the broader `evaluateEpicCompletion(` form PLUS the terminal-status producer allowlist,
// so a new out-of-band Done/Skipped seam goes RED here.
//
// Three of the four sub-tests are pure source-grep; the fourth is a fail-injection that
// proves the scanner returns RED on a synthetic out-of-band producer written to a temp tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const srcRoot = path.join(repoRoot, 'extension', 'src');
const muxRunnerPath = path.join(srcRoot, 'bin', 'mux-runner.ts');
const claudeMdPath = path.join(repoRoot, 'extension', 'CLAUDE.md');

// The four files allowed to originate a terminal Done/Skipped write.
const ALLOWLIST = new Set([
  path.join('bin', 'mux-runner.ts'), // canonical authority + its gated Done-flip paths
  path.join('bin', 'setup.ts'), // documented exception: resume-reattach best-effort
  path.join('bin', 'spawn-morty.ts'), // documented exception: worker-side outcome persistence
  path.join('services', 'pickle-utils.ts'), // defines markTicketDone / markTicketSkipped
]);

/** Recursively collect every non-`.d.ts` `.ts` file under `dir`. */
function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(full);
    }
  }
  return result;
}

/**
 * A terminal-status frontmatter write: an object-literal `status:` key immediately
 * assigned a `'Done'` / `'Skipped'` string literal. This is the form that
 * `updateTicketFrontmatter({ status: 'Done', ... })` (the lower-level rewriter at
 * setup.ts:1225 / spawn-morty.ts:1563) and any raw `status: 'Done'` object write take.
 *
 * Tuned to AVOID false positives on the green tree:
 *  - requires the `status:` COLON form, so `status === 'Done'` equality checks (triple-equals,
 *    no colon) are NOT matched;
 *  - matches only `'Done'`/`'Skipped'`, so `status: 'Failed'` / `status: 'Todo'` writes
 *    (the Failed/Todo paths at mux-runner.ts / pickle-recover.ts / salvage-ticket.ts) are spared;
 *  - applied only to NON-COMMENT lines (see filter below), so documented mentions don't trip it;
 *  - on the current green tree the ONLY src/ lines that match are the two allowlisted
 *    Done-writers (setup.ts, spawn-morty.ts), so it adds NO new producer file.
 *
 * WHY THIS PREDICATE EXISTS (the AC-D4 crux): without it a NEW out-of-band seam that flips
 * Done via `updateTicketFrontmatter({ status: 'Done' })` in a brand-new file — bypassing the
 * markTicket* primitives entirely — would ESCAPE the invariant. That false-negative would defeat
 * the ticket's durability claim. The markTicket* check alone is necessary but not sufficient.
 */
const TERMINAL_STATUS_WRITE_RE = /\bstatus:\s*['"](?:Done|Skipped)['"]/;

/**
 * Reusable scanner: returns the src-relative paths of files under `scanRoot` that contain a
 * terminal-status producer on a NON-COMMENT line but are NOT in the allowlist. A producer is
 * EITHER a `markTicketDone(` / `markTicketSkipped(` primitive call OR a terminal-status
 * frontmatter write (`status: 'Done'` / `status: 'Skipped'` — see TERMINAL_STATUS_WRITE_RE).
 *
 * The comment-line filter is REQUIRED: pipeline-runner.ts mentions `markTicketDone` in a
 * JSDoc comment and MUST NOT trip the invariant. A real out-of-band seam adds the call/write on a
 * non-comment line — exactly what this catches.
 */
function findOutOfBandProducers(scanRoot) {
  const violations = [];
  for (const filePath of walkTs(scanRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const isProducer = content.split('\n').some((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      if (trimmed.includes('markTicketDone(') || trimmed.includes('markTicketSkipped(')) return true;
      return TERMINAL_STATUS_WRITE_RE.test(trimmed);
    });
    if (!isProducer) continue;
    const relPath = path.relative(scanRoot, filePath);
    if (!ALLOWLIST.has(relPath)) {
      violations.push(relPath);
    }
  }
  return violations;
}

// Call-floors. Live counts (grep -c) at authoring time: evaluateEpicCompletion( = 3,
// guardCompletionCommitBeforeDone( = 7, applyAllTicketsDoneCompletion( = 2. Floors set
// conservatively below actual so refactors that preserve the authority stay green.
const EVAL_EPIC_FLOOR = 2;
const GUARD_DONE_FLOOR = 5;
const APPLY_ALL_DONE_FLOOR = 1;

const muxRunnerContent = fs.readFileSync(muxRunnerPath, 'utf8');
const claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8');

test('CHECK A: no extension/src/ file outside the 4-file allowlist contains a terminal-status producer', () => {
  const violations = findOutOfBandProducers(srcRoot);
  assert.equal(
    violations.length,
    0,
    'Out-of-band terminal-status producer(s) detected outside the canonical allowlist ' +
      '(bin/mux-runner.ts, bin/setup.ts, bin/spawn-morty.ts, services/pickle-utils.ts):\n' +
      violations.map((v) => `  ${v}`).join('\n'),
  );
});

test('CHECK B: canonical completion-authority functions meet minimum call-site floors in mux-runner.ts', () => {
  const evalCount = (muxRunnerContent.match(/evaluateEpicCompletion\(/g) || []).length;
  const guardCount = (muxRunnerContent.match(/guardCompletionCommitBeforeDone\(/g) || []).length;
  const applyCount = (muxRunnerContent.match(/applyAllTicketsDoneCompletion\(/g) || []).length;

  assert.ok(
    evalCount >= EVAL_EPIC_FLOOR,
    `evaluateEpicCompletion( count ${evalCount} < floor ${EVAL_EPIC_FLOOR} — a completion ` +
      'decision stopped routing through the canonical evaluateEpicCompletion authority.',
  );
  assert.ok(
    guardCount >= GUARD_DONE_FLOOR,
    `guardCompletionCommitBeforeDone( count ${guardCount} < floor ${GUARD_DONE_FLOOR} — a ` +
      'Done-flip stopped passing through the canonical guardCompletionCommitBeforeDone gate.',
  );
  assert.ok(
    applyCount >= APPLY_ALL_DONE_FLOOR,
    `applyAllTicketsDoneCompletion( count ${applyCount} < floor ${APPLY_ALL_DONE_FLOOR} — the ` +
      'all-tickets-done short-circuit stopped routing through the canonical authority.',
  );
});

test('CHECK C: extension/CLAUDE.md names all three canonical completion-authority functions and the invariant token', () => {
  assert.ok(
    claudeMdContent.includes('evaluateEpicCompletion'),
    'extension/CLAUDE.md missing evaluateEpicCompletion — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('applyAllTicketsDoneCompletion'),
    'extension/CLAUDE.md missing applyAllTicketsDoneCompletion — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('guardCompletionCommitBeforeDone'),
    'extension/CLAUDE.md missing guardCompletionCommitBeforeDone — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('completion-authority') || claudeMdContent.includes('single-source'),
    'extension/CLAUDE.md missing the completion-authority/single-source invariant row',
  );
});

test('FAIL-INJECTION: findOutOfBandProducers flags a real out-of-band producer and spares an allowlisted one', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-d4-inject-'));
  try {
    // Out-of-band seam: a NEW file with a real (non-comment) markTicketDone call.
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinDir, 'evil-seam.ts'),
      'markTicketDone(sessionDir, ticketId);\n',
      'utf8',
    );

    // Allowlisted producer written at an allowlisted relative path must NOT be flagged.
    const fakeServicesDir = path.join(tmpRoot, 'services');
    fs.mkdirSync(fakeServicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeServicesDir, 'pickle-utils.ts'),
      'export function markTicketDone() {}\n',
      'utf8',
    );

    const violations = findOutOfBandProducers(tmpRoot);

    assert.ok(
      violations.includes(path.join('bin', 'evil-seam.ts')),
      `fail-injection: evil-seam.ts was NOT flagged as out-of-band (violations: ${JSON.stringify(violations)})`,
    );
    assert.ok(
      !violations.includes(path.join('services', 'pickle-utils.ts')),
      'fail-injection: allowlisted pickle-utils.ts was incorrectly flagged as a violation',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('FAIL-INJECTION (updateTicketFrontmatter-Done escape): a new seam flipping Done WITHOUT markTicket* is still caught', () => {
  // The crux of AC-D4: research found setup.ts:1225 and spawn-morty.ts:1563 flip Done via
  // `updateTicketFrontmatter({ status: 'Done' })` — NOT the markTicket* primitives. A new
  // out-of-band file using that same form (or a raw `status: 'Done'` object write) would escape
  // a markTicket*-only scanner. This proves the terminal-status frontmatter predicate closes it,
  // while the Failed/Todo writers and `status ===` equality checks stay spared.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-d4-fm-inject-'));
  try {
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });

    // (1) Out-of-band Done flip via updateTicketFrontmatter — the escape this predicate closes.
    fs.writeFileSync(
      path.join(fakeBinDir, 'frontmatter-done-seam.ts'),
      "export function flip(p: string) {\n" +
        "  updateTicketFrontmatter(p, sessionDir, { status: 'Done', completion_commit: sha });\n" +
        "}\n",
      'utf8',
    );

    // (2) Out-of-band raw Skipped object-literal write — the other terminal-status form.
    fs.writeFileSync(
      path.join(fakeBinDir, 'raw-skipped-seam.ts'),
      "const frontmatter = { status: 'Skipped' };\n",
      'utf8',
    );

    // Decoys that MUST NOT be flagged (false-positive guards on the green-tree shapes):
    fs.writeFileSync(
      path.join(fakeBinDir, 'failed-decoy.ts'),
      "updateTicketFrontmatter(p, sessionDir, { status: 'Failed', completion_commit: null });\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'todo-decoy.ts'),
      "updateTicketFrontmatter(p, sessionDir, { status: 'Todo', completion_commit: null });\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'equality-decoy.ts'),
      "if (t.status === 'Done' || t.status === 'Skipped') { return true; }\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'comment-decoy.ts'),
      "// updateTicketFrontmatter(p, { status: 'Done' }) — only documented in a comment\n",
      'utf8',
    );

    const violations = findOutOfBandProducers(tmpRoot);

    // Escapes are caught:
    assert.ok(
      violations.includes(path.join('bin', 'frontmatter-done-seam.ts')),
      `updateTicketFrontmatter-Done seam was NOT flagged — the AC-D4 escape is open ` +
        `(violations: ${JSON.stringify(violations)})`,
    );
    assert.ok(
      violations.includes(path.join('bin', 'raw-skipped-seam.ts')),
      `raw status:'Skipped' object-literal write was NOT flagged (violations: ${JSON.stringify(violations)})`,
    );

    // Decoys are spared (no false positives):
    for (const decoy of ['failed-decoy.ts', 'todo-decoy.ts', 'equality-decoy.ts', 'comment-decoy.ts']) {
      assert.ok(
        !violations.includes(path.join('bin', decoy)),
        `false positive: ${decoy} was incorrectly flagged as a terminal-status producer`,
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
