// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = path.resolve(__dirname, '../../services/citadel');

const { auditPatternConformance } = await import(
  path.join(SERVICES_DIR, 'pattern-conformance-audit.js')
);

// Flywheel proof: a PATTERN_SHAPE newly added to the fixture's CLAUDE.md produces a finding
// when the diff violates it. This verifies the enforcement engine closes the #9/#10 class forever.

describe('pattern-conformance-flywheel: new PATTERN_SHAPE catches violating diff', () => {
  test('newly declared PATTERN_SHAPE produces finding when violated', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-flywheel-'));
    try {
      const targetFile = 'extension/src/flywheel-service.ts';
      fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });

      const newPattern = 'FLYWHEEL_GUARD_AC3_PROOF';
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetFile}\` (FLYWHEEL-AC3) — INVARIANT: flywheel test. PATTERN_SHAPE: \`${newPattern}\`.\n`,
      );

      // Target file does NOT contain the new pattern → violation expected
      fs.writeFileSync(
        path.join(tmpDir, targetFile),
        'export function flywheelService() { return "missing guard"; }\n',
      );

      const diff = {
        range: 'HEAD..HEAD',
        base: 'HEAD',
        head: 'HEAD',
        repoRoot: tmpDir,
        changedFiles: [
          { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
        ],
        claudeFiles: [],
      };

      const result = auditPatternConformance(diff);
      const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));

      assert.ok(
        violations.length >= 1,
        `Flywheel FAIL: expected ≥1 violation; got ${violations.length}. Findings: ${JSON.stringify(result.findings)}`,
      );
      assert.strictEqual(violations[0].severity, 'High', 'Flywheel violation must have High severity');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('newly declared PATTERN_SHAPE produces no false positive when satisfied', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-flywheel-ok-'));
    try {
      const targetFile = 'extension/src/flywheel-ok.ts';
      fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });

      const newPattern = 'FLYWHEEL_GUARD_AC3_PROOF';
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetFile}\` (FLYWHEEL-AC3-OK) — INVARIANT: flywheel test. PATTERN_SHAPE: \`${newPattern}\`.\n`,
      );

      // Target file DOES contain the pattern → no violation
      fs.writeFileSync(
        path.join(tmpDir, targetFile),
        `export const ${newPattern} = true;\nexport function flywheelService() { return ${newPattern}; }\n`,
      );

      const diff = {
        range: 'HEAD..HEAD',
        base: 'HEAD',
        head: 'HEAD',
        repoRoot: tmpDir,
        changedFiles: [
          { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 2 }], blame: [] },
        ],
        claudeFiles: [],
      };

      const result = auditPatternConformance(diff);
      const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));

      assert.strictEqual(
        violations.length,
        0,
        `Flywheel false positive: expected 0 violations when pattern present; got ${violations.length}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('suffix-path matching: target declared without extension/ prefix is found when diff has it', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-flywheel-suffix-'));
    try {
      // CLAUDE.md declares target as 'src/bin/mux-runner.ts' (without 'extension/' prefix)
      const targetInClaudeMd = 'src/bin/mux-runner.ts';
      // Diff has the full path with prefix
      const changedFilePath = 'extension/src/bin/mux-runner.ts';

      fs.mkdirSync(path.join(tmpDir, 'extension', 'src', 'bin'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetInClaudeMd}\` (FLYWHEEL-SUFFIX) — INVARIANT: suffix match test. PATTERN_SHAPE: \`SUFFIX_MATCH_SENTINEL\`.\n`,
      );
      // File is missing the pattern
      fs.writeFileSync(
        path.join(tmpDir, changedFilePath),
        'export function runMux() { return null; }\n',
      );

      const diff = {
        range: 'HEAD..HEAD',
        base: 'HEAD',
        head: 'HEAD',
        repoRoot: tmpDir,
        changedFiles: [
          { path: changedFilePath, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
        ],
        claudeFiles: [],
      };

      const result = auditPatternConformance(diff);
      const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));

      assert.ok(
        violations.length >= 1,
        `Suffix match FAIL: 'extension/src/bin/mux-runner.ts' should match target 'src/bin/mux-runner.ts'; got ${violations.length} violations`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
