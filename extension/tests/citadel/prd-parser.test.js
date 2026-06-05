// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function importParser() {
  const mod = await import('../../services/citadel/prd-parser.js');
  return mod;
}

function writePrd(dir, relPath, composes, body = '') {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  let content = '';
  if (composes.length > 0) {
    content = `---\ncomposes:\n${composes.map((p) => `  - ${p}`).join('\n')}\n---\n`;
  }
  content += body;
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

describe('parseWithComposes', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-composes-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('no composes: field → empty composedRcodes Map', async () => {
    const { parseWithComposes } = await importParser();
    const prdPath = writePrd(tmpDir, 'no-composes/bundle.md', [], '# Bundle\n\nAC-ONE-1 acceptance criterion.\n');
    const result = parseWithComposes(prdPath, { repoRoot: tmpDir });
    assert.equal(result.composedRcodes.size, 0);
  });

  test('single-level compose: source R-codes appear in composedRcodes', async () => {
    const { parseWithComposes } = await importParser();
    writePrd(tmpDir, 'single/source.md', [], '# Source\n\nR-TEST-1 requirement one.\nR-TEST-2 requirement two.\n');
    const bundlePath = writePrd(tmpDir, 'single/bundle.md', ['single/source.md']);
    const result = parseWithComposes(bundlePath, { repoRoot: tmpDir });
    const sourceReal = fs.realpathSync(path.join(tmpDir, 'single/source.md'));
    assert.ok(result.composedRcodes.has(sourceReal), 'source path not in composedRcodes');
    const rcodes = result.composedRcodes.get(sourceReal);
    assert.ok(rcodes.some((r) => r.id === 'R-TEST-1'));
    assert.ok(rcodes.some((r) => r.id === 'R-TEST-2'));
  });

  test('multi-level A→B→C: R-codes from B and C both in composedRcodes', async () => {
    const { parseWithComposes } = await importParser();
    writePrd(tmpDir, 'multi/c.md', [], '# C\n\nR-CHAIN-3 deep requirement.\n');
    writePrd(tmpDir, 'multi/b.md', ['multi/c.md'], '# B\n\nR-CHAIN-2 middle requirement.\n');
    const aPrd = writePrd(tmpDir, 'multi/a.md', ['multi/b.md']);
    const result = parseWithComposes(aPrd, { repoRoot: tmpDir });
    const bReal = fs.realpathSync(path.join(tmpDir, 'multi/b.md'));
    const cReal = fs.realpathSync(path.join(tmpDir, 'multi/c.md'));
    assert.ok(result.composedRcodes.has(bReal), 'B not in composedRcodes');
    assert.ok(result.composedRcodes.has(cReal), 'C not in composedRcodes');
    assert.ok(result.composedRcodes.get(bReal).some((r) => r.id === 'R-CHAIN-2'));
    assert.ok(result.composedRcodes.get(cReal).some((r) => r.id === 'R-CHAIN-3'));
  });

  test('composed child audit surfaces merge into the parsed bundle', async () => {
    const { parseWithComposes } = await importParser();
    writePrd(
      tmpDir,
      'merged/source.md',
      [],
      [
        '# Source',
        '',
        'AC-CHILD-1 child acceptance criterion.',
        '',
        'VALID_ACTIONS = ["child_flag"]',
        '',
        '| Transition | Audit | Expected Call Site |',
        '| child->done | logChildTransition | childRunner |',
      ].join('\n'),
    );
    const bundlePath = writePrd(
      tmpDir,
      'merged/bundle.md',
      ['merged/source.md'],
      '# Bundle\n\nAC-ROOT-1 root acceptance criterion.\n',
    );

    const result = parseWithComposes(bundlePath, { repoRoot: tmpDir });

    assert.deepEqual(
      result.acceptanceCriteria.map((criterion) => criterion.id),
      ['AC-ROOT-1', 'AC-CHILD-1'],
    );
    assert.equal(result.allowlistEntries.some((entry) => entry.kind === 'valid_action' && entry.value === 'child_flag'), true);
    assert.equal(result.transitionAuditRows.some((row) => row.auditAction === 'logChildTransition'), true);
  });

  test('diamond root→[A,B], A→C, B→C → no throw; shared base C merged exactly once', async () => {
    const { parseWithComposes } = await importParser();
    writePrd(tmpDir, 'diamond/c.md', [], '# C\n\nR-DIAMOND-3 shared base requirement.\n');
    writePrd(tmpDir, 'diamond/a.md', ['diamond/c.md'], '# A\n\nR-DIAMOND-1 branch a requirement.\n');
    writePrd(tmpDir, 'diamond/b.md', ['diamond/c.md'], '# B\n\nR-DIAMOND-2 branch b requirement.\n');
    const rootPrd = writePrd(tmpDir, 'diamond/root.md', ['diamond/a.md', 'diamond/b.md']);

    // A shared base reachable via two distinct branches is a DAG diamond, not a
    // cycle — it must not throw, and its R-codes must merge exactly once.
    const result = parseWithComposes(rootPrd, { repoRoot: tmpDir });

    const cReal = fs.realpathSync(path.join(tmpDir, 'diamond/c.md'));
    assert.ok(result.composedRcodes.has(cReal), 'shared base C must appear in composedRcodes');
    const allRcodeIds = [...result.composedRcodes.values()].flat().map((entry) => entry.id);
    assert.equal(
      allRcodeIds.filter((id) => id === 'R-DIAMOND-3').length,
      1,
      'shared base R-code must be merged exactly once (no duplicate, no cycle error)',
    );
    assert.ok(allRcodeIds.includes('R-DIAMOND-1'), 'branch A R-code missing');
    assert.ok(allRcodeIds.includes('R-DIAMOND-2'), 'branch B R-code missing');
  });

  test('cycle A→B→A → throws ComposesCycleError', async () => {
    const { parseWithComposes, ComposesCycleError } = await importParser();
    writePrd(tmpDir, 'cycle/a.md', ['cycle/b.md']);
    writePrd(tmpDir, 'cycle/b.md', ['cycle/a.md']);
    const aPrd = path.join(tmpDir, 'cycle/a.md');
    assert.throws(
      () => parseWithComposes(aPrd, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesCycleError,
    );
  });

  test('depth exceeds 8 → throws ComposesDepthError', async () => {
    const { parseWithComposes, ComposesDepthError, MAX_COMPOSES_DEPTH } = await importParser();
    assert.equal(MAX_COMPOSES_DEPTH, 8);
    // build chain: bundle → f0 → f1 → ... → f8 (9 composed files)
    // f7 composes f8; when processing f8 at depth=8 → throw
    for (let i = 8; i >= 0; i--) {
      const composes = i < 8 ? [`depth/f${i + 1}.md`] : [];
      writePrd(tmpDir, `depth/f${i}.md`, composes, `# Level ${i}\n\nR-DEPTH-${i} level.\n`);
    }
    const bundlePrd = writePrd(tmpDir, 'depth/bundle.md', ['depth/f0.md']);
    assert.throws(
      () => parseWithComposes(bundlePrd, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesDepthError,
    );
  });

  test('absolute path in composes: → throws ComposesPathError', async () => {
    const { parseWithComposes, ComposesPathError } = await importParser();
    const prdPath = writePrd(tmpDir, 'abspath/bundle.md', ['/etc/passwd']);
    assert.throws(
      () => parseWithComposes(prdPath, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesPathError,
    );
  });

  test('path with .. segment in composes: → throws ComposesPathError', async () => {
    const { parseWithComposes, ComposesPathError } = await importParser();
    const prdPath = writePrd(tmpDir, 'dotdot/bundle.md', ['../foo.md']);
    assert.throws(
      () => parseWithComposes(prdPath, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesPathError,
    );
  });

  test('glob * in composes: path → throws ComposesGlobError', async () => {
    const { parseWithComposes, ComposesGlobError } = await importParser();
    const prdPath = writePrd(tmpDir, 'glob/bundle.md', ['prds/p1-*.md']);
    assert.throws(
      () => parseWithComposes(prdPath, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesGlobError,
    );
  });

  test('glob ? in composes: path → throws ComposesGlobError', async () => {
    const { parseWithComposes, ComposesGlobError } = await importParser();
    const prdPath = writePrd(tmpDir, 'globq/bundle.md', ['prds/p?.md']);
    assert.throws(
      () => parseWithComposes(prdPath, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesGlobError,
    );
  });

  test('symlink loop → realpathSync fails → throws ComposesCycleError', async () => {
    const { parseWithComposes, ComposesCycleError } = await importParser();
    fs.mkdirSync(path.join(tmpDir, 'symloop'), { recursive: true });
    // self-referencing symlink: link.md -> link.md (causes ELOOP in realpathSync)
    const linkPath = path.join(tmpDir, 'symloop', 'link.md');
    fs.symlinkSync('link.md', linkPath);
    const prdPath = writePrd(tmpDir, 'symloop/bundle.md', ['symloop/link.md']);
    assert.throws(
      () => parseWithComposes(prdPath, { repoRoot: tmpDir }),
      (err) => err instanceof ComposesCycleError,
    );
  });
});
