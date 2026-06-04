// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditRuleSetInvariants } from '../../services/citadel/rule-set-invariant-audit.js';

// auditRuleSetInvariants runs UNWRAPPED by safeRunAnalyzer in audit-runner.ts.
// loadFiles wraps readFileSync in try/catch returning [] so a TOCTOU-removed or
// unreadable production/test file degrades to no declarations found, not a crash.
// R-HRP-4 pins this invariant with a test.

function diffWith(repoRoot, changedFiles) {
  return {
    range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('rule-set-invariant-audit loadFiles fail-open guard (R-HRP-4)', () => {
  test('does not throw when a changed production file does not exist (TOCTOU)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-toctou-'));
    try {
      // File listed in diff but not on disk — TOCTOU removal scenario.
      const diff = diffWith(repoRoot, [
        { path: 'src/rule-states.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
      ]);

      let report;
      assert.doesNotThrow(() => {
        report = auditRuleSetInvariants(diff, { repoRoot });
      }, 'auditRuleSetInvariants must not throw when production file is unreadable');

      assert.deepEqual(report.inventory, [], 'unreadable file produces no declarations');
      assert.deepEqual(report.findings, [], 'no findings from unreadable file');
      assert.equal(report.summary.declarations, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not throw when a changed test file does not exist (TOCTOU)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-toctou-test-'));
    try {
      // Production file exists with a rule-set; test file is missing — no evidence found.
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, 'src', 'transitions.ts'),
        "export const VALID_TRANSITIONS = ['pending', 'active', 'closed', 'archived'] as const;\n",
      );

      const diff = diffWith(repoRoot, [
        { path: 'src/transitions.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
        { path: 'tests/transitions.test.ts', status: 'M', kind: 'test', changedLines: [], blame: [] },
      ]);

      let report;
      assert.doesNotThrow(() => {
        report = auditRuleSetInvariants(diff, { repoRoot });
      }, 'must not throw when a test file in changedFiles is unreadable');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not throw when production file is a directory (EISDIR)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-eisdir-'));
    try {
      // A directory at the path → readFileSync throws EISDIR.
      fs.mkdirSync(path.join(repoRoot, 'src', 'rules.ts'), { recursive: true });
      const diff = diffWith(repoRoot, [
        { path: 'src/rules.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
      ]);

      let report;
      assert.doesNotThrow(() => {
        report = auditRuleSetInvariants(diff, { repoRoot });
      }, 'must not throw when production file path is a directory');

      assert.deepEqual(report.findings, []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
