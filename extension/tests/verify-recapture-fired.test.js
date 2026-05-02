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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'verify-recapture-fired.js');
const ARTIFACT = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');

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
    artifact: JSON.parse(readFileSync(ARTIFACT, 'utf8')),
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

test('verify-recapture.pass writes passing artifact when iteration 1 event is in anatomy-park window', () => {
  const session = makeSession(baseState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 1,
    },
  ]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC-DR-02 PASS/);
    assert.equal(result.artifact.pass, true);
    assert.equal(result.artifact.failure_reason, null);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.no-event writes failing artifact when activity has no recapture event', () => {
  const session = makeSession(baseState([]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.artifact.pass, false);
    assert.equal(result.artifact.failure_reason, 'recapture-event-missing');
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
    assert.equal(result.artifact.pass, false);
    assert.equal(result.artifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.wrong-iteration fails when matching event is not iteration 1', () => {
  const session = makeSession(baseState([
    {
      ts: '2026-05-02T11:15:00.000Z',
      event: 'baseline_recapture_attempted',
      iteration: 2,
    },
  ]));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 1);
    assert.equal(result.artifact.pass, false);
    assert.equal(result.artifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('verify-recapture.state-missing exits 2 and writes state-missing artifact', () => {
  const session = mkdtempSync(path.join(tmpdir(), 'verify-recapture-missing-'));
  try {
    const result = runVerifier(session);
    assert.equal(result.status, 2);
    assert.equal(result.artifact.pass, false);
    assert.equal(result.artifact.failure_reason, 'state-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});
