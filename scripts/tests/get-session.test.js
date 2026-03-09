import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSessionForCwd,
  updateSessionMap,
  findLastSessionForCwd,
  listSessions,
} from '../bin/services/session-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'getsession-test-'));
}

function writeState(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    active: true,
    working_dir: '/test/cwd',
    step: 'implement',
    iteration: 1,
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
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

describe('get-session', () => {
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

  it('resolves session by cwd', async () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'test-resolve');
    writeState(sessionDir);
    await updateSessionMap('/test/resolve', sessionDir);

    const found = await getSessionForCwd('/test/resolve');
    assert.equal(found, sessionDir);
  });

  it('returns null for unknown cwd', async () => {
    const found = await getSessionForCwd('/nonexistent/path');
    assert.equal(found, null);
  });

  it('--last scans sessions dir and re-registers', async () => {
    const sessionsRoot = path.join(tmpRoot, 'sessions');
    const targetCwd = '/test/last-scan';

    // Create two sessions with different timestamps
    const older = path.join(sessionsRoot, 'older-session');
    writeState(older, {
      working_dir: targetCwd,
      started_at: '2026-03-01T00:00:00.000Z',
    });

    const newer = path.join(sessionsRoot, 'newer-session');
    writeState(newer, {
      working_dir: targetCwd,
      started_at: '2026-03-07T00:00:00.000Z',
    });

    // Not in map — findLastSessionForCwd should scan and find the newer one
    const found = await findLastSessionForCwd(targetCwd);
    assert.equal(found, newer, 'should find the most recent session');

    // Verify it got re-registered
    const fromMap = await getSessionForCwd(targetCwd);
    assert.equal(fromMap, newer, 'should be re-registered in map');
  });

  it('file locking handles concurrent operations', async () => {
    const cwd1 = '/test/concurrent1';
    const cwd2 = '/test/concurrent2';
    const dir1 = path.join(tmpRoot, 'sessions', 'concurrent1');
    const dir2 = path.join(tmpRoot, 'sessions', 'concurrent2');
    writeState(dir1);
    writeState(dir2);

    // Run two updates in parallel
    await Promise.all([
      updateSessionMap(cwd1, dir1),
      updateSessionMap(cwd2, dir2),
    ]);

    // Both should be in the map
    const found1 = await getSessionForCwd(cwd1);
    const found2 = await getSessionForCwd(cwd2);
    assert.equal(found1, dir1, 'first concurrent update should persist');
    assert.equal(found2, dir2, 'second concurrent update should persist');
  });

  it('listSessions returns all entries', async () => {
    const sessions = await listSessions();
    assert.ok(sessions.length > 0, 'should have at least one session');
    for (const s of sessions) {
      assert.ok(s.cwd, 'each entry should have cwd');
      assert.ok(s.sessionDir, 'each entry should have sessionDir');
    }
  });
});
