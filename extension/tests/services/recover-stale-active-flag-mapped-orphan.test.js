// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../../services/state-manager.js';

const sm = new StateManager();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mapped-orphan-'));
}

function baseState(sessionDir, overrides = {}) {
  return {
    active: true,
    pid: null,
    working_dir: process.cwd(),
    step: 'implement',
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
    session_dir: sessionDir,
    ...overrides,
  };
}

test('recoverStaleActiveFlag: mapped dead PID demotes fresh pid=null orphan on read', () => {
  const dataRoot = tmpDir();
  try {
    const sessionDir = path.join(dataRoot, 'sessions', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState(sessionDir)));
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({
        [process.cwd()]: {
          sessionPath: sessionDir,
          pid: 99999999,
        },
      }),
    );
    const freshTime = new Date(Date.now() - 60_000);
    fs.utimesSync(stateFile, freshTime, freshTime);

    const state = sm.read(stateFile);

    assert.equal(state.active, false);
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    const demotion = (state.activity ?? []).find((entry) => entry.kind === 'paused_session_orphan_demoted');
    assert.ok(demotion, 'expected paused_session_orphan_demoted activity');
    assert.equal(demotion?.mapped_pid, 99999999);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
