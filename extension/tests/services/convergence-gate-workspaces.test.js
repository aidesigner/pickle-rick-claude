import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackages, filterByScope, runGate } from '../../services/convergence-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, '../fixtures/workspace-3-pkg');

test('getWorkspacePackages: 3-pkg fixture returns 3 absolute paths', () => {
  const pkgs = getWorkspacePackages(FIXTURE);
  assert.equal(pkgs.length, 3, `expected 3 packages, got ${pkgs.length}: ${pkgs.join(', ')}`);
  for (const p of pkgs) {
    assert.ok(path.isAbsolute(p), `expected absolute path, got ${p}`);
    assert.ok(fs.existsSync(path.join(p, 'package.json')), `no package.json in ${p}`);
  }
});

test('getWorkspacePackages: returns packages/a, packages/b, packages/c', () => {
  const pkgs = getWorkspacePackages(FIXTURE);
  const names = pkgs.map(p => path.basename(p)).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('filterByScope: allowedPaths=packages/b/** returns only b (relative paths)', () => {
  const relPaths = ['packages/a', 'packages/b', 'packages/c'];
  const filtered = filterByScope(relPaths, { scope: 'full', allowedPaths: ['packages/b/**'] });
  assert.deepEqual(filtered, ['packages/b']);
});

test('filterByScope: no allowedPaths returns all files', () => {
  const files = ['packages/a', 'packages/b', 'packages/c'];
  assert.deepEqual(filterByScope(files, { scope: 'full' }), files);
});

test('filterByScope: empty allowedPaths returns all files', () => {
  const files = ['packages/a', 'packages/b'];
  assert.deepEqual(filterByScope(files, { scope: 'full', allowedPaths: [] }), files);
});

test('filterByScope: allowedPaths=packages/a/** + packages/c/** returns a and c', () => {
  const files = ['packages/a', 'packages/b', 'packages/c'];
  const filtered = filterByScope(files, { scope: 'full', allowedPaths: ['packages/a/**', 'packages/c/**'] });
  assert.deepEqual(filtered.sort(), ['packages/a', 'packages/c']);
});

test('runGate: workspace fixture scope=full allowedPaths=packages/a/** only runs in a', async () => {
  const result = await runGate({
    workingDir: FIXTURE,
    mode: 'strict',
    scope: 'full',
    checks: ['tests'],
    allowedPaths: ['packages/a/**'],
  });
  assert.equal(typeof result.status, 'string');
  assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status));
  assert.ok(Array.isArray(result.failures));
  assert.equal(typeof result.elapsed_ms, 'number');
  assert.equal(result.baseline_used, false);
  assert.equal(result.allowed_paths_used, true);
  assert.equal(result.status, 'green');
  assert.equal(result.failures.length, 0);
});

test('runGate: workspace fixture scope=full no allowedPaths runs all 3 packages', async () => {
  const result = await runGate({
    workingDir: FIXTURE,
    mode: 'strict',
    scope: 'full',
    checks: ['tests'],
  });
  assert.equal(result.status, 'green');
  assert.equal(result.failures.length, 0);
  assert.equal(result.allowed_paths_used, false);
});

test('runGate: allowedPaths can exclude an otherwise-failing workspace package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*'],
    }, null, 2));

    const passingDir = path.join(dir, 'packages', 'passing');
    const failingDir = path.join(dir, 'packages', 'failing');
    fs.mkdirSync(passingDir, { recursive: true });
    fs.mkdirSync(failingDir, { recursive: true });

    fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
      name: 'passing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
      name: 'failing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2));

    const scoped = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      allowedPaths: ['packages/passing/**'],
    });

    assert.equal(scoped.status, 'green');
    assert.deepEqual(scoped.failures, []);
    assert.equal(scoped.allowed_paths_used, true);
    assert.equal(scoped.total_raw_failure_count, 0, 'only the in-scope package should run');

    const unscoped = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
    });

    assert.equal(unscoped.status, 'red');
    assert.equal(unscoped.allowed_paths_used, false);
    assert.equal(unscoped.total_raw_failure_count, 1);
    assert.deepEqual(
      unscoped.failures.map(f => ({
        file: path.relative(dir, f.file),
        check: f.check,
        ruleOrCode: f.ruleOrCode,
      })),
      [
        {
          file: 'packages/failing',
          check: 'tests',
          ruleOrCode: '1',
        },
      ],
      'without allowedPaths the failing out-of-scope package must surface as a gate failure'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
