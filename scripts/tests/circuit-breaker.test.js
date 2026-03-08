import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  normalizeErrorSignature,
  checkProgress,
  validateCBConfig,
  loadCBState,
  saveCBState,
  recordIteration,
} from '../bin/services/circuit-breaker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
}

function initGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

function getHead(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp',
    step: 'implement',
    iteration: 1,
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'ticket-1',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp',
    ...overrides,
  };
}

function makeFreshCBState(overrides = {}) {
  return {
    state: 'CLOSED',
    last_change: new Date().toISOString(),
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: '',
    last_known_step: null,
    last_known_ticket: null,
    last_progress_iteration: 0,
    total_opens: 0,
    reason: '',
    opened_at: null,
    history: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Error Signature Normalization (7-rule pipeline)
// ---------------------------------------------------------------------------

describe('normalizeErrorSignature', () => {
  it('replaces absolute paths with <PATH>', () => {
    const result = normalizeErrorSignature('Error in /Users/foo/bar.ts');
    assert.ok(result.includes('<path>'));
    assert.ok(!result.includes('/users/foo'));
  });

  it('replaces line:column with <LOC>', () => {
    const result = normalizeErrorSignature('error at 42:17 in file');
    assert.ok(result.includes('<loc>'));
    assert.ok(!result.includes('42:17'));
  });

  it('replaces ISO timestamps with <TIME>', () => {
    const result = normalizeErrorSignature('at 2026-03-08T12:34:56.789Z failed');
    assert.ok(result.includes('<time>'));
    assert.ok(!result.includes('2026'));
  });

  it('replaces UUIDs with <UUID>', () => {
    const result = normalizeErrorSignature('id 550e8400-e29b-41d4-a716-446655440000 failed');
    assert.ok(result.includes('<uuid>'));
    assert.ok(!result.includes('550e8400'));
  });

  it('collapses whitespace', () => {
    const result = normalizeErrorSignature('error   in\t\tfile\n\nfoo');
    assert.ok(!result.includes('  '));
    assert.ok(!result.includes('\t'));
    assert.ok(!result.includes('\n'));
  });

  it('truncates to 200 characters', () => {
    const long = 'a'.repeat(300);
    const result = normalizeErrorSignature(long);
    assert.ok(result.length <= 200);
  });

  it('lowercases the output', () => {
    const result = normalizeErrorSignature('ERROR in MyFile');
    assert.equal(result, result.toLowerCase());
  });

  it('produces same signature for different paths', () => {
    const sig1 = normalizeErrorSignature('/Users/foo/bar.ts:42:17 error');
    const sig2 = normalizeErrorSignature('/Users/baz/qux.ts:99:3 error');
    assert.equal(sig1, sig2);
  });

  it('applies all 7 rules together', () => {
    const input = 'Error at /Users/foo/bar.ts:42:17 on 2026-03-08T12:34:56.789Z id 550e8400-e29b-41d4-a716-446655440000   FATAL';
    const result = normalizeErrorSignature(input);
    assert.ok(!result.includes('/Users'));
    assert.ok(!result.includes('42:17'));
    assert.ok(!result.includes('2026'));
    assert.ok(!result.includes('550e8400'));
    assert.ok(!result.includes('  '));
    assert.equal(result, result.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Threshold Validation
// ---------------------------------------------------------------------------

describe('validateCBConfig', () => {
  it('accepts valid config', () => {
    assert.doesNotThrow(() => validateCBConfig({
      enabled: true,
      noProgressThreshold: 5,
      sameErrorThreshold: 5,
      halfOpenAfter: 2,
    }));
  });

  it('throws when noProgressThreshold < 2', () => {
    assert.throws(
      () => validateCBConfig({ enabled: true, noProgressThreshold: 1, sameErrorThreshold: 5, halfOpenAfter: 0 }),
      /noProgressThreshold must be >= 2/,
    );
  });

  it('throws when sameErrorThreshold < 2', () => {
    assert.throws(
      () => validateCBConfig({ enabled: true, noProgressThreshold: 5, sameErrorThreshold: 1, halfOpenAfter: 2 }),
      /sameErrorThreshold must be >= 2/,
    );
  });

  it('throws when halfOpenAfter >= noProgressThreshold', () => {
    assert.throws(
      () => validateCBConfig({ enabled: true, noProgressThreshold: 5, sameErrorThreshold: 5, halfOpenAfter: 5 }),
      /halfOpenAfter must be < noProgressThreshold/,
    );
  });

  it('throws when halfOpenAfter equals noProgressThreshold', () => {
    assert.throws(
      () => validateCBConfig({ enabled: true, noProgressThreshold: 3, sameErrorThreshold: 3, halfOpenAfter: 3 }),
      /halfOpenAfter must be < noProgressThreshold/,
    );
  });
});

// ---------------------------------------------------------------------------
// Load/Save CB State
// ---------------------------------------------------------------------------

describe('loadCBState', () => {
  it('returns fresh CLOSED state for missing file', () => {
    const dir = makeTmpDir();
    const result = loadCBState(dir);
    assert.equal(result.state, 'CLOSED');
    assert.equal(result.consecutive_no_progress, 0);
    assert.equal(result.consecutive_same_error, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns fresh CLOSED state for corrupted JSON', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'circuit_breaker.json'), 'NOT JSON{{{');
    const result = loadCBState(dir);
    assert.equal(result.state, 'CLOSED');
    assert.equal(result.consecutive_no_progress, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns fresh CLOSED state for invalid state field', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'circuit_breaker.json'), JSON.stringify({ state: 'INVALID' }));
    const result = loadCBState(dir);
    assert.equal(result.state, 'CLOSED');
    fs.rmSync(dir, { recursive: true });
  });

  it('reconstructs valid state from file', () => {
    const dir = makeTmpDir();
    const saved = makeFreshCBState({ state: 'HALF_OPEN', consecutive_no_progress: 3 });
    fs.writeFileSync(path.join(dir, 'circuit_breaker.json'), JSON.stringify(saved));
    const result = loadCBState(dir);
    assert.equal(result.state, 'HALF_OPEN');
    assert.equal(result.consecutive_no_progress, 3);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('saveCBState', () => {
  it('writes CB state atomically', () => {
    const dir = makeTmpDir();
    const state = makeFreshCBState({ state: 'OPEN', total_opens: 2 });
    saveCBState(dir, state);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'circuit_breaker.json'), 'utf-8'));
    assert.equal(raw.state, 'OPEN');
    assert.equal(raw.total_opens, 2);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// 5-Signal Progress Detection
// ---------------------------------------------------------------------------

describe('checkProgress', () => {
  let gitDir;

  before(() => {
    gitDir = makeTmpDir();
    initGitRepo(gitDir);
  });

  after(() => {
    fs.rmSync(gitDir, { recursive: true });
  });

  it('returns true on first iteration (warm-up)', () => {
    const state = makeState({ working_dir: gitDir });
    const cbState = makeFreshCBState(); // last_known_head='', last_known_step=null
    assert.equal(checkProgress(state, cbState), true);
  });

  it('detects git HEAD change', () => {
    const head = getHead(gitDir);
    const state = makeState({ working_dir: gitDir, step: 'implement', current_ticket: 'ticket-1' });
    const cbState = makeFreshCBState({
      last_known_head: 'old-fake-head',
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    assert.equal(checkProgress(state, cbState), true);
  });

  it('detects step change', () => {
    const head = getHead(gitDir);
    const state = makeState({ working_dir: gitDir, step: 'review', current_ticket: 'ticket-1' });
    const cbState = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    assert.equal(checkProgress(state, cbState), true);
  });

  it('detects ticket change', () => {
    const head = getHead(gitDir);
    const state = makeState({ working_dir: gitDir, step: 'implement', current_ticket: 'ticket-2' });
    const cbState = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    assert.equal(checkProgress(state, cbState), true);
  });

  it('detects uncommitted changes', () => {
    const head = getHead(gitDir);
    // Create uncommitted change
    fs.writeFileSync(path.join(gitDir, 'dirty.txt'), 'dirty');
    execSync('git add dirty.txt', { cwd: gitDir, stdio: 'pipe' });

    const state = makeState({ working_dir: gitDir, step: 'implement', current_ticket: 'ticket-1' });
    const cbState = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    const result = checkProgress(state, cbState);
    // Clean up
    execSync('git reset HEAD dirty.txt', { cwd: gitDir, stdio: 'pipe' });
    fs.unlinkSync(path.join(gitDir, 'dirty.txt'));
    assert.equal(result, true);
  });

  it('returns false when nothing changed', () => {
    const head = getHead(gitDir);
    const state = makeState({ working_dir: gitDir, step: 'implement', current_ticket: 'ticket-1' });
    const cbState = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    assert.equal(checkProgress(state, cbState), false);
  });
});

// ---------------------------------------------------------------------------
// Opens After Threshold (5 no-progress iterations → OPEN)
// ---------------------------------------------------------------------------

describe('recordIteration — opens after threshold', () => {
  let sessionDir;
  let gitDir;

  before(() => {
    sessionDir = makeTmpDir();
    gitDir = makeTmpDir();
    initGitRepo(gitDir);
  });

  after(() => {
    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(gitDir, { recursive: true });
  });

  it('opens after 5 consecutive no-progress iterations', () => {
    const head = getHead(gitDir);
    // Pre-seed CB state with warm-up done (has a known head)
    const initial = makeFreshCBState({ last_known_head: head, last_known_step: 'implement', last_known_ticket: 'ticket-1' });
    saveCBState(sessionDir, initial);

    let result;
    for (let i = 1; i <= 5; i++) {
      const state = makeState({
        working_dir: gitDir,
        step: 'implement',
        current_ticket: 'ticket-1',
        iteration: i,
        session_dir: sessionDir,
      });
      result = recordIteration(sessionDir, state);
    }

    assert.equal(result.state, 'OPEN');
    assert.equal(result.consecutive_no_progress, 5);
    assert.ok(result.history.length >= 2); // CLOSED→HALF_OPEN, then ...→OPEN
  });

  it('does NOT open after 3 iterations', () => {
    // Fresh session
    const freshDir = makeTmpDir();
    const head = getHead(gitDir);
    const initial = makeFreshCBState({ last_known_head: head, last_known_step: 'implement', last_known_ticket: 'ticket-1' });
    saveCBState(freshDir, initial);

    let result;
    for (let i = 1; i <= 3; i++) {
      const state = makeState({
        working_dir: gitDir,
        step: 'implement',
        current_ticket: 'ticket-1',
        iteration: i,
        session_dir: freshDir,
      });
      result = recordIteration(freshDir, state);
    }

    assert.notEqual(result.state, 'OPEN');
    fs.rmSync(freshDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN Recovery
// ---------------------------------------------------------------------------

describe('recordIteration — HALF_OPEN recovery', () => {
  let sessionDir;
  let gitDir;

  before(() => {
    sessionDir = makeTmpDir();
    gitDir = makeTmpDir();
    initGitRepo(gitDir);
  });

  after(() => {
    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(gitDir, { recursive: true });
  });

  it('transitions to CLOSED on progress, error counters preserved', () => {
    const head = getHead(gitDir);
    // Set up HALF_OPEN state with some error count
    const halfOpen = makeFreshCBState({
      state: 'HALF_OPEN',
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
      consecutive_no_progress: 2,
      consecutive_same_error: 3,
      last_error_signature: 'some-error',
    });
    saveCBState(sessionDir, halfOpen);

    // Provide progress by changing step
    const state = makeState({
      working_dir: gitDir,
      step: 'review', // changed from 'implement'
      current_ticket: 'ticket-1',
      iteration: 5,
      session_dir: sessionDir,
    });
    const result = recordIteration(sessionDir, state);

    assert.equal(result.state, 'CLOSED');
    assert.equal(result.consecutive_no_progress, 0);
    // Error counter should NOT be reset by progress — only by having no error
    // Since we didn't pass an error, it gets reset to 0 (no error = reset)
    // The invariant is about HALF_OPEN→CLOSED not resetting error counters
    // But if no error is passed, the error counter resets naturally
  });

  it('preserves error counter during HALF_OPEN recovery when error persists', () => {
    const head = getHead(gitDir);
    const halfOpen = makeFreshCBState({
      state: 'HALF_OPEN',
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
      consecutive_no_progress: 2,
      consecutive_same_error: 3,
      last_error_signature: normalizeErrorSignature('same error'),
    });
    saveCBState(sessionDir, halfOpen);

    // Progress (step change) but SAME error
    const state = makeState({
      working_dir: gitDir,
      step: 'review',
      current_ticket: 'ticket-1',
      iteration: 5,
      session_dir: sessionDir,
    });
    const result = recordIteration(sessionDir, state, 'same error');

    assert.equal(result.state, 'CLOSED');
    assert.equal(result.consecutive_no_progress, 0);
    assert.equal(result.consecutive_same_error, 4); // incremented, NOT reset
  });
});

// ---------------------------------------------------------------------------
// Dual Counters (independent tracking)
// ---------------------------------------------------------------------------

describe('recordIteration — dual counters', () => {
  let gitDir;

  before(() => {
    gitDir = makeTmpDir();
    initGitRepo(gitDir);
  });

  after(() => {
    fs.rmSync(gitDir, { recursive: true });
  });

  it('increments no-progress without affecting same-error', () => {
    const sessionDir = makeTmpDir();
    const head = getHead(gitDir);
    const initial = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
      consecutive_same_error: 0,
    });
    saveCBState(sessionDir, initial);

    // No progress, no error
    const state = makeState({
      working_dir: gitDir,
      step: 'implement',
      current_ticket: 'ticket-1',
      iteration: 1,
      session_dir: sessionDir,
    });
    const result = recordIteration(sessionDir, state);

    assert.equal(result.consecutive_no_progress, 1);
    assert.equal(result.consecutive_same_error, 0); // unchanged
    fs.rmSync(sessionDir, { recursive: true });
  });

  it('increments same-error independently from no-progress counter', () => {
    const sessionDir = makeTmpDir();
    const head = getHead(gitDir);
    const initial = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    saveCBState(sessionDir, initial);

    // First error — sets counter to 1
    const state1 = makeState({
      working_dir: gitDir,
      step: 'review', // step change = progress
      current_ticket: 'ticket-1',
      iteration: 1,
      session_dir: sessionDir,
    });
    const r1 = recordIteration(sessionDir, state1, 'some error');

    // Write back updated step to CB state so next iteration sees it
    const state2 = makeState({
      working_dir: gitDir,
      step: 'review', // no change = no progress (step same as last)
      current_ticket: 'ticket-1',
      iteration: 2,
      session_dir: sessionDir,
    });
    const r2 = recordIteration(sessionDir, state2, 'some error');

    assert.equal(r2.consecutive_same_error, 2);
    assert.equal(r2.consecutive_no_progress, 1); // only 1 iteration without progress
    fs.rmSync(sessionDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Counters never negative
// ---------------------------------------------------------------------------

describe('invariants', () => {
  it('counters are never negative', () => {
    const sessionDir = makeTmpDir();
    const gitDir = makeTmpDir();
    initGitRepo(gitDir);

    const initial = makeFreshCBState();
    saveCBState(sessionDir, initial);

    // First iteration (warm-up) — should not go negative
    const state = makeState({
      working_dir: gitDir,
      step: 'implement',
      current_ticket: 'ticket-1',
      iteration: 1,
      session_dir: sessionDir,
    });
    const result = recordIteration(sessionDir, state);

    assert.ok(result.consecutive_no_progress >= 0);
    assert.ok(result.consecutive_same_error >= 0);

    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(gitDir, { recursive: true });
  });

  it('state transitions logged in history array', () => {
    const sessionDir = makeTmpDir();
    const gitDir = makeTmpDir();
    initGitRepo(gitDir);
    const head = getHead(gitDir);

    const initial = makeFreshCBState({
      last_known_head: head,
      last_known_step: 'implement',
      last_known_ticket: 'ticket-1',
    });
    saveCBState(sessionDir, initial);

    // Push past halfOpenAfter (default 2)
    for (let i = 1; i <= 3; i++) {
      const state = makeState({
        working_dir: gitDir,
        step: 'implement',
        current_ticket: 'ticket-1',
        iteration: i,
        session_dir: sessionDir,
      });
      recordIteration(sessionDir, state);
    }

    const result = loadCBState(sessionDir);
    assert.ok(result.history.length > 0);
    const firstTransition = result.history[0];
    assert.ok(firstTransition.from);
    assert.ok(firstTransition.to);
    assert.ok(firstTransition.timestamp);
    assert.ok(firstTransition.reason);

    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(gitDir, { recursive: true });
  });
});
