// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverSubsystems } from '../bin/pipeline-runner.js';

// R-APBS-3 regression guard: discoverSubsystems MUST enumerate repo-root /bin/
// when it contains ≥3 source files. Root cause: pipelines started with
// target=extension/ never see the repo-root /bin/ — this test locks in the
// correct behavior for target=repoRoot so EXCLUDED_DIRS additions can't regress it.

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apbs-bin-fixture-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'a.js'), '// release script\n');
  fs.writeFileSync(path.join(root, 'bin', 'b.js'), '// release script\n');
  fs.writeFileSync(path.join(root, 'bin', 'c.js'), '// release script\n');
  fs.writeFileSync(path.join(root, 'bin', 'CLAUDE.md'), '# bin\n');
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'd.js'), 'export const d = 1;\n');
  fs.writeFileSync(path.join(root, 'extension', 'src', 'e.js'), 'export const e = 2;\n');
  fs.writeFileSync(path.join(root, 'extension', 'src', 'f.js'), 'export const f = 3;\n');
  return root;
}

test('anatomy-park-resolveSubsystems-bin: repo-root /bin/ with 3+ .js files is included as a subsystem', () => {
  const root = makeFixture();
  try {
    const result = discoverSubsystems(root);
    const names = result.map((s) => s.name);
    assert.ok(
      names.includes('bin'),
      `expected 'bin' in discovered subsystems, got: [${names.join(', ')}]`,
    );
    assert.ok(
      names.includes('extension'),
      `expected 'extension' in discovered subsystems, got: [${names.join(', ')}]`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('anatomy-park-resolveSubsystems-bin: bin/ with exactly 3 .js files meets the ≥3 source-file threshold', () => {
  const root = makeFixture();
  try {
    const result = discoverSubsystems(root);
    const binEntry = result.find((s) => s.name === 'bin');
    assert.ok(binEntry, 'bin subsystem must be discovered');
    assert.ok(binEntry.fileCount >= 3, `fileCount must be ≥3, got ${binEntry.fileCount}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('anatomy-park-resolveSubsystems-bin: .md files in bin/ do not count toward source threshold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apbs-bin-md-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    // Only 2 .js files + 1 .md — should NOT meet the 3-source-file threshold
    fs.writeFileSync(path.join(root, 'bin', 'a.js'), '// script\n');
    fs.writeFileSync(path.join(root, 'bin', 'b.js'), '// script\n');
    fs.writeFileSync(path.join(root, 'bin', 'CLAUDE.md'), '# docs\n');
    const result = discoverSubsystems(root);
    const names = result.map((s) => s.name);
    assert.ok(
      !names.includes('bin'),
      `bin with 2 .js + 1 .md should NOT be a subsystem; got: [${names.join(', ')}]`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
