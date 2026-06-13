// @tier: fast
// W1d (ticket 9e440539): the dirty-tree preflight evaluates dirtiness ONLY over `allowed_paths` (the
// run scope), exempts `docs/`/`prds/` segments at ANY depth, and folds the former `ignore_dirty_paths`
// + `.pipeline-runner-dirty-allowed.json` mechanisms into ONE scope-aware resolver.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertCleanWorkingTree } from '../bin/pipeline-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w1d-scope-'));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
}

function commit(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execFileSync('git', ['add', relPath], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `add ${relPath}`], { cwd: dir });
}

describe('W1d scope-aware dirty-tree preflight', () => {
  test('out-of-scope lint --fix mutation does NOT abort when allowed_paths is set', () => {
    const dir = tmpDir();
    initRepo(dir);
    commit(dir, 'src/in-scope.ts', 'export const a = 1;\n');
    commit(dir, 'src/out-of-scope.ts', 'export const b = 1;\n');
    // Simulate an out-of-scope autofix mutating a file the run is NOT scoped to.
    fs.writeFileSync(path.join(dir, 'src/out-of-scope.ts'), 'export const b = 2;\n');
    assert.doesNotThrow(() =>
      assertCleanWorkingTree(dir, { allowedPaths: ['src/in-scope.ts'] }),
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('nested packages/*/docs/prd/*.md churn is exempt even within an allowed path tree', () => {
    const dir = tmpDir();
    initRepo(dir);
    commit(dir, 'packages/api/src/index.ts', 'export const x = 1;\n');
    commit(dir, 'packages/api/docs/prd/feature.md', '# prd\n');
    // Dirty BOTH a nested docs/prd file (exempt by segment) — no in-scope source change.
    fs.writeFileSync(path.join(dir, 'packages/api/docs/prd/feature.md'), '# prd v2\n');
    assert.doesNotThrow(() =>
      assertCleanWorkingTree(dir, { allowedPaths: ['packages/api'] }),
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('an IN-scope dirty change IS evaluated and aborts', () => {
    const dir = tmpDir();
    initRepo(dir);
    commit(dir, 'src/in-scope.ts', 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/in-scope.ts'), 'export const a = 2;\n');
    assert.throws(
      () => assertCleanWorkingTree(dir, { allowedPaths: ['src/in-scope.ts'] }),
      /Dirty files:\nsrc\/in-scope\.ts/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('in-scope dirty path under an allowed DIRECTORY is evaluated', () => {
    const dir = tmpDir();
    initRepo(dir);
    commit(dir, 'src/deep/in-scope.ts', 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/deep/in-scope.ts'), 'export const a = 2;\n');
    assert.throws(
      () => assertCleanWorkingTree(dir, { allowedPaths: ['src/deep'] }),
      /Dirty files:\nsrc\/deep\/in-scope\.ts/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('unscoped run (no allowed_paths) preserves prior behavior — all dirt evaluated', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'wip');
    // No allowedPaths → scope inactive → the dirty file aborts, exactly as before W1d.
    assert.throws(() => assertCleanWorkingTree(dir, {}), /dirty/);
    // Empty allowedPaths array is also treated as unscoped.
    assert.throws(() => assertCleanWorkingTree(dir, { allowedPaths: [] }), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('out-of-scope churn + in-scope clean → launch proceeds; the .json allowlist still folds in', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
    commit(dir, 'src/in-scope.ts', 'export const a = 1;\n');
    commit(dir, 'evidence.txt', 'seed');
    fs.writeFileSync(
      path.join(dir, 'extension', '.pipeline-runner-dirty-allowed.json'),
      `${JSON.stringify({ paths: ['evidence.txt'] }, null, 2)}\n`,
    );
    execFileSync('git', ['add', 'extension/.pipeline-runner-dirty-allowed.json'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'allowlist'], { cwd: dir });
    // evidence.txt is in scope AND on the allowlist → exempt; out-of-scope src change is exempt by scope.
    fs.writeFileSync(path.join(dir, 'evidence.txt'), 'changed');
    commit(dir, 'src/other.ts', 'export const b = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/other.ts'), 'export const b = 2;\n');
    assert.doesNotThrow(() =>
      assertCleanWorkingTree(dir, { allowedPaths: ['src/in-scope.ts', 'evidence.txt'] }),
    );
    fs.rmSync(dir, { recursive: true });
  });
});
