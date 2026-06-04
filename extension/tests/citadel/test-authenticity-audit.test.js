// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findVacuousTypePresence,
  findInlineCopies,
  collectLocalDeclarations,
  collectImports,
  auditTestAuthenticity,
} from '../../services/citadel/test-authenticity-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

describe('test-authenticity-audit: vacuous type-presence', () => {
  test('fires on Object.keys(...).toContain("TypeName")', () => {
    const content = "assert.ok(Object.keys(schema).toContain('UserRecord'));\n";
    const findings = findVacuousTypePresence(content, 'tests/x.test.js');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'Low');
    assert.match(findings[0].id, /^test-vacuous-type-presence:/);
    assert.match(findings[0].message, /UserRecord/);
  });

  test('silent on lowercase / behavioral toContain', () => {
    const content = "expect(Object.keys(o)).toContain('userId');\nexpect(list).toContain('Done');\n";
    assert.deepEqual(findVacuousTypePresence(content, 'tests/x.test.js'), []);
  });
});

describe('test-authenticity-audit: inline-copy', () => {
  test('fires when spec imports a module but redeclares one of its exports', () => {
    const spec = [
      "import { helperA } from './widget.js';",
      'function slugify(s) { return s.toLowerCase(); }',
      "test('t', () => { slugify(helperA()); });",
    ].join('\n');
    const siblings = new Map([['./widget.js', new Set(['helperA', 'slugify'])]]);
    const findings = findInlineCopies(spec, 'tests/widget.test.js', siblings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'Medium');
    assert.match(findings[0].id, /test-inline-copy:.*slugify/);
  });

  test('silent when the declared symbol is actually imported', () => {
    const spec = [
      "import { slugify } from './widget.js';",
      "test('t', () => { slugify('x'); });",
    ].join('\n');
    const siblings = new Map([['./widget.js', new Set(['slugify'])]]);
    assert.deepEqual(findInlineCopies(spec, 'tests/widget.test.js', siblings), []);
  });

  test('silent when the local declaration is not a sibling export', () => {
    const spec = [
      "import { helperA } from './widget.js';",
      'function makeLocalFixture() { return 1; }',
      "test('t', () => { makeLocalFixture(); helperA(); });",
    ].join('\n');
    const siblings = new Map([['./widget.js', new Set(['helperA'])]]);
    assert.deepEqual(findInlineCopies(spec, 'tests/widget.test.js', siblings), []);
  });

  test('parser helpers behave', () => {
    assert.ok(collectLocalDeclarations('export function foo(){}\nclass Bar{}').has('foo'));
    assert.ok(collectLocalDeclarations('export function foo(){}\nclass Bar{}').has('Bar'));
    const parsed = collectImports("import { a, b as c } from './m.js';");
    assert.ok(parsed.names.has('a') && parsed.names.has('b'));
    assert.deepEqual(parsed.modules, ['./m.js']);
  });
});

describe('test-authenticity-audit: wired analyzer', () => {
  test('fires end-to-end against a synthetic temp tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-'));
    try {
      const dir = path.join(tmp, 'extension', 'src', 'foo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'widget.ts'), 'export function slugify(s){return s;}\nexport function helperA(){return 1;}\n');
      const specRel = 'extension/src/foo/widget.test.ts';
      fs.writeFileSync(path.join(tmp, specRel), [
        "import { helperA } from './widget.js';",
        'function slugify(s){ return s; }',
        "test('t', () => { slugify(helperA()); });",
      ].join('\n'));
      const result = auditTestAuthenticity({
        range: 'X..Y',
        base: 'X',
        head: 'Y',
        repoRoot: tmp,
        changedFiles: [
          { path: specRel, status: 'A', kind: 'test', changedLines: [], blame: [] },
        ],
        claudeFiles: [],
      });
      assert.equal(result.findings.length, 1);
      assert.match(result.findings[0].id, /test-inline-copy:.*slugify/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('silent on empty diff', () => {
    const result = auditTestAuthenticity({
      range: 'HEAD..HEAD', base: 'HEAD', head: 'HEAD', repoRoot: REPO_ROOT,
      changedFiles: [], claudeFiles: [],
    });
    assert.deepEqual(result.findings, []);
  });
});

describe('test-authenticity-audit: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.test_authenticity;
    assert.ok(section, 'test_authenticity section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'test_authenticity');
    assert.deepEqual(leaked, []);
  });
});
