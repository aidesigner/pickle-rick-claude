// @tier: fast
// AC-WIRE-1: the new modules + subcommands from this bundle are reachable from the
// public surface — pickle-recover is registered as a slash command, and every new
// lib export (salvageTicket, reconcileTicketTruth) has >=1 non-definition,
// non-test call-site in src/ (no compiling-but-unwired dead-code scaffolding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const COMMANDS_DIR = path.join(REPO_ROOT, '.claude/commands');
const SRC_DIR = path.join(REPO_ROOT, 'extension/src');

function readCommand(filename) {
  return fs.readFileSync(path.join(COMMANDS_DIR, filename), 'utf8');
}

/** Recursively collect every `.ts` file under `dir`. */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Files (relative to src/) that REFERENCE `symbol` outside its own definition file.
 * A reference counts only if the line contains the symbol as a word AND is not a
 * pure `import` of the symbol — we require at least one non-import usage so a bare
 * re-export cannot masquerade as a call-site.
 */
function nonDefCallSites(symbol, defFileRel) {
  const wordRe = new RegExp(`\\b${symbol}\\b`);
  const hits = [];
  for (const file of collectTsFiles(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file);
    if (rel === defFileRel) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const usageLines = lines.filter((l) => {
      if (!wordRe.test(l)) return false;
      const trimmed = l.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false; // comment-only
      if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) return false;
      return true;
    });
    if (usageLines.length > 0) hits.push({ rel, count: usageLines.length });
  }
  return hits;
}

const RECOVER_SUBCOMMANDS = ['--resume-from-todo', '--salvage', '--reattach-orphan', '--reset-ticket'];

test('AC-WIRE-1 (a): pickle-recover command wrapper exists and names the 4 subcommands + --plan', () => {
  const command = readCommand('pickle-recover.md');
  assert.match(command, /extension\/bin\/pickle-recover\.js/, 'must invoke the pickle-recover bin');
  for (const sub of RECOVER_SUBCOMMANDS) {
    assert.match(command, new RegExp(sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `must document ${sub}`);
  }
  assert.match(command, /--plan/, 'must document the --plan dry-run');
});

test('AC-WIRE-1 (a): README registers /pickle-recover (Documentation Rule)', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\/pickle-recover/, 'README must list /pickle-recover');
});

test('AC-WIRE-1 (b): salvageTicket has >=1 non-definition, non-test call-site in src/', () => {
  const hits = nonDefCallSites('salvageTicket', 'lib/salvage-ticket.ts');
  assert.ok(hits.length >= 1, `salvageTicket is orphaned — no non-def call-site found`);
  // pinned seams: mux-runner (W3 exit/failed-flip) + pickle-recover (operator command)
  const files = hits.map((h) => h.rel);
  assert.ok(files.includes('bin/mux-runner.ts'), 'expected mux-runner.ts salvage seam');
  assert.ok(files.includes('bin/pickle-recover.ts'), 'expected pickle-recover.ts salvage call');
});

test('AC-WIRE-1 (b): reconcileTicketTruth has >=1 non-definition, non-test call-site in src/', () => {
  const hits = nonDefCallSites('reconcileTicketTruth', 'lib/reconcile-ticket-truth.ts');
  assert.ok(hits.length >= 1, `reconcileTicketTruth is orphaned — no non-def call-site found`);
  const files = hits.map((h) => h.rel);
  // single ground-truth read consumed by the salvage primitive + the operator command
  assert.ok(files.includes('lib/salvage-ticket.ts'), 'expected salvage-ticket.ts reconcile read');
});

test('AC-WIRE-1 (c): no orphaned new module — each new lib is imported by >=1 other src file', () => {
  const newLibs = [
    { def: 'lib/salvage-ticket.ts', importNeedle: 'salvage-ticket.js' },
    { def: 'lib/reconcile-ticket-truth.ts', importNeedle: 'reconcile-ticket-truth.js' },
  ];
  for (const { def, importNeedle } of newLibs) {
    const importers = collectTsFiles(SRC_DIR).filter((file) => {
      if (path.relative(SRC_DIR, file) === def) return false;
      return fs.readFileSync(file, 'utf8').includes(importNeedle);
    });
    assert.ok(importers.length >= 1, `${def} is orphaned — no src/ importer of ${importNeedle}`);
  }
});
