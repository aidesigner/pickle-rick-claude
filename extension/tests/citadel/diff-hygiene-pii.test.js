// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDiffHygiene } from '../../services/citadel/diff-hygiene.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

function withAddedFile(filePath, content, fn) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-pii-'));
  try {
    const full = path.join(repoRoot, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const diff = {
      range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
      changedFiles: [{ path: filePath, status: 'A', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] }],
      claudeFiles: [],
    };
    return fn(auditDiffHygiene(diff));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('diff-hygiene: pii-in-fixture', () => {
  test('fires on a non-placeholder PII value in an added fixture file', () => {
    withAddedFile('tests/fixtures/applicant.json', '{\n  "ssn": "512-34-5678"\n}\n', (report) => {
      const pii = report.findings.find((f) => f.rule === 'pii-in-fixture');
      assert.ok(pii, 'expected a pii-in-fixture finding');
      assert.equal(pii.severity, 'Critical');
      assert.equal(pii.file, 'tests/fixtures/applicant.json');
    });
  });

  test('also matches a .fixture.* file and other enumerated keys', () => {
    withAddedFile('src/data/loan.fixture.ts', 'export const x = { account_number: "9981726354" };\n', (report) => {
      assert.ok(report.findings.some((f) => f.rule === 'pii-in-fixture'));
    });
  });

  test('silent when the PII value is a placeholder', () => {
    withAddedFile('tests/fixtures/applicant.json', '{\n  "ssn": "000-00-0000"\n}\n', (report) => {
      assert.deepEqual(report.findings.filter((f) => f.rule === 'pii-in-fixture'), []);
    });
  });

  test('silent for a non-fixture file even with a real PII value (fixture-gated)', () => {
    withAddedFile('src/config/seed.json', '{\n  "ssn": "512-34-5678"\n}\n', (report) => {
      assert.deepEqual(report.findings.filter((f) => f.rule === 'pii-in-fixture'), []);
    });
  });

  test('silent when the key is not in the PII allowlist', () => {
    withAddedFile('tests/fixtures/x.json', '{\n  "nickname": "rickest-rick"\n}\n', (report) => {
      assert.deepEqual(report.findings.filter((f) => f.rule === 'pii-in-fixture'), []);
    });
  });
});

describe('diff-hygiene pii: clean tree', () => {
  test('emits ZERO pii findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.diff_hygiene;
    assert.ok(section, 'diff_hygiene section must exist');
    assert.deepEqual(section.findings.filter((f) => f.rule === 'pii-in-fixture'), []);
  });
});
