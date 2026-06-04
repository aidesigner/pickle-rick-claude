// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-acshape-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', [
    '# PRD',
    '',
    '## Acceptance Criteria',
    '',
    '**AC-FF-05**: Feature flag off behavior returns 403 for comparison retry endpoints.',
    '',
  ].join('\n'));
  writeFile(repoRoot, 'src/index.ts', 'export const behavior = "prd";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  return { repoRoot, base: git(repoRoot, ['rev-parse', 'HEAD']) };
}

describe('citadel ac-shape manifest read', () => {
  // auditAcShape runs UNWRAPPED by safeRunAnalyzer in audit-runner.ts, so an
  // unreadable session manifest must not be allowed to throw out of the audit.
  // readManifestText previously used existsSync (F_OK existence) then readFileSync;
  // a path that exists but cannot be read (here: a directory named like the
  // manifest -> EISDIR) passes existsSync and then throws, crashing the audit.
  test('survives a session manifest that exists but is unreadable', async () => {
    const { repoRoot, base } = createRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-acshape-session-'));
    try {
      // Manifest path exists (existsSync -> true) but is a directory: readFileSync -> EISDIR.
      fs.mkdirSync(path.join(sessionDir, 'refinement_manifest.json'));

      writeFile(repoRoot, 'src/index.ts', 'export const behavior = "shipped";\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'change behavior']);

      // Must NOT throw — the whole audit would crash before the fix.
      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.ok(report.sections.ac_shape, 'ac_shape section must be present');
      assert.ok(Array.isArray(report.sections.ac_shape.findings));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
