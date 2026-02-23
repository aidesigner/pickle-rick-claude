import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');
const RESOLVE_STATE = path.resolve(__dirname, '../hooks/resolve-state.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid base state, with optional overrides. */
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
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

/**
 * Run stop-hook.js as a subprocess.
 *
 * Options:
 *   state           – state object written to state.json
 *   response        – value for prompt_response in the hook input JSON
 *   role            – value for PICKLE_ROLE env var (omitted if undefined)
 *   setStateFileEnv – if true (default), sets PICKLE_STATE_FILE; if false,
 *                     the hook resolves state via current_sessions.json instead
 *
 * Returns { decision, state } where state is the (possibly updated)
 * state.json read back after the hook exits.
 */
function runHook(opts = {}) {
  const { state = baseState(), response = '', role = undefined, setStateFileEnv = true } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  // Always write a sessions map so tests that set setStateFileEnv=false still work.
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_ROLE;
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;
  if (role !== undefined) env.PICKLE_ROLE = role;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ prompt_response: response }),
      encoding: 'utf-8',
      env,
    });
    return {
      decision: JSON.parse(stdout.trim()),
      state: JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Bypass conditions — always approve, no state mutation
// ---------------------------------------------------------------------------

test('stop-hook: no state file found → approve', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  try {
    const env = {
      ...process.env,
      EXTENSION_DIR: tmpDir,
      FORCE_COLOR: '0',
      PICKLE_STATE_FILE: path.join(tmpDir, 'nonexistent.json'),
    };
    delete env.PICKLE_ROLE;
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ prompt_response: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: working_dir mismatch → approve, state unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ working_dir: '/tmp/some-other-project' }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true);
});

test('stop-hook: session inactive → approve', () => {
  const { decision, state } = runHook({ state: baseState({ active: false }) });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: tmux_mode, no PICKLE_STATE_FILE (main window) → approve, state unchanged', () => {
  // Main Claude window: resolves state via sessions map, not PICKLE_STATE_FILE
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: false,
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'main window must not deactivate the session');
});

test('stop-hook: tmux_mode, PICKLE_STATE_FILE set (subprocess) → does not early-exit', () => {
  // Subprocess: has PICKLE_STATE_FILE, should fall through to normal block logic
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '', // no token → default block
  });
  assert.equal(decision.decision, 'block', 'tmux subprocess must not bypass the hook');
});

// ---------------------------------------------------------------------------
// Exit conditions — approve and deactivate session
// ---------------------------------------------------------------------------

test('stop-hook: EPIC_COMPLETED → approve + active=false', () => {
  const { decision, state } = runHook({
    response: 'Work done. <promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: TASK_COMPLETED → approve + active=false', () => {
  const { decision, state } = runHook({
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: custom completion_promise match → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'All done. <promise>MY_CUSTOM_DONE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: completion_promise set but wrong token in response → block', () => {
  const { decision } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'Not done yet.',
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: worker + I AM DONE → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>I AM DONE</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

test('stop-hook: worker + EPIC_COMPLETED → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>EPIC_COMPLETED</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

// ---------------------------------------------------------------------------
// Checkpoint conditions (non-tmux) — block with phase-specific feedback
// ---------------------------------------------------------------------------

test('stop-hook: PRD_COMPLETE (non-tmux) → block, feedback mentions breakdown', () => {
  const { decision } = runHook({ response: '<promise>PRD_COMPLETE</promise>' });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.systemMessage.includes('breakdown'), decision.systemMessage);
});

test('stop-hook: TICKET_SELECTED (non-tmux) → block, feedback mentions research', () => {
  const { decision } = runHook({ response: '<promise>TICKET_SELECTED</promise>' });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.systemMessage.includes('research'), decision.systemMessage);
});

// ---------------------------------------------------------------------------
// Checkpoint conditions (tmux subprocess) — approve, no state change
// ---------------------------------------------------------------------------

test('stop-hook: TICKET_SELECTED + tmux_mode + PICKLE_STATE_FILE → approve, no deactivate', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>TICKET_SELECTED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'checkpoint in tmux mode must not deactivate');
});

test('stop-hook: PRD_COMPLETE + tmux_mode + PICKLE_STATE_FILE → approve', () => {
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>PRD_COMPLETE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Worker suppression — workers ignore manager checkpoint tokens
// ---------------------------------------------------------------------------

test('stop-hook: worker + PRD_COMPLETE → not treated as checkpoint, falls to default block', () => {
  // isWorker=true makes isPrdDone=false, so the checkpoint block is not entered
  const { decision } = runHook({
    state: baseState({ active: true }),
    response: '<promise>PRD_COMPLETE</promise>',
    role: 'worker',
  });
  assert.equal(decision.decision, 'block');
  assert.ok(!decision.systemMessage.includes('breakdown'), 'should not include phase feedback');
});

test('stop-hook: state.worker=true (no PICKLE_ROLE) → NOT treated as worker, falls to default block', () => {
  // state.worker is a dead field — only PICKLE_ROLE=worker determines worker mode
  const { decision } = runHook({
    state: baseState({ worker: true }),
    response: '<promise>I AM DONE</promise>',
  });
  assert.equal(decision.decision, 'block', 'state.worker alone must not activate worker mode');
});

// ---------------------------------------------------------------------------
// Iteration and time limits
// ---------------------------------------------------------------------------

test('stop-hook: iteration >= max_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 5, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: iteration > max_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 7, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: max_iterations=0 (unlimited) → never fires limit, falls to default block', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 999, max_iterations: 0 }),
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: time limit reached → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700, // 61 minutes ago
      max_time_minutes: 60,
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: max_time_minutes=0 (unlimited) → never fires limit, falls to default block', () => {
  const { decision } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 99999,
      max_time_minutes: 0,
    }),
  });
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// Default block — active session, no tokens, no limits hit
// ---------------------------------------------------------------------------

test('stop-hook: active session, no tokens → block with iteration number', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 3, max_iterations: 10 }),
  });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.systemMessage.includes('3'), decision.systemMessage);
  assert.ok(decision.systemMessage.includes('10'), decision.systemMessage);
});

