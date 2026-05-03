import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VERIFY_LAUNCH = path.join(REPO_ROOT, 'bin', 'verify-launch.js');

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-gate-'));
  return {
    dir,
    samples: path.join(dir, 'samples.jsonl'),
    out: path.join(dir, 'bundle', 'ac-dr-07.json'),
    status: path.join(dir, 'bundle', 'status.json'),
  };
}

function writeSamples(filePath, { count = 10, hashesMatch = true } = {}) {
  const first = Date.parse('2026-05-02T00:00:00.000Z');
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    ts: new Date(first + index * 5 * 60 * 1000).toISOString(),
    src_version: '1.68.0',
    dep_version: '1.68.0',
    hashes_match: typeof hashesMatch === 'function' ? hashesMatch(index) : hashesMatch,
  }));
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function runLaunch(fixture, now = '2026-05-02T01:05:00.000Z') {
  return spawnSync(process.execPath, [
    VERIFY_LAUNCH,
    '--samples',
    fixture.samples,
    '--out',
    fixture.out,
    '--status',
    fixture.status,
    '--now',
    now,
  ], { encoding: 'utf8' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('AC-DR-07 launch gate', () => {
  test('launch-gate.pass writes AC artifact and launch-validated status', () => {
    const fixture = makeFixture();
    try {
      writeSamples(fixture.samples);
      const result = runLaunch(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readJson(fixture.out).pass, true);
      assert.equal(readJson(fixture.status).status, 'launch-validated');
      assert.equal(readJson(fixture.status).terminal_state, 'success-pending-soak');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('launch-gate.too-few-samples fails artifact', () => {
    const fixture = makeFixture();
    try {
      writeSamples(fixture.samples, { count: 9 });
      const result = runLaunch(fixture);
      assert.equal(result.status, 1);
      const artifact = readJson(fixture.out);
      assert.equal(artifact.pass, false);
      assert.match(artifact.failure_reason, /at least 10 samples/);
      assert.equal(existsSync(fixture.status), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('launch-gate.mismatch fails artifact', () => {
    const fixture = makeFixture();
    try {
      writeSamples(fixture.samples, { hashesMatch: (index) => index !== 4 });
      const result = runLaunch(fixture);
      assert.equal(result.status, 1);
      const artifact = readJson(fixture.out);
      assert.equal(artifact.pass, false);
      assert.equal(artifact.evidence.mismatch_count, 1);
      assert.match(artifact.failure_reason, /100% matching/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('launch-gate.too-early fails artifact', () => {
    const fixture = makeFixture();
    try {
      writeSamples(fixture.samples);
      const result = runLaunch(fixture, '2026-05-02T00:59:59.000Z');
      assert.equal(result.status, 1);
      const artifact = readJson(fixture.out);
      assert.equal(artifact.pass, false);
      assert.match(artifact.failure_reason, /one hour/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
