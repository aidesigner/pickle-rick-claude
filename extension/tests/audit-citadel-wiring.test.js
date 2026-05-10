// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, '../scripts/audit-citadel-wiring.js');

function buildSyntheticCitadel(tmpDir, allAnalyzers, wiredAnalyzers) {
  const citadelDir = path.join(tmpDir, 'citadel');
  fs.mkdirSync(citadelDir, { recursive: true });

  for (const name of allAnalyzers) {
    fs.writeFileSync(path.join(citadelDir, `${name}.ts`), `export function ${name.replace(/-/g, '_')}() {}\n`);
  }

  fs.writeFileSync(path.join(citadelDir, 'reporter.ts'), 'export class Reporter {}\n');
  fs.writeFileSync(path.join(citadelDir, 'diff-walker.ts'), 'export function walkDiff() {}\n');
  fs.writeFileSync(path.join(citadelDir, 'prd-parser.ts'), 'export function parsePrd() {}\n');
  fs.writeFileSync(path.join(citadelDir, 'some-helpers.ts'), 'export function helper() {}\n');
  fs.writeFileSync(path.join(citadelDir, 'some-types.ts'), 'export type Foo = string;\n');

  const importLines = wiredAnalyzers
    .map((n) => `import { ${n.replace(/-/g, '_')} } from './${n}.js';`)
    .join('\n');

  fs.writeFileSync(
    path.join(citadelDir, 'audit-runner.ts'),
    `${importLines}\nexport function runAudit() {}\n`,
  );

  return citadelDir;
}

const { runAudit } = await import(scriptPath);

describe('audit-citadel-wiring', () => {
  test('all analyzers wired → all wired:true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwire-'));
    try {
      const analyzers = ['alpha-audit', 'beta-audit', 'gamma-audit'];
      const citadelDir = buildSyntheticCitadel(tmp, analyzers, analyzers);
      const runnerPath = path.join(citadelDir, 'audit-runner.ts');

      const results = runAudit(citadelDir, runnerPath);

      assert.equal(results.length, 3);
      for (const r of results) {
        assert.equal(r.wired, true, `expected ${r.analyzer} to be wired`);
        assert.equal(typeof r.file_size_bytes, 'number');
        assert.ok(r.file_size_bytes > 0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('one analyzer not imported → wired:false for that one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwire-'));
    try {
      const analyzers = ['alpha-audit', 'beta-audit', 'gamma-audit'];
      const wired = ['alpha-audit', 'gamma-audit'];
      const citadelDir = buildSyntheticCitadel(tmp, analyzers, wired);
      const runnerPath = path.join(citadelDir, 'audit-runner.ts');

      const results = runAudit(citadelDir, runnerPath);

      assert.equal(results.length, 3);
      const beta = results.find((r) => r.analyzer === 'beta-audit');
      assert.ok(beta, 'beta-audit should be in results');
      assert.equal(beta.wired, false);

      for (const r of results.filter((r) => r.analyzer !== 'beta-audit')) {
        assert.equal(r.wired, true, `expected ${r.analyzer} to be wired`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--strict exits non-zero when an analyzer is unwired', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwire-'));
    try {
      const analyzers = ['alpha-audit', 'beta-audit'];
      const citadelDir = buildSyntheticCitadel(tmp, analyzers, ['alpha-audit']);
      const runnerPath = path.join(citadelDir, 'audit-runner.ts');

      const result = spawnSync(
        process.execPath,
        [scriptPath, '--strict', '--citadel-dir', citadelDir, '--runner-path', runnerPath],
        { encoding: 'utf-8' },
      );

      assert.notEqual(result.status, 0, `--strict should exit non-zero; got ${result.status}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('excludes helpers/types/runner/reporter/diff-walker/prd-parser from analyzer set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwire-'));
    try {
      const analyzers = ['real-audit'];
      const citadelDir = buildSyntheticCitadel(tmp, analyzers, analyzers);
      const runnerPath = path.join(citadelDir, 'audit-runner.ts');

      const results = runAudit(citadelDir, runnerPath);

      const names = results.map((r) => r.analyzer);
      assert.ok(!names.includes('reporter'), 'reporter should be excluded');
      assert.ok(!names.includes('diff-walker'), 'diff-walker should be excluded');
      assert.ok(!names.includes('prd-parser'), 'prd-parser should be excluded');
      assert.ok(!names.includes('audit-runner'), 'audit-runner should be excluded');
      assert.ok(!names.includes('some-helpers'), 'helpers should be excluded');
      assert.ok(!names.includes('some-types'), 'types should be excluded');
      assert.ok(names.includes('real-audit'), 'real-audit should be present');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('output JSON is parseable with required fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwire-'));
    try {
      const analyzers = ['alpha-audit', 'beta-audit'];
      const citadelDir = buildSyntheticCitadel(tmp, analyzers, ['alpha-audit']);
      const runnerPath = path.join(citadelDir, 'audit-runner.ts');

      const result = spawnSync(
        process.execPath,
        [scriptPath, '--citadel-dir', citadelDir, '--runner-path', runnerPath],
        { encoding: 'utf-8' },
      );

      assert.equal(result.status, 0, `exit 0 without --strict; stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.ok(Array.isArray(parsed));
      for (const entry of parsed) {
        assert.equal(typeof entry.analyzer, 'string');
        assert.equal(typeof entry.wired, 'boolean');
        assert.equal(typeof entry.file_size_bytes, 'number');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
