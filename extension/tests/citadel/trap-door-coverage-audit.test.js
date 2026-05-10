// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

async function importAnalyzer() {
  const { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage } = await import(
    '../../services/citadel/trap-door-coverage-audit.js'
  );
  return { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage };
}

function mkFixture(projectRoot, opts = {}) {
  const extDir = path.join(projectRoot, 'extension');
  const testsDir = path.join(extDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });

  const claudeMdPath = path.join(extDir, 'CLAUDE.md');
  const content = opts.claudeMdContent ?? '## Trap Doors\n\n' + (opts.enforceLines ?? '') + '\n';
  fs.writeFileSync(claudeMdPath, content, 'utf-8');

  for (const [rel, body] of Object.entries(opts.testFiles ?? {})) {
    const full = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }

  return { extDir, testsDir, claudeMdPath };
}

describe('runT6TrapDoorCoverage', () => {
  let tmpRoot;
  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('orphan_enforce: ENFORCE points to missing file → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-enforce');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/nonexistent.test.js\n',
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-enforce/);
    assert.match(high[0].message, /nonexistent\.test\.js/);
  });

  test('orphan_test_case: file exists but anchor missing → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-case');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/real.test.js#missing-anchor\n',
      testFiles: {
        'extension/tests/real.test.js': "test('other-test', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-test-case/);
    assert.match(high[0].message, /missing-anchor/);
  });

  test('orphan_test_file: test file has no inbound ENFORCE ref → MEDIUM finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-file');
    mkFixture(projectRoot, {
      enforceLines: '',
      testFiles: {
        'extension/tests/unreferenced.test.js': "test('x', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const medium = result.findings.filter((f) => f.severity === 'Medium');
    const orphan = medium.find((f) => f.id.includes('unreferenced.test.js'));
    assert.ok(orphan, 'expected orphan-test-file finding for unreferenced.test.js');
    assert.match(orphan.id, /orphan-test-file/);
  });

  test('bare-path legacy: no #anchor → exactly 1 LOW finding per CLAUDE.md', async () => {
    const projectRoot = path.join(tmpRoot, 'bare-path');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/a.test.js',
        '- ENFORCE: extension/tests/b.test.js',
        '- ENFORCE: extension/tests/c.test.js#anchor-exists',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/a.test.js': "test('a', () => {});\n",
        'extension/tests/b.test.js': "test('b', () => {});\n",
        'extension/tests/c.test.js': "test('anchor-exists', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'exactly one LOW finding per CLAUDE.md');
    assert.match(low[0].id, /trap-door-bare-path/);
  });

  test('anchored ref with matching test case → no HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'anchor-found');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/suite.test.js#my-invariant\n',
      testFiles: {
        'extension/tests/suite.test.js': "test('my-invariant', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'no HIGH findings when anchor exists');
  });

  test('mixed bare and anchored refs in one CLAUDE.md → exactly 1 LOW warning', async () => {
    const projectRoot = path.join(tmpRoot, 'mixed-refs');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/bare1.test.js',
        '- ENFORCE: extension/tests/anchored.test.js#anchor-name',
        '- ENFORCE: extension/tests/bare2.test.js',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/bare1.test.js': "test('x', () => {});\n",
        'extension/tests/anchored.test.js': "test('anchor-name', () => {});\n",
        'extension/tests/bare2.test.js': "test('y', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'one LOW warning per CLAUDE.md regardless of bare-path ref count');
  });

  test('ENFORCE refs outside ## Trap Doors section are ignored', async () => {
    const projectRoot = path.join(tmpRoot, 'outside-section');
    const claudeMd = [
      '## Trap Doors',
      '',
      '## Other Section',
      '',
      '- ENFORCE: extension/tests/outside.test.js',
      '',
    ].join('\n');
    mkFixture(projectRoot, { claudeMdContent: claudeMd });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'refs outside Trap Doors section do not produce orphan_enforce');
  });

  test('subsystem CLAUDE.md absence handled gracefully (no throw)', async () => {
    const projectRoot = path.join(tmpRoot, 'no-subsystem');
    mkFixture(projectRoot, { enforceLines: '' });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    assert.doesNotThrow(() => runT6TrapDoorCoverage({ projectRoot }));
  });

  test('ENFORCE_REF_RE exported and matches comma-separated refs', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/tests/foo.test.js, extension/tests/bar.test.js.';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    const captured = matches[0][1];
    assert.match(captured, /foo\.test\.js/);
    assert.match(captured, /bar\.test\.js/);
  });

  test('ENFORCE_REF_RE matches backtick-wrapped paths', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: `extension/tests/baz.test.js`';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /baz\.test\.js/);
  });

  test('ENFORCE_REF_RE matches .sh scripts', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/scripts/audit-check.sh';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /audit-check\.sh/);
  });
});

describe('runT6TrapDoorCoverage — integration: real extension/CLAUDE.md', () => {
  // The acceptance criterion checks extension/CLAUDE.md specifically.
  // Subsystem CLAUDE.md files (extension/src/**/CLAUDE.md) may have pre-existing orphan refs
  // that are filed as separate tickets (NOT in scope per ticket 7a276c38).
  test('0 high-severity findings from extension/CLAUDE.md against HEAD', async () => {
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
    const high = result.findings.filter(
      (f) => f.severity === 'High' && f.file === 'extension/CLAUDE.md',
    );
    assert.deepStrictEqual(
      high,
      [],
      `Expected 0 HIGH findings from extension/CLAUDE.md; got:\n${high.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
    );
  });
});
