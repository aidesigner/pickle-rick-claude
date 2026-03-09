import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cancelSession } from '../bin/cancel.js';
import { updateSessionMap, getSessionForCwd } from '../bin/services/session-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-test-'));
}

function writeState(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    active: true,
    working_dir: '/test/cancel',
    step: 'implement',
    iteration: 3,
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'cancel test',
    current_ticket: 'ticket-1',
    history: [{ step: 'prd', timestamp: new Date().toISOString() }],
    started_at: new Date().toISOString(),
    session_dir: dir,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancel', () => {
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

  it('deactivates session and removes from map', async () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'cancel-deactivate');
    const cwd = '/test/cancel/deactivate';
    writeState(sessionDir, { working_dir: cwd });
    await updateSessionMap(cwd, sessionDir);

    // Verify it's in the map
    let found = await getSessionForCwd(cwd);
    assert.equal(found, sessionDir);

    // Cancel
    const result = await cancelSession(cwd);
    assert.ok(result, 'cancel should return true');

    // state.active should be false
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.active, false, 'state.active should be false');

    // Should be removed from map
    found = await getSessionForCwd(cwd);
    assert.equal(found, null, 'should not be in map after cancel');
  });

  it('preserves state.json after cancel', async () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'cancel-preserve');
    const cwd = '/test/cancel/preserve';
    writeState(sessionDir, { working_dir: cwd });
    await updateSessionMap(cwd, sessionDir);

    await cancelSession(cwd);

    // state.json should still exist with all fields
    const statePath = path.join(sessionDir, 'state.json');
    assert.ok(fs.existsSync(statePath), 'state.json should still exist');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.active, false);
    assert.equal(state.iteration, 3, 'iteration should be preserved');
    assert.equal(state.original_prompt, 'cancel test', 'prompt should be preserved');
    assert.equal(state.current_ticket, 'ticket-1', 'ticket should be preserved');
    assert.ok(state.history.length > 0, 'history should be preserved');
  });

  it('returns false for no active session', async () => {
    const result = await cancelSession('/nonexistent/no/session');
    assert.equal(result, false);
  });
});
