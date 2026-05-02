import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PURGE_SCRIPT = path.join(REPO_ROOT, 'bin', 'purge-update-cache.js');

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'purge-update-cache-test-'));
  const homeDir = path.join(dir, 'home');
  const tmpRoot = path.join(dir, 'tmp');
  const varFoldersRoot = path.join(dir, 'var-folders');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  const cachePath = path.join(runtimeRoot, 'update-check.json');
  const auditPath = path.join(runtimeRoot, 'deploy-audit.log');
  const tarballDir = path.join(tmpRoot, 'pickle-update-fixture');
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(varFoldersRoot, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    last_check_epoch: 1,
    latest_version: '1.0.0',
    current_version: '1.0.0',
  }));
  writeFileSync(path.join(tarballDir, 'release.tar.gz'), 'fixture');
  return { dir, homeDir, tmpRoot, varFoldersRoot, cachePath, auditPath, tarballDir };
}

function runPurge(fixture, args = []) {
  return spawnSync('node', [PURGE_SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      TMPDIR: fixture.tmpRoot,
      PICKLE_PURGE_VAR_FOLDERS_ROOT: fixture.varFoldersRoot,
    },
  });
}

describe('purge-update-cache.js', () => {
  test('removes update cache, tmpdir tarballs, and appends audit log', () => {
    const fixture = makeFixture();
    try {
      const result = runPurge(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.equal(existsSync(fixture.tarballDir), false);

      const lines = readFileSync(fixture.auditPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const audit = JSON.parse(lines[0]);
      assert.equal(audit.event, 'CACHE_PURGE');
      assert.ok(audit.removed_paths.includes(fixture.cachePath));
      assert.ok(audit.removed_paths.includes(fixture.tarballDir));
      assert.equal(typeof audit.ts, 'string');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('succeeds without audit entry when cache and tmpdir entries are absent', () => {
    const fixture = makeFixture();
    try {
      rmSync(fixture.cachePath, { force: true });
      rmSync(fixture.tarballDir, { recursive: true, force: true });
      const result = runPurge(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.auditPath), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('dry-run reports paths without removing files or writing audit log', () => {
    const fixture = makeFixture();
    try {
      const result = runPurge(fixture, ['--dry-run']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), true);
      assert.equal(existsSync(fixture.tarballDir), true);
      assert.equal(existsSync(fixture.auditPath), false);
      assert.match(result.stderr, /Would remove/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
