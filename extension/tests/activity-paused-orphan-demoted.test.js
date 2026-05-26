// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../services/state-manager.js';

const sm = new StateManager();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'act-pso-'));
}

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
    session_dir: '/tmp/test-session',
    tmux_mode: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-PSO-03: activity event recorded with required fields
// ---------------------------------------------------------------------------

test('activity.paused-orphan-demoted: demotion emits event with mtime_age_seconds, pid_orig, ts', () => {
  const tmp = tmpDir();
  try {
    // R-POD requires dataRoot/sessions/<hash>/state.json layout so
    // readSessionsMapForState finds current_sessions.json at dataRoot.
    const dataRoot = path.join(tmp, 'data');
    const sessionDir = path.join(dataRoot, 'sessions', 'pso-03');
    fs.mkdirSync(sessionDir, { recursive: true });
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({
      active: true,
      pid: null,
      step: 'prd',
      session_dir: sessionDir,
      working_dir: sessionDir,
    })));
    // R-POD `&&` predicate needs dead mapped PID.
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [sessionDir]: { sessionPath: sessionDir, pid: 999999 } }),
    );
    const staleTime = new Date(Date.now() - 400_000);
    fs.utimesSync(stateFile, staleTime, staleTime);

    const state = sm.read(stateFile);

    assert.ok(Array.isArray(state.activity), 'activity must be an array');
    const events = state.activity.filter(a => a?.kind === 'paused_session_orphan_demoted');
    assert.equal(events.length, 1, 'exactly one paused_session_orphan_demoted event');

    const evt = events[0];
    assert.equal(evt.event, 'paused_session_orphan_demoted');
    assert.equal(evt.pid_orig, null, 'pid_orig must be null');
    assert.ok(
      typeof evt.mtime_age_seconds === 'number' && evt.mtime_age_seconds >= 400,
      `mtime_age_seconds must be >= 400 (got ${evt.mtime_age_seconds})`,
    );
    assert.ok(typeof evt.ts === 'string' && evt.ts.length > 0, 'ts must be a non-empty string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
