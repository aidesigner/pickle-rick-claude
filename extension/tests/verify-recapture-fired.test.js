// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  utimesSync,
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
const DEAD_TMP_PID = 99_999_999;

function makeSession(state) {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-')));
  writeFileSync(path.join(session, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return session;
}

function runtimeArtifactPath(session) {
  return path.join(session, 'bundle', 'ac-dr-02.runtime.json');
}

function readOptionalFile(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

function runVerifier(session) {
  const runtimeArtifactPathForSession = runtimeArtifactPath(session);
  const result = spawnSync(process.execPath, [CLI, session], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    ...result,
    stableArtifact: JSON.parse(readFileSync(STABLE_ARTIFACT, 'utf8')),
    runtimeArtifactPath: runtimeArtifactPathForSession,
    runtimeArtifact: JSON.parse(readFileSync(runtimeArtifactPathForSession, 'utf8')),
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

function recoverableState(activity) {
  return {
    active: false,
    working_dir: REPO_ROOT,
    step: 'anatomy-park',
    iteration: 7,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'verify recapture orphan recovery',
    history: [
      { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
      { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
      { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
    ],
    activity,
    started_at: '2026-05-02T10:00:00.000Z',
    session_dir: REPO_ROOT,
    schema_version: 4,
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
    assert.match(result.stdout, new RegExp(result.runtimeArtifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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

test('verify-recapture.recovers orphan tmp state before evaluating the latest anatomy window', () => {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-orphan-')));
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  writeFileSync(statePath, '{bad json\n');
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 7,
    },
  ]), null, 2)}\n`);
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(orphanPath), false, 'orphan tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers corrupt-base orphan tmp state even when the tmp pid has been reused by a live process', () => {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-live-pid-corrupt-')));
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${process.pid}`;
  writeFileSync(statePath, '{bad json\n');
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 7,
    },
  ]), null, 2)}\n`);
  utimesSync(statePath, new Date(500), new Date(500));
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(orphanPath), false, 'reused live pid tmp should still be promoted when it predates the current process');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers orphan tmp state when state.json is missing entirely', () => {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-missing-base-')));
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 7,
    },
  ]), null, 2)}\n`);
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(statePath), true, 'missing base state should be recreated from orphan tmp');
    assert.equal(existsSync(orphanPath), false, 'orphan tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers missing-base orphan tmp state even when the tmp pid has been reused by a live process', () => {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-live-pid-missing-')));
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${process.pid}`;
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 7,
    },
  ]), null, 2)}\n`);
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(statePath), true, 'missing base state should be recreated from a reused-live-pid tmp snapshot');
    assert.equal(existsSync(orphanPath), false, 'reused live pid tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.session-runtime-artifacts do not overwrite evidence from another session', () => {
  const repoRuntimeArtifact = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');
  const repoRuntimeBaseline = readOptionalFile(repoRuntimeArtifact);
  const passSession = makeSession(baseState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 3,
    },
  ]));
  const failSession = makeSession(baseState([]));
  try {
    const passResult = runVerifier(passSession);
    assert.equal(passResult.status, 0, passResult.stderr);
    assert.equal(passResult.runtimeArtifact.pass, true);

    const passArtifactSnapshot = readFileSync(passResult.runtimeArtifactPath, 'utf8');
    const failResult = runVerifier(failSession);
    assert.equal(failResult.status, 1, failResult.stderr);
    assert.equal(failResult.runtimeArtifact.pass, false);
    assert.equal(failResult.runtimeArtifact.failure_reason, 'recapture-event-missing');

    assert.equal(readFileSync(passResult.runtimeArtifactPath, 'utf8'), passArtifactSnapshot);
    assert.equal(
      readOptionalFile(repoRuntimeArtifact),
      repoRuntimeBaseline,
      'repo-global runtime artifact must remain untouched when a session root is provided',
    );
  } finally {
    rmSync(passSession, { recursive: true, force: true });
    rmSync(failSession, { recursive: true, force: true });
  }
});

test('verify-recapture.no-session writes runtime artifact outside the tracked repo bundle tree', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'verify-recapture-home-'));
  const baseline = readFileSync(STABLE_ARTIFACT, 'utf8');
  const repoRuntimeArtifact = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');
  const repoRuntimeBaseline = readOptionalFile(repoRuntimeArtifact);
  const runtimeArtifact = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'bundle', 'ac-dr-02.runtime.json');

  try {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });

    assert.equal(result.status, 2);
    assert.equal(readFileSync(STABLE_ARTIFACT, 'utf8'), baseline);
    assert.equal(readOptionalFile(repoRuntimeArtifact), repoRuntimeBaseline);
    assert.equal(runtimeArtifact.startsWith(path.join(REPO_ROOT, 'bundle')), false);

    const artifact = JSON.parse(readFileSync(runtimeArtifact, 'utf8'));
    assert.equal(artifact.pass, false);
    assert.equal(artifact.failure_reason, 'state-missing');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
