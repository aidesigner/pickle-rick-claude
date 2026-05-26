// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { respawnMonitorWindowForMode } from '../services/pickle-utils.js';

function makeTmpSession(stateFields = {}) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-mode-test-')));
  const sessionDir = path.join(tmpRoot, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const state = {
    session_dir: sessionDir,
    schema_version: 3,
    active: true,
    ...stateFields,
  };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    readState() {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    },
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function makeMockSpawnSync(sessionName = 'test-session', respawnStatus = 0, panePid = 12345) {
  const calls = [];
  const fn = (cmd, args = [], _opts = {}) => {
    calls.push({ cmd, args: [...args] });
    if (cmd !== 'tmux') return { status: 0, stdout: '', stderr: '' };
    const sub = args[0];
    if (sub === 'display-message') {
      // For pane_pid query (has format string arg)
      if (args.includes('#{pane_pid}')) return { status: 0, stdout: String(panePid) + '\n', stderr: '' };
      // For session name query
      return { status: 0, stdout: sessionName + '\n', stderr: '' };
    }
    if (sub === 'respawn-pane') return { status: respawnStatus, stdout: '', stderr: respawnStatus !== 0 ? 'mock error' : '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

test('respawnMonitorWindowForMode: no-op when monitor_mode already matches', async () => {
  const env = makeTmpSession({ monitor_mode: 'anatomy-park' });
  const spawnSyncFn = makeMockSpawnSync();
  try {
    const result = await respawnMonitorWindowForMode(env.sessionDir, 'anatomy-park', {
      spawnSyncFn,
      inTmux: true,
    });
    assert.equal(result, 'no-op');
    assert.equal(spawnSyncFn.calls.length, 0, 'no tmux calls should be made when mode already matches');
  } finally {
    env.cleanup();
  }
});

test('respawnMonitorWindowForMode: kills old pid, respawns, updates state', async () => {
  // Spawn a real process to act as the old monitor pid
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true });
  const oldPid = child.pid;
  assert.ok(typeof oldPid === 'number' && oldPid > 0, 'child process should have a valid pid');
  child.unref();

  const env = makeTmpSession({ monitor_mode: 'pickle', monitor_pid: oldPid });
  const spawnSyncFn = makeMockSpawnSync('test-session', 0, 99999);
  const logs = [];

  try {
    const result = await respawnMonitorWindowForMode(env.sessionDir, 'anatomy-park', {
      spawnSyncFn,
      inTmux: true,
      log: msg => logs.push(msg),
    });

    assert.equal(result, 'respawned');

    // Old pid should be dead
    let pidAlive = true;
    try { process.kill(oldPid, 0); } catch { pidAlive = false; }
    assert.equal(pidAlive, false, 'old monitor pid should be dead after respawn');

    // State should be updated
    const s = env.readState();
    assert.equal(s.monitor_mode, 'anatomy-park');
    assert.equal(s.monitor_pid, 99999);

    // AC-MDS-01: log line emitted
    assert.ok(logs.some(l => l.includes('monitor: respawned for mode anatomy-park')), 'AC-MDS-01 log line should be present');
  } finally {
    env.cleanup();
    // Ensure child is cleaned up even if the test body killed it already
    try { process.kill(oldPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('respawnMonitorWindowForMode: no monitor_pid in state — spawns fresh without throwing', async () => {
  const env = makeTmpSession({ monitor_mode: 'pickle' });
  const spawnSyncFn = makeMockSpawnSync('test-session', 0, 77777);

  try {
    const result = await respawnMonitorWindowForMode(env.sessionDir, 'szechuan-sauce', {
      spawnSyncFn,
      inTmux: true,
    });

    assert.equal(result, 'respawned');
    const s = env.readState();
    assert.equal(s.monitor_mode, 'szechuan-sauce');
    assert.equal(s.monitor_pid, 77777);
  } finally {
    env.cleanup();
  }
});

test('respawnMonitorWindowForMode: inTmux:false returns no-op without crashing', async () => {
  const env = makeTmpSession({ monitor_mode: 'pickle' });
  const spawnSyncFn = makeMockSpawnSync();
  const logs = [];

  try {
    const result = await respawnMonitorWindowForMode(env.sessionDir, 'anatomy-park', {
      spawnSyncFn,
      inTmux: false,
      log: msg => logs.push(msg),
    });

    assert.equal(result, 'no-op');
    assert.equal(spawnSyncFn.calls.length, 0, 'no tmux calls when tmux unavailable');
    assert.ok(logs.some(l => l.includes('tmux unavailable')), 'should log tmux unavailable message');

    // State should be unchanged
    const s = env.readState();
    assert.equal(s.monitor_mode, 'pickle');
  } finally {
    env.cleanup();
  }
});
