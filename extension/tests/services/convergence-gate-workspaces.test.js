import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
