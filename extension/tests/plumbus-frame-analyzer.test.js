import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'frame1-asymmetric-writer.dot');

let fakeAttractorRoot;

function makeAttractorRoot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'plumbus-attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  return tmp;
}

describe('plumbus-frame-analyzer', () => {
  before(() => {
    fakeAttractorRoot = makeAttractorRoot();
  });

  after(() => {
    rmSync(fakeAttractorRoot, { recursive: true, force: true });
  });

  test('CLI exits 0 on valid arg with attractor root set', () => {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, FIXTURE_PATH],
      { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: fakeAttractorRoot } },
    );
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  });

  test('CLI exits 2 with missing arg', () => {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH],
      { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: undefined } },
    );
    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}`);
    assert.ok(
      result.stderr.includes('plumbus-frame-analyzer'),
      `expected stderr to include 'plumbus-frame-analyzer', got: ${result.stderr}`,
    );
  });

  test('Output has exactly 3 top-level keys: context_keys, diamond_routing, cycles', () => {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, FIXTURE_PATH],
      { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: fakeAttractorRoot } },
    );
    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['context_keys', 'cycles', 'diamond_routing'],
    );
  });

  test('Attractor discovery finds CLI via ATTRACTOR_ROOT — does not exit 2', () => {
    const tmp = makeAttractorRoot();
    try {
      const result = spawnSync(
        process.execPath,
        [BIN_PATH, FIXTURE_PATH],
        { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: tmp } },
      );
      assert.notStrictEqual(result.status, 2, `expected attractor discovery to succeed, got exit 2: ${result.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
