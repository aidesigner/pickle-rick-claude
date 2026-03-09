import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { showStatus } from '../bin/status.js';
import { circuitReset } from '../bin/circuit-reset.js';
import { updateSessionMap } from '../bin/services/session-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
}

function writeState(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    active: true,
    working_dir: '/test/status',
    step: 'implement',
    iteration: 5,
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 300,
    completion_promise: null,
    original_prompt: 'status test',
    current_ticket: 'ticket-42',
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

describe('status', () => {
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

  it('displays iteration, step, ticket, and elapsed time', async () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'status-display');
    const cwd = '/test/status/display';
    writeState(sessionDir, { working_dir: cwd });
    await updateSessionMap(cwd, sessionDir);

    const output = await showStatus(cwd);

    assert.ok(output.includes('5 of 100'), 'should show iteration count');
    assert.ok(output.includes('implement'), 'should show step');
    assert.ok(output.includes('ticket-42'), 'should show ticket');
    assert.ok(/\d+m \d+s/.test(output), 'should show elapsed time');
    assert.ok(output.includes('Active: Yes'), 'should show active status');
  });

  it('displays CB state when circuit_breaker.json exists', async () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'status-cb');
    const cwd = '/test/status/cb';
    writeState(sessionDir, { working_dir: cwd });
    await updateSessionMap(cwd, sessionDir);

    // Write CB file
    const cbState = {
      state: 'OPEN',
      last_change: new Date().toISOString(),
      consecutive_no_progress: 5,
      consecutive_same_error: 0,
      last_error_signature: null,
      last_known_head: '',
      last_known_step: null,
      last_known_ticket: null,
      last_progress_iteration: 0,
      total_opens: 1,
      reason: 'No progress in 5 iterations',
      opened_at: new Date().toISOString(),
      history: [],
    };
    fs.writeFileSync(path.join(sessionDir, 'circuit_breaker.json'), JSON.stringify(cbState));

    const output = await showStatus(cwd);
    assert.ok(output.includes('Circuit Breaker: OPEN'), 'should show CB state');
    assert.ok(output.includes('No progress'), 'should show CB reason');
  });

  it('returns message for no session', async () => {
    const output = await showStatus('/nonexistent/no/session');
    assert.ok(output.includes('No active session'), 'should indicate no session');
  });
});

describe('circuit-reset', () => {
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

  it('deletes CB file and logs event', () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'cb-reset');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create CB file
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    fs.writeFileSync(cbPath, JSON.stringify({ state: 'OPEN' }));

    const result = circuitReset(sessionDir);
    assert.ok(result, 'should return true');
    assert.ok(!fs.existsSync(cbPath), 'circuit_breaker.json should be deleted');

    // Check activity log
    const activityDir = path.join(tmpRoot, 'activity');
    assert.ok(fs.existsSync(activityDir), 'activity dir should exist');

    const date = new Date().toLocaleDateString('en-CA');
    const logPath = path.join(activityDir, `${date}.jsonl`);
    assert.ok(fs.existsSync(logPath), 'activity log should exist');

    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('circuit_reset'), 'log should contain circuit_reset event');
  });

  it('returns false for missing CB file', () => {
    const sessionDir = path.join(tmpRoot, 'sessions', 'cb-none');
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = circuitReset(sessionDir);
    assert.equal(result, false);
  });
});
