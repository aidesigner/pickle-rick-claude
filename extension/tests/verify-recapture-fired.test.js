// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
const CLI = path.join(REPO_ROOT, 'bin', 'verify-recapture-fired.js');
const STABLE_ARTIFACT = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');
const RUNTIME_ARTIFACT = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');

function makeSession(state) {
  const session = mkdtempSync(path.join(tmpdir(), 'verify-recapture-'));
  writeFileSync(path.join(session, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return session;
}

function runVerifier(session) {
  const result = spawnSync(process.execPath, [CLI, session], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    ...result,
    stableArtifact: JSON.parse(readFileSync(STABLE_ARTIFACT, 'utf8')),
    runtimeArtifact: JSON.parse(readFileSync(RUNTIME_ARTIFACT, 'utf8')),
  };
}

function baseState(activity) {
  return {
    history: [
      { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
      { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
      { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
    ],
    activity,
  };
}

test('verify-recapture.pass writes passing artifact when a recapture event is in the latest anatomy-park window', () => {
  const session = makeSession(baseState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 3,
    },
  ]));
  const baseline = readFileSync(STABLE_ARTIFACT, 'utf8');
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC-DR-02 PASS/);
    assert.equal(readFileSync(STABLE_ARTIFACT, 'utf8'), baseline);
    assert.deepEqual(validateBundleArtifact(result.stableArtifact), []);
    assert.equal(result.stableArtifact.pass, true);
    assert.equal(result.stableArtifact.failure_reason, null);
    assert.equal(result.stableArtifact.checker_version, '2');
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.no-event writes failing artifact when activity has no recapture event', () => {
  const session = makeSession(baseState([]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.wrong-phase fails when event timestamp is outside anatomy-park window', () => {
  const session = makeSession(baseState([
    {
      ts: '2026-05-02T10:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 1,
    },
  ]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.earlier-phase-run does not satisfy the latest anatomy run even if the iteration differs', () => {
  const session = makeSession(baseState([
    {
      ts: '2026-05-02T10:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 99,
    },
  ]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.stale-earlier-anatomy-window does not satisfy the latest anatomy run', () => {
  const session = makeSession({
    history: [
      { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
      { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
      { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
      { step: 'anatomy-park', timestamp: '2026-05-02T13:00:00.000Z' },
      { step: 'szechuan-sauce', timestamp: '2026-05-02T14:00:00.000Z' },
    ],
    activity: [
      {
        ts: '2026-05-02T11:15:00.000Z',
        event: 'baseline_recapture_attempted',
        iteration: 1,
      },
    ],
  });
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
    assert.deepEqual(result.runtimeArtifact.evidence.anatomy_windows, [
      { start: Date.parse('2026-05-02T13:00:00.000Z'), end: Date.parse('2026-05-02T14:00:00.000Z') },
    ]);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.state-missing exits 2 and writes state-missing artifact', () => {
  const session = mkdtempSync(path.join(tmpdir(), 'verify-recapture-missing-'));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 2);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.corrupt-state writes unreadable-state artifact instead of leaving stale runtime evidence', () => {
  const session = mkdtempSync(path.join(tmpdir(), 'verify-recapture-corrupt-'));
  writeFileSync(path.join(session, 'state.json'), '{bad json\n');
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-unreadable');
    assert.equal(result.runtimeArtifact.evidence.state_path, path.join(session, 'state.json'));
    assert.match(result.runtimeArtifact.evidence.read_error, /Expected property name|JSON/i);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});
