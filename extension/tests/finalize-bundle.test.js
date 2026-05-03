import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateBundleArtifact } from '../../bin/verify-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'finalize-bundle.js');
const INSTALLED_AT = '2026-05-02T00:00:00.000Z';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sampleAt(index, overrides = {}) {
  return {
    ts: new Date(Date.parse(INSTALLED_AT) + index * 5 * 60 * 1000).toISOString(),
    src_version: '1.68.0',
    dep_version: '1.68.0',
    hashes_match: true,
    ...overrides,
  };
}

function writeSamples(filePath, count, mismatchIndex = null) {
  const lines = Array.from({ length: count }, (_, index) => {
    const overrides = index === mismatchIndex
      ? { dep_version: '1.67.0', hashes_match: false, drift: { dep_version: { baseline: '1.68.0', actual: '1.67.0' } } }
      : {};
    return JSON.stringify(sampleAt(index, overrides));
  });
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function makeFakeGh(dir) {
  const gh = path.join(dir, 'fake-gh.js');
  const log = path.join(dir, 'gh.log');
  writeFileSync(gh, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.GH_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
  ].join('\n'));
  chmodSync(gh, 0o755);
  return { gh, log };
}

function makeFixture({ sampleCount = 288, mismatchIndex = null, archive = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'finalize-bundle-'));
  const bundleDir = path.join(dir, 'bundle');
  const samples = path.join(dir, 'deploy-parity-samples.jsonl');
  const baseline = path.join(dir, 'deploy-baseline.json');
  const status = path.join(bundleDir, 'status.json');
  const archivePath = path.join(bundleDir, 'pre-deletion-archive', 'pickle-rick-claude-1.66.0.tar.gz');
  mkdirSync(bundleDir, { recursive: true });
  writeJson(baseline, { installed_at: INSTALLED_AT, src_version: '1.68.0', dep_version: '1.68.0' });
  writeSamples(samples, sampleCount, mismatchIndex);
  if (archive) {
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, 'archived release\n');
  }
  writeJson(path.join(bundleDir, 'v1.66.0-disposition.json'), {
    tag: 'v1.66.0',
    tarball_path: archivePath,
    decision_pending: true,
  });
  writeJson(status, {
    status: 'launch-validated',
    terminal_state: 'success-pending-soak',
    updated_at: INSTALLED_AT,
  });
  return { dir, bundleDir, samples, baseline, status, ...makeFakeGh(dir) };
}

function runFinalizer(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [
    CLI,
    '--baseline', fixture.baseline,
    '--samples', fixture.samples,
    '--bundle-dir', fixture.bundleDir,
    '--status', fixture.status,
    '--now', '2026-05-03T00:00:00.000Z',
    '--gh', fixture.gh,
    ...extraArgs,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GH_LOG: fixture.log },
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assertArtifact(filePath, acId, pass) {
  const parsed = readJson(filePath);
  assert.deepEqual(validateBundleArtifact(parsed), []);
  assert.equal(parsed.ac_id, acId);
  assert.equal(parsed.pass, pass);
  return parsed;
}

describe('finalize-bundle', () => {
  test('finalize-bundle.pass-case writes passing AC-DR-03 and AC-DR-12 artifacts', () => {
    const fixture = makeFixture();
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 0, result.stderr);
      assertArtifact(path.join(fixture.bundleDir, 'ac-dr-03.json'), 'AC-DR-03', true);
      assertArtifact(path.join(fixture.bundleDir, 'ac-dr-12.json'), 'AC-DR-12', true);
      assert.equal(readJson(fixture.status).status, 'pass');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.delete-on-pass invokes gh release delete v1.66.0 after archive exists', () => {
    const fixture = makeFixture();
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(fixture.log, 'utf8'), /^release delete v1\.66\.0 --yes\n$/);
      assert.equal(readJson(path.join(fixture.bundleDir, 'v1.66.0-disposition.json')).decision, 'deleted_post_soak');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.fail-case writes AC-DR-03 failure artifact on drift', () => {
    const fixture = makeFixture({ mismatchIndex: 12 });
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 1, result.stderr);
      const artifact = assertArtifact(path.join(fixture.bundleDir, 'ac-dr-03.failed.json'), 'AC-DR-03', false);
      assert.equal(artifact.failure_reason, 'deploy-drift');
      assert.equal(artifact.evidence.mismatch_count, 1);
      assert.equal(existsSync(path.join(fixture.bundleDir, 'ac-dr-12.json')), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.no-delete-on-fail never invokes gh when AC-DR-03 fails', () => {
    const fixture = makeFixture({ mismatchIndex: 12 });
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(fixture.log), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.state-flip writes pass and regression-detected states', () => {
    const passing = makeFixture();
    const failing = makeFixture({ mismatchIndex: 0 });
    try {
      assert.equal(runFinalizer(passing).status, 0);
      assert.equal(readJson(passing.status).status, 'pass');
      assert.equal(runFinalizer(failing).status, 1);
      assert.equal(readJson(failing.status).status, 'regression-detected');
    } finally {
      rmSync(passing.dir, { recursive: true, force: true });
      rmSync(failing.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.insufficient-samples exits 2 and writes AC-DR-03 pass false', () => {
    const fixture = makeFixture({ sampleCount: 50 });
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 2, result.stderr);
      const artifact = assertArtifact(path.join(fixture.bundleDir, 'ac-dr-03.json'), 'AC-DR-03', false);
      assert.equal(artifact.failure_reason, 'insufficient-samples');
      assert.equal(existsSync(fixture.log), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.dry-run-safe writes artifacts but performs no destructive delete', () => {
    const fixture = makeFixture();
    try {
      const result = runFinalizer(fixture, ['--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      const ac12 = assertArtifact(path.join(fixture.bundleDir, 'ac-dr-12.json'), 'AC-DR-12', true);
      assert.equal(ac12.evidence.delete_invoked, false);
      assert.equal(existsSync(fixture.log), false);
      assert.equal(readJson(path.join(fixture.bundleDir, 'v1.66.0-disposition.json')).decision, 'dry_run_delete_post_soak');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.archive-required-before-delete blocks cleanup without pre-deletion archive', () => {
    const fixture = makeFixture({ archive: false });
    try {
      const result = runFinalizer(fixture);
      assert.equal(result.status, 2, result.stderr);
      assertArtifact(path.join(fixture.bundleDir, 'ac-dr-03.json'), 'AC-DR-03', true);
      const ac12 = assertArtifact(path.join(fixture.bundleDir, 'ac-dr-12.json'), 'AC-DR-12', false);
      assert.equal(ac12.failure_reason, 'missing-pre-deletion-archive');
      assert.equal(existsSync(fixture.log), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('finalize-bundle.cli-guard rejects unknown arguments', () => {
    const result = spawnSync(process.execPath, [CLI, '--bogus'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument: --bogus/);
  });
});
