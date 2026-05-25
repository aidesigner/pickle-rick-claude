// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../services/state-manager.js';

const sm = new StateManager();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-pso-demote-'));
}

function baseState(overrides = {}) {
  return {
    active: true,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-PSO-01: pid==null && active=true && mtime>300s → demoted
// ---------------------------------------------------------------------------

test('resolve-state.paused-orphan-demote: stale mtime+null pid demotes active session', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    const staleTime = new Date(Date.now() - 400_000);
    fs.utimesSync(stateFile, staleTime, staleTime);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'active must be false after paused-orphan demotion');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-PSO-04: existing dead-pid demotion must still pass
// ---------------------------------------------------------------------------

test('resolve-state.dead-pid-demote: dead numeric pid demotes active session', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    // PID 999999 is virtually guaranteed to be dead on any normal system.
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: 999999 })));

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'active must be false when pid is dead');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