test('stop-hook: max_iterations=0 → block message has no "of N"', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 0 }),
  });
  assert.equal(decision.decision, 'block');
  assert.ok(!decision.systemMessage.includes('of 0'), decision.systemMessage);
});

test('stop-hook: promise token with surrounding text is still detected', () => {
  const { decision, state } = runHook({
    response: 'Done with everything!\n<promise>EPIC_COMPLETED</promise>\nGoodbye.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: token with extra whitespace inside tags IS matched (tolerant)', () => {
  // Whitespace-tolerant regex — spaces inside tags still trigger the match
  const { decision, state } = runHook({
    response: '<promise> EPIC_COMPLETED </promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

// ---------------------------------------------------------------------------
// resolve-state.ts exports
// ---------------------------------------------------------------------------

const { getExtensionDir, resolveStateFile, loadActiveState } = await import(RESOLVE_STATE);

test('resolve-state: getExtensionDir uses EXTENSION_DIR env if set', () => {
  const saved = process.env.EXTENSION_DIR;
  try {
    process.env.EXTENSION_DIR = '/custom/path';
    assert.equal(getExtensionDir(), '/custom/path');
  } finally {
    if (saved === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = saved;
  }
});

test('resolve-state: getExtensionDir defaults to ~/.claude/pickle-rick', () => {
  const saved = process.env.EXTENSION_DIR;
  try {
    delete process.env.EXTENSION_DIR;
    assert.equal(getExtensionDir(), path.join(os.homedir(), '.claude/pickle-rick'));
  } finally {
    if (saved !== undefined) process.env.EXTENSION_DIR = saved;
  }
});

test('resolve-state: resolveStateFile returns path when PICKLE_STATE_FILE set and file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = stateFile;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when PICKLE_STATE_FILE file is missing', () => {
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = '/tmp/does-not-exist-ever.json';
    assert.equal(resolveStateFile('/tmp'), null);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
  }
});

test('resolve-state: resolveStateFile resolves via sessions map when no PICKLE_STATE_FILE', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when cwd not in sessions map', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ '/some/other/dir': '/some/session' })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), null);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns state for active session with matching cwd', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const state = { active: true, working_dir: process.cwd(), step: 'prd' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  try {
    const loaded = loadActiveState(stateFile);
    assert.equal(loaded.active, true);
    assert.equal(loaded.step, 'prd');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for inactive session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: false, working_dir: process.cwd() }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for cwd mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: true, working_dir: '/some/other/dir' }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Disabled marker — /disable-pickle creates this file to suppress the hook
// ---------------------------------------------------------------------------

test('stop-hook: disabled marker file → approve immediately, state unchanged', () => {
  const state = baseState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  // Create the disabled marker file
  fs.writeFileSync(path.join(tmpDir, 'disabled'), '');

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ prompt_response: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
    // State should NOT be modified (no deactivation)
    const afterState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(afterState.active, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: no disabled marker → hook processes normally (blocks active session)', () => {
  // Sanity check: without the marker, an active session with no tokens should block
  const { decision } = runHook({ state: baseState(), response: 'just some text' });
  assert.equal(decision.decision, 'block');
});
