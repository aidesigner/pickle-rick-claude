// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';

// auditSiblingAuthPreconditions runs UNWRAPPED by safeRunAnalyzer in audit-runner.ts.
// loadControllerFiles wraps readFileSync in try/catch returning [] so a TOCTOU-removed
// or unreadable controller file degrades to zero routes, not a crash. R-HRP-4 pins this
// invariant with a test.

function diffWith(repoRoot, changedFiles) {
  return {
    range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('sibling-auth-audit loadControllerFiles fail-open guard (R-HRP-4)', () => {
  test('does not throw when a changed production file does not exist (TOCTOU)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-toctou-'));
    try {
      const diff = diffWith(repoRoot, [
        { path: 'src/ghost.controller.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
      ]);

      let report;
      assert.doesNotThrow(() => {
        report = auditSiblingAuthPreconditions(diff);
      }, 'auditSiblingAuthPreconditions must not throw when controller file is unreadable');

      assert.deepEqual(report.routes, [], 'unreadable file produces no routes');
      assert.deepEqual(report.findings, [], 'no findings from unreadable file');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not throw with nestjs-api projectShapes when controller file is missing', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-toctou-nestjs-'));
    try {
      const diff = diffWith(repoRoot, [
        { path: 'src/ghost.controller.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
      ]);

      let report;
      assert.doesNotThrow(() => {
        report = auditSiblingAuthPreconditions(diff, { projectShapes: ['nestjs-api'] });
      }, 'must not throw even with nestjs-api shape when controller file is missing');

      assert.deepEqual(report.weakerDestructiveRoleFindings, []);
      assert.deepEqual(report.guardParityFindings, []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('still detects findings when controller file is readable (data flow intact)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-toctou-readable-'));
    try {
      const filePath = 'src/runs.controller.ts';
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, filePath), [
        '@Controller("runs/:id")',
        'export class RunsController {',
        '  @UseGuards(JwtAuthGuard)',
        '  @Get("data")',
        '  getData() { return true; }',
        '',
        '  @Get("health")',
        '  getHealth() { return true; }',
        '}',
        '',
      ].join('\n'));

      const diff = diffWith(repoRoot, [
        { path: filePath, status: 'M', kind: 'production', changedLines: [], blame: [] },
      ]);

      const report = auditSiblingAuthPreconditions(diff);
      assert.ok(report.routes.length > 0, 'readable controller file must produce routes');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
