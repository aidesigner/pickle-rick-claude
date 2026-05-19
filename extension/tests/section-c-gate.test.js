// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'section-c-still-needed.js');

function makeSession(log) {
  const session = mkdtempSync(path.join(tmpdir(), 'section-c-gate-'));
  writeFileSync(path.join(session, 'tmux-runner.log'), log);
  return session;
}

function makeSessionWithLogs(logs) {
  const session = mkdtempSync(path.join(tmpdir(), 'section-c-gate-'));
  for (const [name, contents] of Object.entries(logs)) {
    writeFileSync(path.join(session, name), contents);
  }
  return session;
}

function runGate(session) {
  const result = spawnSync(process.execPath, [CLI, '--session', session], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const artifactPath = path.join(session, 'bundle', 'section-c-still-needed.json');
  return {
    ...result,
    artifactPath,
    artifact: JSON.parse(readFileSync(artifactPath, 'utf8')),
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
    assert.match(result.stdout, new RegExp(result.artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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

test('section-c-gate.pipeline-log-banner writes still_needed true when only pipeline-runner.log shows the symptom', () => {
  const session = makeSessionWithLogs({
    'tmux-runner.log': 'iteration 4 completed\niteration 5 starting\n',
    'pipeline-runner.log': 'phase handoff\n◤ FEED TERMINATED ◢\n',
  });
  try {
    const result = runGate(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.artifact.still_needed, true);
    assert.match(result.artifact.evidence, /FEED TERMINATED/);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test('section-c-gate.long-log-banner retains still_needed when the banner scrolls outside the trailing sample', () => {
  const lines = ['older line 0', '◤ FEED TERMINATED ◢'];
  for (let i = 0; i < 1005; i += 1) {
    lines.push(`iteration ${i} completed`);
  }
  const session = makeSession(lines.join('\n'));
  try {
    const result = runGate(session);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.artifact.still_needed, true);
    assert.match(result.artifact.evidence, /outside the trailing evidence sample/);
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

test('section-c-gate.default-session-selection follows newest watcher log activity, not newest session directory', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'section-c-home-'));
  const sessionsDir = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const activeSession = path.join(sessionsDir, '2026-05-12-active');
  const idleSession = path.join(sessionsDir, '2026-05-12-idle');
  mkdirSync(activeSession);
  writeFileSync(path.join(activeSession, 'tmux-runner.log'), 'iteration 4 completed\n');
  mkdirSync(idleSession);
  writeFileSync(path.join(idleSession, 'tmux-runner.log'), 'iteration 4 completed\niteration 5 starting\n');

  const activeLog = path.join(activeSession, 'tmux-runner.log');
  const now = new Date();
  const newer = new Date(now.getTime() + 60_000);
  utimesSync(activeLog, newer, newer);

  const result = spawnSync(process.execPath, [CLI], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
    },
  });
  const artifactPath = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'sessions', '2026-05-12-active', 'bundle', 'section-c-still-needed.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(artifact.still_needed, false);
    assert.match(artifact.evidence, /iteration 4 completed/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('section-c-gate.default-session-selection prefers sessions with watcher logs over newer empty session dirs', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'section-c-home-'));
  const sessionsDir = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const activeSession = path.join(sessionsDir, '2026-05-12-active');
  const emptySession = path.join(sessionsDir, '2026-05-12-empty');
  mkdirSync(activeSession);
  writeFileSync(path.join(activeSession, 'tmux-runner.log'), 'iteration 4 completed\niteration 5 starting\n');
  mkdirSync(emptySession);

  const activeLog = path.join(activeSession, 'tmux-runner.log');
  const now = new Date();
  const older = new Date(now.getTime() - 60_000);
  const newer = new Date(now.getTime() + 60_000);
  utimesSync(activeLog, older, older);
  utimesSync(emptySession, newer, newer);

  const result = spawnSync(process.execPath, [CLI], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
    },
  });
  const artifactPath = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'sessions', '2026-05-12-active', 'bundle', 'section-c-still-needed.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(artifact.still_needed, false);
    assert.match(artifact.evidence, /iteration 5 starting/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('section-c-gate.default-session-selection honors PICKLE_DATA_ROOT override for session discovery', () => {
  const fakeDataRoot = mkdtempSync(path.join(tmpdir(), 'section-c-data-root-'));
  const sessionsDir = path.join(fakeDataRoot, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const session = path.join(sessionsDir, '2026-05-12-custom-root');
  mkdirSync(session);
  writeFileSync(path.join(session, 'pipeline-runner.log'), 'phase handoff\niteration 5 starting\n');

  const result = spawnSync(process.execPath, [CLI], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PICKLE_DATA_ROOT: fakeDataRoot,
    },
  });
  const artifactPath = path.join(session, 'bundle', 'section-c-still-needed.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(artifact.still_needed, false);
    assert.match(artifact.evidence, /iteration 5 starting/);
  } finally {
    rmSync(fakeDataRoot, { recursive: true, force: true });
  }
});

test('section-c-gate.no-session writes runtime artifact outside the tracked repo bundle tree', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'section-c-home-'));
  const result = spawnSync(process.execPath, [CLI], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
    },
  });
  const artifactPath = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'bundle', 'section-c-still-needed.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(artifact.still_needed, true);
    assert.equal(artifactPath.startsWith(path.join(REPO_ROOT, 'bundle')), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('section-c-gate.cli-guard rejects unknown arguments', () => {
  const result = spawnSync(process.execPath, [CLI, '--bogus'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
