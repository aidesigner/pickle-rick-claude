// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, 'package.json');
const RELEASE_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
}

function readReleaseNodeVersion() {
  const workflow = readFileSync(RELEASE_WORKFLOW_PATH, 'utf8');
  const match = workflow.match(/^\s*node-version:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  assert.ok(match, 'release workflow must define setup-node node-version');
  return match[1];
}

test('package node engine matches release workflow setup-node version', () => {
  const packageJson = readPackageJson();
  const releaseNodeVersion = readReleaseNodeVersion();

  assert.equal(packageJson.engines.node, releaseNodeVersion);
});

test('codex engine is exact pinned', () => {
  const packageJson = readPackageJson();

  assert.match(packageJson.engines.codex, /^\d+\.\d+\.\d+$/);
});

test('_audit.c8 documents the pinned coverage dependency', () => {
  const packageJson = readPackageJson();

  assert.ok(packageJson._audit.c8);
  assert.equal(packageJson._audit.c8.version, packageJson.devDependencies.c8);
});

test('engines.claude and engines.gh exist as exact pins', () => {
  const packageJson = readPackageJson();

  assert.ok('claude' in packageJson.engines, 'engines.claude must exist');
  assert.ok('gh' in packageJson.engines, 'engines.gh must exist');
  assert.match(packageJson.engines.claude, /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.engines.gh, /^\d+\.\d+\.\d+$/);
});
