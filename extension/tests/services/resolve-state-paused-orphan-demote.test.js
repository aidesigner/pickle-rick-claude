// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../services/state-manager.js';

const sm = new StateManager();
const FRESH_AGE_MS = 60_000; // 60s — well under the 300s age gate

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestSession() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-phantom-'));
  const sessionDir = path.join(dataRoot, 'sessions', 'session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  return { dataRoot, sessionDir, stateFile };
}

function phantomState(overrides = {}) {
  return {
    active: true,
    pid: null,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 5,
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

function writeFreshMtime(stateFile) {
  const freshTime = new Date(Date.now() - FRESH_AGE_MS);
  fs.utimesSync(stateFile, freshTime, freshTime);
}

// ---------------------------------------------------------------------------
// Positive: full phantom signature → demoted immediately regardless of mtime
// ---------------------------------------------------------------------------

test('phantom-demote: active=true pid=null tmux_mode=false iteration=0 history=[] → demoted on first read (fresh mtime)', () => {
  const { stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(phantomState()));
    writeFreshMtime(stateFile); // age = 60s, well under 300s gate

    const state = sm.read(stateFile);

    assert.strictEqual(state.active, false, 'session should be demoted to active:false');
    assert.strictEqual(state.exit_reason, 'orphan_phantom_demoted', 'exit_reason should be orphan_phantom_demoted');
    assert.ok(Array.isArray(state.activity), 'activity should be an array');
    const event = state.activity.find(a => a.kind === 'orphan_phantom_demoted');
    assert.ok(event, 'orphan_phantom_demoted activity event should be present');
    assert.strictEqual(event.event, 'orphan_phantom_demoted');
    assert.ok(typeof event.ts === 'string', 'event.ts should be a string');
  } finally {
    try { fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Negative 1: pid set → NOT demoted
// ---------------------------------------------------------------------------

test('phantom-demote: pid set → session left untouched', () => {
  const { stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(phantomState({ pid: process.pid })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.strictEqual(state.active, true, 'session with pid set should remain active');
    assert.ok(!state.exit_reason || state.exit_reason === null, 'exit_reason should not be set');
  } finally {
    try { fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Negative 2: tmux_mode true → NOT demoted
// ---------------------------------------------------------------------------

test('phantom-demote: tmux_mode=true → session left untouched', () => {
  const { stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(phantomState({ tmux_mode: true })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.strictEqual(state.active, true, 'tmux_mode session should remain active');
    assert.ok(!state.exit_reason || state.exit_reason === null, 'exit_reason should not be set');
  } finally {
    try { fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Negative 3: iteration > 0 → NOT demoted
// ---------------------------------------------------------------------------

test('phantom-demote: iteration=1 → session left untouched', () => {
  const { stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(phantomState({ iteration: 1 })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.strictEqual(state.active, true, 'session with iteration>0 should remain active');
    assert.ok(!state.exit_reason || state.exit_reason === null, 'exit_reason should not be set');
  } finally {
    try { fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Negative 4: history non-empty → NOT demoted
// ---------------------------------------------------------------------------

test('phantom-demote: history non-empty → session left untouched', () => {
  const { stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(phantomState({ history: ['some-ticket'] })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.strictEqual(state.active, true, 'session with non-empty history should remain active');
    assert.ok(!state.exit_reason || state.exit_reason === null, 'exit_reason should not be set');
  } finally {
    try { fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
