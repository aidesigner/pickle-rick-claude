// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../services/state-manager.js';

const sm = new StateManager();
const STALE_AGE_MS = 400_000; // 400s > 300s threshold
const FRESH_AGE_MS = 60_000;  // 60s < 300s threshold

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-orphan-'));
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
    session_dir: '/tmp/test',
    ...overrides,
  };
}

function writeStaleMtime(stateFile) {
  const staleTime = new Date(Date.now() - STALE_AGE_MS);
  fs.utimesSync(stateFile, staleTime, staleTime);
}

function writeFreshMtime(stateFile) {
  const freshTime = new Date(Date.now() - FRESH_AGE_MS);
  fs.utimesSync(stateFile, freshTime, freshTime);
}

// ---------------------------------------------------------------------------
// Case 1: (null, true, stale) → demoted
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,stale) demotes active to false with orphan-paused-no-claim', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'active must be false after demotion');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    assert.ok(Array.isArray(state.activity), 'activity must be an array');
    const demoted = state.activity.filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demoted.length, 1, 'exactly one demotion event');
    assert.equal(demoted[0].event, 'paused_session_orphan_demoted');
    assert.equal(demoted[0].pid_orig, null);
    assert.ok(typeof demoted[0].mtime_age_seconds === 'number' && demoted[0].mtime_age_seconds >= 400);
    assert.ok(typeof demoted[0].ts === 'string');

    // Persisted to disk
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.active, false, 'disk must reflect active=false');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 2: (null, true, fresh) → no-op
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,fresh) leaves active untouched', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, true, 'fresh mtime must not trigger demotion');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'no demotion event for fresh state',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 3: (null, false, stale) → no-op
// ---------------------------------------------------------------------------

test('paused-orphan: (null,false,stale) does not re-demote already-inactive session', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: false, pid: null })));
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, false);
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'no demotion event when already inactive',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 4: idempotent — run twice, only one event emitted
// ---------------------------------------------------------------------------

test('paused-orphan: idempotent — pre-existing demotion event suppresses re-emit', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    // State already has a demotion event but active was somehow restored
    const existingEvent = {
      event: 'paused_session_orphan_demoted',
      kind: 'paused_session_orphan_demoted',
      pid_orig: null,
      mtime_age_seconds: 500,
      ts: new Date(Date.now() - 500_000).toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(baseState({
      active: true,
      pid: null,
      activity: [existingEvent],
    })));
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    const demotions = (state.activity ?? []).filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demotions.length, 1, 'must not double-emit the demotion event');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 5: boundary — mtime === now - 300s (exactly threshold) demotes
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,boundary) at exactly 300s mtime fires demotion (inclusive boundary)', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    const boundaryTime = new Date(Date.now() - 300_000);
    fs.utimesSync(stateFile, boundaryTime, boundaryTime);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'boundary mtime (300s) must demote');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    const demoted = (state.activity ?? []).filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demoted.length, 1, 'exactly one demotion at boundary');
    assert.ok(
      typeof demoted[0].mtime_age_seconds === 'number' && demoted[0].mtime_age_seconds >= 300,
      'mtime_age_seconds must be >= 300 at boundary',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});
