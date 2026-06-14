// @tier: fast
// Regression guard for anatomy-park finding
// `extension-trapdoor-afcc-deep-pattern-shape-drift`.
//
// R-AFCC-DEEP-4A migrated mux-runner.ts off `hasCompletionCommit` /
// `autoFillCompletionCommit` onto `readEvidence` / `persistEvidence`, but the
// R-WUWC SOFT-variant and R-CCRC-2 trap-door entries in extension/CLAUDE.md kept
// pointing their PATTERN_SHAPE replay anchors at the deleted `autoFillCompletionCommit(`
// symbol. A replay anchor that names a symbol absent from the file can never match,
// so the trap door's second line of defense silently dies. This test pins the two
// trap-door entries to the symbols that actually implement the invariant in the
// source — it fails if either the prose drifts back to the stale symbol OR the
// source loses the real auto-promotion wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const claudeMdPath = path.join(repoRoot, 'extension', 'CLAUDE.md');
const muxRunnerPath = path.join(repoRoot, 'extension', 'src', 'bin', 'mux-runner.ts');

const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
const muxRunner = fs.readFileSync(muxRunnerPath, 'utf8');

/** Pull a single trap-door bullet (one `- ...` line) by a unique substring. */
function trapDoorEntry(needle) {
  const line = claudeMd
    .split('\n')
    .find((l) => l.trimStart().startsWith('- ') && l.includes(needle));
  assert.ok(line, `trap-door entry containing "${needle}" not found in extension/CLAUDE.md`);
  return line;
}

test('R-WUWC SOFT-variant trap door names the live persistEvidence anchor, not the migrated-away autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-WUWC SOFT-variant auto-promote');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-WUWC trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('persistEvidence('),
    'R-WUWC trap door must reference the current persistEvidence( auto-promotion call',
  );
  assert.ok(
    entry.includes("inferred-fresh"),
    'R-WUWC trap door must reference the current inferred-fresh evidence kind',
  );
});

test('R-CCRC-2 trap door names the inline upsertFrontmatterField anchor, not autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-CCRC-2 done-flip guard routing');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-CCRC-2 trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('upsertFrontmatterField('),
    'R-CCRC-2 trap door must reference the inline upsertFrontmatterField( completion_commit persist',
  );
});

test('mux-runner.ts implements completion-evidence auto-promotion via persistEvidence/upsertFrontmatterField (post R-AFCC-DEEP-4A)', () => {
  // The migrated-away symbol must be gone from THIS file (it legitimately still
  // lives in spawn-morty.ts / auto-fill-completion-commit.ts).
  assert.ok(
    !muxRunner.includes('autoFillCompletionCommit'),
    'mux-runner.ts unexpectedly references autoFillCompletionCommit — trap doors assume it was migrated out',
  );
  // The live anchors the trap-door PATTERN_SHAPEs now point at must be present.
  for (const symbol of [
    'persistEvidence(',
    'upsertFrontmatterField(',
    'guardCompletionCommitBeforeDone',
    'clearStaleDoneWithoutCommitEvidence',
    'markTicketDone',
    "'inferred-fresh'",
  ]) {
    assert.ok(
      muxRunner.includes(symbol),
      `mux-runner.ts missing trap-door PATTERN_SHAPE anchor: ${symbol}`,
    );
  }
});
