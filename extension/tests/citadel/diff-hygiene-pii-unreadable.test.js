// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditDiffHygiene } from '../../services/citadel/diff-hygiene.js';

// auditDiffHygiene runs UNWRAPPED by safeRunAnalyzer in audit-runner.ts, so a throw from
// readAddedFileText crashes the ENTIRE Citadel audit. R-HRP-4 wraps readFileSync in
// try/catch returning '' so TOCTOU-deleted or unreadable fixture files degrade to
// no-PII-found instead of crashing the whole run.

function diffWith(repoRoot, changedFiles) {
  return {
    range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

function addedFixture(filePath) {
  return { path: filePath, status: 'A', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] };
}

describe('diff-hygiene readAddedFileText fail-open guard (R-HRP-4)', () => {
  test('does not throw when a fixture file listed as added does not exist (TOCTOU)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-pii-toctou-'));
    try {
      // File is in changedFiles but never written to disk — simulates TOCTOU removal.
      const diff = diffWith(repoRoot, [addedFixture('tests/fixtures/deleted.json')]);

      let report;
      assert.doesNotThrow(() => {
        report = auditDiffHygiene(diff);
      }, 'auditDiffHygiene must not throw when fixture file is unreadable');

      assert.equal(report.summary.added_files_scanned, 1, 'file was counted as scanned');
      assert.deepEqual(
        report.findings.filter((f) => f.rule === 'pii-in-fixture'),
        [],
        'unreadable file treated as empty — no pii-in-fixture finding',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not throw when fixture path is a directory (EISDIR)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-pii-eisdir-'));
    try {
      // A directory at the fixture path → readFileSync throws EISDIR.
      fs.mkdirSync(path.join(repoRoot, 'tests', 'fixtures', 'eisdir.json'), { recursive: true });
      const diff = diffWith(repoRoot, [addedFixture('tests/fixtures/eisdir.json')]);

      let report;
      assert.doesNotThrow(() => {
        report = auditDiffHygiene(diff);
      }, 'auditDiffHygiene must not throw when fixture path is a directory');

      assert.deepEqual(report.findings.filter((f) => f.rule === 'pii-in-fixture'), []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('still fires pii-in-fixture when the fixture file is readable (data flow intact)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-pii-readable-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'tests', 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'tests', 'fixtures', 'real.json'), '{ "ssn": "512-34-5678" }');
      const diff = diffWith(repoRoot, [addedFixture('tests/fixtures/real.json')]);

      const report = auditDiffHygiene(diff);
      assert.ok(
        report.findings.some((f) => f.rule === 'pii-in-fixture'),
        'pii-in-fixture must fire for a readable fixture with a real SSN',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
