import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/citadel-cross-phase-fixture');

function writeFile(root, filePath, content) {
  const fullPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-repo-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# PRD\n\n## Acceptance Criteria\n\n**AC-TEST-01**: Stable.\n');
  writeFile(repoRoot, 'src/index.ts', 'export const before = true;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFile(repoRoot, 'src/index.ts', 'export const after = true;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

function copyFixture(sessionDir) {
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'anatomy-park.json'),
    path.join(sessionDir, 'anatomy-park.json'),
  );
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'szechuan-sauce.json'),
    path.join(sessionDir, 'szechuan-sauce.json'),
  );
}

describe('citadel cross-phase fixture', () => {
  test('merges anatomy-park and szechuan-sauce findings without double-counting duplicate ids', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-session-'));
    try {
      copyFixture(sessionDir);

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      const ids = report.findings.map((finding) => finding.id);
      assert.equal(report.sections.cross_phase.findings.length, 4);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 3);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 2);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 1);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_renamed, 0);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, false);
      assert.equal(ids.filter((id) => id === 'cross-phase-shared-id').length, 1);
      assert.ok(!ids.includes('szechuan-sauce:cross-phase-shared-id'));
      assert.equal(report.summary.critical, 1);
      assert.equal(report.summary.low, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('exits cleanly when sibling phase artifacts are absent', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-empty-'));
    try {
      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.equal(report.sections.cross_phase.findings.length, 1);
      assert.equal(report.sections.cross_phase.findings[0].id, 'anatomy-park:missing');
      assert.equal(report.sections.cross_phase.findings[0].severity, 'Low');
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 0);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 0);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 0);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_renamed, 0);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, true);
      assert.equal(report.findings.length, 1);
      assert.equal(report.exit_code, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
