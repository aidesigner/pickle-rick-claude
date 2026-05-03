import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_ARTIFACT_SCHEMA,
  EXPECTED_BUNDLE_AC_IDS,
} from '../../bin/verify-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'verify-bundle.js');

function acFileName(acId) {
  return `${acId.toLowerCase()}.json`;
}

function artifact(acId, overrides = {}) {
  return {
    ac_id: acId,
    pass: true,
    checked_at: '2026-05-02T00:00:00.000Z',
    checker: 'verify-bundle.test',
    checker_version: 'test',
    evidence: {},
    failure_reason: null,
    remediation_hint: null,
    ...overrides,
  };
}

function makeFixture(mutator = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-bundle-'));
  const bundleDir = path.join(dir, 'bundle');
  mkdirSync(bundleDir, { recursive: true });
  for (const acId of EXPECTED_BUNDLE_AC_IDS) {
    writeFileSync(
      path.join(bundleDir, acFileName(acId)),
      `${JSON.stringify(artifact(acId), null, 2)}\n`,
    );
  }
  mutator({ dir, bundleDir });
  return dir;
}

function runVerifier(repoRoot, args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BUNDLE_REPO_ROOT: repoRoot },
  });
}

test('verify-bundle.valid-pass exits 0 when all expected artifacts pass', () => {
  const fixture = makeFixture();
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
    assert.equal(BUNDLE_ARTIFACT_SCHEMA.required.includes('failure_reason'), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.all-or-pass exits 1 when any artifact has pass false', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-08.json'),
      `${JSON.stringify(artifact('AC-DR-08', {
        pass: false,
        failure_reason: 'test-failure',
        remediation_hint: 'fix test fixture',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AC-DR-08: pass false/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.missing-inconclusive exits 2 when an artifact is missing', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AC-DR-09: missing bundle\/ac-dr-09\.json/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.malformed-fail exits 1 and names missing field', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    const bad = artifact('AC-DR-10');
    delete bad.checker_version;
    writeFileSync(path.join(bundleDir, 'ac-dr-10.json'), `${JSON.stringify(bad, null, 2)}\n`);
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required field: checker_version/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac validates only requested artifact', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-08']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /checked=1/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
