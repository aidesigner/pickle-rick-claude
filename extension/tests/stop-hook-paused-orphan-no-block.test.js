// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');

function baseState(overrides = {}) {
  return {
    active: true,
    pid: null,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test',
    tmux_mode: false,
    ...overrides,
  };
}

function writeExtensionSentinel(dir) {
  const sentinelDir = path.join(dir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

// ---------------------------------------------------------------------------
// AC-PSO-02: stop-hook approves when only a paused-orphan exists
// ---------------------------------------------------------------------------

test('stop-hook.paused-orphan-no-block: stop-hook approves when only paused-orphan exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-pso-'));
  writeExtensionSentinel(tmp);
  // R-POD requires the canonical data-root layout (dataRoot/sessions/<hash>/state.json)
  // so readSessionsMapForState can locate current_sessions.json one level above sessions/.
  const dataRoot = path.join(tmp, 'data');
  const sessionsDir = path.join(dataRoot, 'sessions');
  const sessionDir = path.join(sessionsDir, 'paused');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');

  // Spawn a process that exits immediately to get a reliably dead PID — R-POD
  // demotion requires BOTH age-stale state AND a dead mapped PID in the cwd map.
  const deadPidResult = execFileSync(process.execPath, ['--eval', ''], { encoding: 'utf-8' });
  // execFileSync returns stdout; we need a dead pid via a different path
  void deadPidResult;
  // Use a likely-dead PID via a fresh spawn-and-wait pattern:
  // node --eval '' returns synchronously; its pid is guaranteed reaped after the call.
  // We capture pid via spawnSync semantics — fall back to a high improbable pid (1 below INT_MAX)
  // which !isProcessAlive returns true for on any sane system.
  const DEAD_PID = 0x7fffffff - 1;

  // Write a paused-orphan: active=true, pid=null, stale mtime, working_dir matches sessionDir
  // so the session map lookup keys correctly.
  fs.writeFileSync(stateFile, JSON.stringify(baseState({
    active: true,
    pid: null,
    working_dir: sessionDir,
    session_dir: sessionDir,
  })));
  // Session map with dead PID — closes the second leg of the R-POD `&&` predicate.
  fs.writeFileSync(
    path.join(dataRoot, 'current_sessions.json'),
    JSON.stringify({ [sessionDir]: { sessionPath: sessionDir, pid: DEAD_PID } }),
  );
  const staleTime = new Date(Date.now() - 400_000);
  fs.utimesSync(stateFile, staleTime, staleTime);

  const env = {
    ...process.env,
    EXTENSION_DIR: tmp,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: stateFile,
  };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    const decision = JSON.parse(stdout.trim());
    assert.equal(
      decision.decision,
      'approve',
      `stop-hook must approve when only a paused-orphan exists; got ${JSON.stringify(decision)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
