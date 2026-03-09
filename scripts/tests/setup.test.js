import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setup } from '../bin/setup.js';
import { getSessionForCwd } from '../bin/services/session-map.js';
import { cancelSession } from '../bin/cancel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup', () => {
  let origExtDir;
  let tmpRoot;

  before(() => {
    origExtDir = process.env.EXTENSION_DIR;
    tmpRoot = makeTmpDir();
    process.env.EXTENSION_DIR = tmpRoot;
  });

  after(() => {
    if (origExtDir !== undefined) {
      process.env.EXTENSION_DIR = origExtDir;
    } else {
      delete process.env.EXTENSION_DIR;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates state.json with all fields', async () => {
    const sessionDir = await setup(['Test task', '--runtime', 'claude']);

    const statePath = path.join(sessionDir, 'state.json');
    assert.ok(fs.existsSync(statePath), 'state.json should exist');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    // Required fields always present in JSON
    const requiredFields = [
      'active', 'working_dir', 'step', 'iteration', 'max_iterations',
      'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch',
      'completion_promise', 'original_prompt', 'current_ticket', 'history',
      'started_at', 'session_dir', 'tmux_mode', 'min_iterations',
      'chain_meeseeks', 'runtime',
    ];

    for (const field of requiredFields) {
      assert.ok(field in state, `state should have field "${field}"`);
    }
    // 18 required fields present
    assert.ok(requiredFields.every(f => f in state), 'all 18 required fields present');

    assert.equal(state.active, true);
    assert.equal(state.step, 'prd');
    assert.equal(state.iteration, 0);
    assert.equal(state.original_prompt, 'Test task');
    assert.equal(state.runtime, 'claude');
    assert.equal(state.completion_promise, null);
    assert.equal(state.current_ticket, null);
    assert.ok(Array.isArray(state.history));
    assert.ok(typeof state.start_time_epoch === 'number');
    assert.ok(typeof state.started_at === 'string');
    assert.equal(state.session_dir, sessionDir);
  });

  it('registers session in session map', async () => {
    const cwd = process.cwd();
    const sessionDir = await setup(['Register test', '--runtime', 'claude']);

    const found = await getSessionForCwd(cwd);
    assert.equal(found, sessionDir, 'session map should contain the new session');
  });

  it('prunes old sessions from map', async () => {
    const cwd = process.cwd();
    const sessionsRoot = path.join(tmpRoot, 'sessions');

    // Create a fake old session
    const oldDir = path.join(sessionsRoot, '2020-01-01-deadbeef');
    fs.mkdirSync(oldDir, { recursive: true });
    const oldState = {
      active: false,
      started_at: '2020-01-01T00:00:00.000Z',
      working_dir: '/fake/old/path',
    };
    fs.writeFileSync(path.join(oldDir, 'state.json'), JSON.stringify(oldState));

    // Manually add to map
    const mapPath = path.join(tmpRoot, 'current_sessions.json');
    let map = {};
    try { map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')); } catch { /* ok */ }
    map['/fake/old/path'] = oldDir;
    fs.writeFileSync(mapPath, JSON.stringify(map));

    // Run setup (triggers pruning)
    await setup(['Prune test', '--runtime', 'claude']);

    // Old entry should be gone from map
    const updatedMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    assert.equal(updatedMap['/fake/old/path'], undefined, 'old session should be pruned from map');
  });

  it('lifecycle round-trip: setup → get-session → cancel → get-session', async () => {
    const cwd = process.cwd();

    // Setup
    const sessionDir = await setup(['Round-trip test', '--runtime', 'claude']);
    assert.ok(sessionDir);

    // Get-session finds it
    let found = await getSessionForCwd(cwd);
    assert.equal(found, sessionDir);

    // Cancel
    const cancelled = await cancelSession(cwd);
    assert.ok(cancelled, 'cancel should succeed');

    // Get-session no longer finds it
    found = await getSessionForCwd(cwd);
    assert.equal(found, null, 'session should not be found after cancel');
  });
});
