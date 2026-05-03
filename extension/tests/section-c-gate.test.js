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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'section-c-still-needed.js');
const ARTIFACT = path.join(REPO_ROOT, 'bundle', 'section-c-still-needed.json');

function makeSession(log) {
  const session = mkdtempSync(path.join(tmpdir(), 'section-c-gate-'));
  writeFileSync(path.join(session, 'tmux-runner.log'), log);
  return session;
}

function runGate(session) {
  const result = spawnSync(process.execPath, [CLI, '--session', session], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    ...result,
    artifact: JSON.parse(readFileSync(ARTIFACT, 'utf8')),
  };
}

test('section-c-gate.symptom-present writes still_needed true with evidence', () => {
  const session = makeSession([
    'iteration 4 completed',
    'watcher output',
    '◤ FEED TERMINATED ◢',
    'iteration 5 starting',
    '',
  ].join('\n'));
  try {
    const result = runGate(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.artifact.still_needed, true);
    assert.match(result.artifact.evidence, /FEED TERMINATED/);
    assert.match(result.stdout, /STILL_NEEDED/);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('section-c-gate.symptom-absent writes still_needed false for clean log', () => {
  const session = makeSession('iteration 4 completed\niteration 5 starting\n');
  try {
    const result = runGate(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.artifact.still_needed, false);
    assert.match(result.artifact.evidence, /iteration 5 starting/);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('section-c-gate.no-session exits zero and defaults still_needed true', () => {
  const missing = path.join(tmpdir(), `section-c-missing-${process.pid}-${Date.now()}`);
  const result = runGate(missing);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.artifact.still_needed, true);
  assert.match(result.artifact.evidence, /No recent session found/);
});

test('section-c-gate.cli-guard rejects unknown arguments', () => {
  const result = spawnSync(process.execPath, [CLI, '--bogus'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
