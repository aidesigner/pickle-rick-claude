// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCommentLine,
  extractBacktickedIdentifiers,
  extractBareIdentifiers,
  findStaleReferences,
  auditStaleReferences,
} from '../../services/citadel/stale-reference-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

describe('stale-reference-audit: helpers', () => {
  test('isCommentLine recognizes //, /*, * and */', () => {
    assert.ok(isCommentLine('  // a comment'));
    assert.ok(isCommentLine('/* block'));
    assert.ok(isCommentLine(' * jsdoc line'));
    assert.ok(!isCommentLine('const x = 1; // trailing'));
  });

  test('extractBacktickedIdentifiers keeps code-shaped tokens only', () => {
    const ids = extractBacktickedIdentifiers('// see `resolveScope` and `state.json` but not `the`');
    assert.ok(ids.includes('resolveScope'));
    assert.ok(ids.includes('state.json'));
    assert.ok(!ids.includes('the'));
  });
});

describe('stale-reference-audit: bare cited-symbol mismatch (#14)', () => {
  test('extractBareIdentifiers picks up a non-backticked code identifier in a comment', () => {
    const ids = extractBareIdentifiers('// guarded by isCompoundRulesEnabled when flagged');
    assert.ok(ids.includes('isCompoundRulesEnabled'), 'bare camelCase identifier must be extracted');
    // Plain English prose words are not code-shaped → not extracted.
    assert.ok(!ids.includes('guarded'));
    assert.ok(!ids.includes('flagged'));
  });

  test('a bare identifier already inside backticks is NOT double-counted as bare', () => {
    const ids = extractBareIdentifiers('// see `resolveScope` for details');
    assert.ok(!ids.includes('resolveScope'), 'backticked identifiers are masked out of the bare scan');
  });

  test('findStaleReferences flags a HEAD-absent bare identifier at severity Low', () => {
    const identifiers = extractBareIdentifiers('// via isCompoundRulesEnabled');
    assert.ok(identifiers.length > 0, 'fixture must yield a bare identifier');
    const items = [{ file: 'src/rules.ts', identifiers }];
    const findings = findStaleReferences(items, () => false); // none present at HEAD
    const hit = findings.find((f) => f.message.includes('isCompoundRulesEnabled'));
    assert.ok(hit, 'bare HEAD-absent cited symbol must produce a stale-reference finding');
    assert.equal(hit.severity, 'Low');
  });
});

describe('stale-reference-audit: positive/negative via injected HEAD lookup', () => {
  const items = [{ file: 'src/x.ts', identifiers: ['oldRenamedFn', 'stillHere'] }];

  test('fires for identifiers absent from HEAD', () => {
    const present = new Set(['stillHere']);
    const findings = findStaleReferences(items, (id) => present.has(id));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'Low');
    assert.match(findings[0].id, /stale-reference:.*oldrenamedfn/i);
    assert.match(findings[0].message, /oldRenamedFn/);
  });

  test('silent when every identifier is present at HEAD', () => {
    const findings = findStaleReferences(items, () => true);
    assert.deepEqual(findings, []);
  });
});

describe('stale-reference-audit: wired analyzer', () => {
  test('silent on empty diff', () => {
    const result = auditStaleReferences({
      range: 'HEAD..HEAD', base: 'HEAD', head: 'HEAD', repoRoot: REPO_ROOT,
      changedFiles: [], claudeFiles: [],
    });
    assert.deepEqual(result.findings, []);
  });

  test('end-to-end: a changed comment with a HEAD-absent identifier is flagged via real git grep', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-'));
    const git = (...args) => execFileSync('git', args, { cwd: tmp, timeout: 10_000 });
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      // Baseline HEAD commit: presentSymbol exists, synthetic does NOT.
      fs.writeFileSync(path.join(tmp, 'lib.ts'), 'export function presentSymbol(){ return 1; }\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      // Working-tree change: a comment referencing a HEAD-absent identifier.
      const synthetic = 'zzqRenamedHelper';
      fs.writeFileSync(
        path.join(tmp, 'lib.ts'),
        `// uses \`${synthetic}\` and \`presentSymbol\`\nexport function presentSymbol(){ return 1; }\n`,
      );
      const result = auditStaleReferences({
        range: 'HEAD..HEAD', base: 'HEAD', head: 'HEAD', repoRoot: tmp,
        changedFiles: [
          { path: 'lib.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
        ],
        claudeFiles: [],
      });
      const hit = result.findings.find((f) => f.message.includes(synthetic));
      assert.ok(hit, 'synthetic HEAD-absent identifier must be flagged');
      assert.equal(hit.severity, 'Low');
      // presentSymbol IS at HEAD → must NOT be flagged.
      assert.ok(!result.findings.some((f) => f.message.includes('presentSymbol')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('stale-reference-audit: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.stale_reference;
    assert.ok(section, 'stale_reference section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'stale_reference');
    assert.deepEqual(leaked, []);
  });
});
