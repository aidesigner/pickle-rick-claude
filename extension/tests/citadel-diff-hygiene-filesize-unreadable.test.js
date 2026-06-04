// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditDiffHygiene } from '../services/citadel/diff-hygiene.js';

// auditDiffHygiene runs UNWRAPPED by safeRunAnalyzer in audit-runner.ts:102, so a
// throw out of fileSize() crashes the ENTIRE Citadel audit, not just this analyzer.
// fileSize previously did existsSync(fullPath) then statSync(fullPath).size; that
// existsSync/statSync pair has a TOCTOU window (file removed between the two calls)
// AND a naked statSync revert would throw on any unstattable added path. The fix
// drops existsSync and wraps statSync in try/catch -> 0. This test pins the
// invariant: a stat-throwing added path must yield size 0, never an exception.

function addedFile(filePath) {
  return {
    path: filePath,
    status: 'A',
    kind: 'other',
    changedLines: [],
    blame: [],
  };
}

function diffWith(repoRoot, changedFiles) {
  return {
    range: 'BASE..HEAD',
    base: 'BASE',
    head: 'HEAD',
    repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('citadel diff-hygiene fileSize stat failure', () => {
  test('does not throw when an added file path cannot be statSync-ed (ENOTDIR)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diffhygiene-'));
    try {
      // A regular file at `blocker` makes `blocker/child.bin` unstattable -> ENOTDIR.
      // Pre-fix this returned 0 via existsSync's swallow; a naked-statSync regression
      // throws here and crashes the unwrapped audit. The guard must swallow it.
      fs.writeFileSync(path.join(repoRoot, 'blocker'), 'x');
      const diff = diffWith(repoRoot, [addedFile('blocker/child.bin')]);

      let report;
      assert.doesNotThrow(() => {
        report = auditDiffHygiene(diff);
      });
      assert.equal(report.summary.added_files_scanned, 1);
      // size resolved to 0, so no large-unignored-file finding for the bad path.
      assert.equal(report.findings.filter((f) => f.rule === 'large-unignored-file').length, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('still flags a genuinely large unignored added file (data flow intact)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diffhygiene-'));
    try {
      // 1 MiB + 1 byte exceeds LARGE_FILE_BYTES (1 MiB).
      fs.writeFileSync(path.join(repoRoot, 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
      const diff = diffWith(repoRoot, [addedFile('big.bin')]);

      const report = auditDiffHygiene(diff);
      const large = report.findings.filter((f) => f.rule === 'large-unignored-file');
      assert.equal(large.length, 1, 'large file must still be flagged');
      assert.equal(large[0].size_bytes, 1024 * 1024 + 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
