import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLER = path.join(REPO_ROOT, 'bin', 'verify-deploy-parity.js');

const HASH_FILES = [
  ['check-update.js', 'extension/bin/check-update.js'],
  ['state-manager.js', 'extension/services/state-manager.js'],
  ['types/index.js', 'extension/types/index.js'],
];

function sha256(filePath) {
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-deploy-parity-'));
  const sourceRepo = path.join(dir, 'source');
  const runtimeRoot = path.join(dir, 'runtime');
  mkdirSync(path.join(sourceRepo, 'extension'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'extension', 'bin'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'extension', 'services'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'extension', 'types'), { recursive: true });

  writeFileSync(path.join(sourceRepo, 'extension', 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(runtimeRoot, 'extension', 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(runtimeRoot, 'extension', 'bin', 'check-update.js'), 'check update\n');
  writeFileSync(path.join(runtimeRoot, 'extension', 'services', 'state-manager.js'), 'state manager\n');
  writeFileSync(path.join(runtimeRoot, 'extension', 'types', 'index.js'), 'types index\n');

  const contentHashes = Object.fromEntries(
    HASH_FILES.map(([key, relPath]) => [key, sha256(path.join(runtimeRoot, relPath))]),
  );
  writeFileSync(path.join(runtimeRoot, 'deploy-baseline.json'), `${JSON.stringify({
    installed_at: '2026-05-02T00:00:00Z',
    src_version: '1.2.3',
    dep_version: '1.2.3',
    content_hashes: contentHashes,
  }, null, 2)}\n`);

  return { dir, sourceRepo, runtimeRoot };
}

function runSampler(fixture) {
  return spawnSync(process.execPath, [SAMPLER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOURCE_REPO: fixture.sourceRepo,
      PICKLE_DEPLOY_ROOT: fixture.runtimeRoot,
    },
  });
}

describe('verify-deploy-parity sampler', () => {
  test('verify-deploy-parity.emits-jsonl emits one JSON-line with required fields', () => {
    const fixture = makeFixture();
    try {
      const result = runSampler(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(parsed.src_version, '1.2.3');
      assert.equal(parsed.dep_version, '1.2.3');
      assert.equal(parsed.hashes_match, true);
      assert.equal('drift' in parsed, false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('verify-deploy-parity.mismatch-detect detects deployed package mismatch', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(path.join(fixture.runtimeRoot, 'extension', 'package.json'), JSON.stringify({ version: '9.9.9' }));
      const result = runSampler(fixture);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hashes_match, false);
      assert.deepEqual(parsed.drift.dep_version, { baseline: '1.2.3', actual: '9.9.9' });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('verify-deploy-parity.hash-drift detects deployed content-hash drift', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(path.join(fixture.runtimeRoot, 'extension', 'services', 'state-manager.js'), 'changed\n');
      const result = runSampler(fixture);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hashes_match, false);
      assert.equal(typeof parsed.drift['state-manager.js'].baseline, 'string');
      assert.equal(typeof parsed.drift['state-manager.js'].actual, 'string');
      assert.notEqual(parsed.drift['state-manager.js'].baseline, parsed.drift['state-manager.js'].actual);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
