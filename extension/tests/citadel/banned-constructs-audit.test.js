// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isNestedTernary,
  isBraceFreeIf,
  findBannedConstructs,
  auditBannedConstructs,
} from '../../services/citadel/banned-constructs-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

describe('banned-constructs: nested ternary detector', () => {
  test('fires on nested and chained ternaries', () => {
    assert.ok(isNestedTernary('const x = cond ? a ? b : c : d;'));
    assert.ok(isNestedTernary('const x = a ? b : c ? d : e;'));
  });
  test('silent on a single ternary, optional props, and optional chaining', () => {
    assert.ok(!isNestedTernary('const x = ok ? 1 : 2;'));
    assert.ok(!isNestedTernary('type T = { a?: number; b?: number };'));
    assert.ok(!isNestedTernary('const y = obj?.a ?? fallback;'));
    assert.ok(!isNestedTernary('const s = "a ? b ? c : d : e";'));
  });
});

describe('banned-constructs: brace-free if detector', () => {
  test('fires on a same-line brace-free if', () => {
    assert.ok(isBraceFreeIf('  if (x) return y;'));
    assert.ok(isBraceFreeIf('  } else if (cond(a, b)) doThing();'));
  });
  test('silent on braced if, brace-on-next-line, and strings', () => {
    assert.ok(!isBraceFreeIf('  if (x) {'));
    assert.ok(!isBraceFreeIf('  if (cond)'));
    assert.ok(!isBraceFreeIf('  const s = "if (x) y";'));
    assert.ok(!isBraceFreeIf('  if (x) // comment'));
  });
});

describe('banned-constructs: findBannedConstructs', () => {
  test('flags both classes on a positive fixture and is silent on clean lines', () => {
    const findings = findBannedConstructs([{
      file: 'src/x.ts',
      lines: [
        { no: 10, text: 'const z = a ? b ? c : d : e;' },
        { no: 11, text: 'if (ready) launch();' },
        { no: 12, text: 'const ok = a ? b : c;' },
        { no: 13, text: '// if (x) return;  comment line is ignored' },
      ],
    }]);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => f.id.startsWith('banned-construct:nested-ternary:')));
    assert.ok(findings.some((f) => f.id.startsWith('banned-construct:brace-free-if:')));
    for (const f of findings) assert.equal(f.severity, 'Medium');
  });

  test('end-to-end wired read via auditBannedConstructs on a temp file', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src/x.ts'), 'export const z = a ? b ? c : d : e;\n');
      const result = auditBannedConstructs({
        range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
        changedFiles: [{ path: 'src/x.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] }],
        claudeFiles: [],
      });
      assert.ok(result.findings.some((f) => f.id.startsWith('banned-construct:nested-ternary:')));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('banned-constructs: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.banned_constructs;
    assert.ok(section, 'banned_constructs section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'banned_constructs');
    assert.deepEqual(leaked, []);
  });
});
