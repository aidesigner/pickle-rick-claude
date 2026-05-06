// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateManagerIdleBackoff } from '../hooks/handlers/stop-hook.js';
import { resolveManagerIdleBackoffFallbackMs } from '../bin/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');

function baseState(sessionDir, overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'research',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'idle backoff test',
    current_ticket: 'T1',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    activity: [],
    ...overrides,
  };
}

function makeFixture(options = {}) {
  const {
    settings = { manager_idle_backoff_fallback_ms: 60_000 },
    stateOverrides = {},
    workerPid = process.pid,
  } = options;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-backoff-'));
  fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'log-watcher.js'), '');
  fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify(settings, null, 2));

  const sessionDir = path.join(tmpDir, 'session');
  const ticketDir = path.join(sessionDir, 'T1');
  fs.mkdirSync(ticketDir, { recursive: true });
  if (workerPid !== null) {
    fs.writeFileSync(path.join(ticketDir, `worker_session_${workerPid}.log`), 'worker alive\n');
  }

  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState(sessionDir, stateOverrides), null, 2));
  return { tmpDir, sessionDir, ticketDir, stateFile };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

function readState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
}

function runHook(fixture, response) {
  const env = {
    ...process.env,
    EXTENSION_DIR: fixture.tmpDir,
    PICKLE_STATE_FILE: fixture.stateFile,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_ROLE;
  const stdout = execFileSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ last_assistant_message: response }),
    encoding: 'utf8',
    env,
  });
  return {
    decision: JSON.parse(stdout.trim()),
    state: readState(fixture),
  };
}

function withExtensionDir(tmpDir, fn) {
  const previous = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = tmpDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = previous;
  }
}

function engageIdleBackoff(fixture, response = 'Waiting for Monitor signal.') {
  const first = runHook(fixture, response);
  const second = runHook(fixture, response);
  const third = runHook(fixture, response);
  return { first, second, third };
}

test('enters idle-backoff after 3 wait turns', () => {
  const fixture = makeFixture();
  try {
    const { first, second, third } = engageIdleBackoff(fixture);
    assert.equal(first.decision.decision, 'block');
    assert.equal(second.decision.decision, 'block');
    assert.equal(third.decision.decision, 'block');
    assert.match(third.decision.reason, /Idle backoff engaged/);
    const engaged = third.state.activity.at(-1);
    assert.equal(engaged.event, 'manager_idle_backoff_engaged');
    assert.equal(engaged.consecutive_wait_turns, 3);
    assert.equal(engaged.ticket, 'T1');
  } finally {
    cleanupFixture(fixture);
  }
});

test('releases on state.json mtime change', () => {
  const fixture = makeFixture();
  try {
    engageIdleBackoff(fixture);
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(fixture.stateFile, future, future);
    const released = runHook(fixture, 'Waiting for Monitor signal.');
    assert.equal(released.decision.decision, 'approve');
    const event = released.state.activity.at(-1);
    assert.equal(event.event, 'manager_idle_backoff_released');
    assert.equal(event.release_reason, 'state_mtime');
  } finally {
    cleanupFixture(fixture);
  }
});

test('releases on artifact landing', () => {
  const fixture = makeFixture();
  try {
    engageIdleBackoff(fixture);
    fs.writeFileSync(path.join(fixture.ticketDir, 'conformance_2026-05-06.md'), '# landed\n');
    const released = runHook(fixture, 'Waiting for Monitor signal.');
    assert.equal(released.decision.decision, 'approve');
    const event = released.state.activity.at(-1);
    assert.equal(event.event, 'manager_idle_backoff_released');
    assert.equal(event.release_reason, 'artifact_landed');
  } finally {
    cleanupFixture(fixture);
  }
});

test('releases on worker PID exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const fixture = makeFixture({ workerPid: child.pid });
  try {
    engageIdleBackoff(fixture);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    const released = runHook(fixture, 'Waiting for Monitor signal.');
    assert.equal(released.decision.decision, 'approve');
    const event = released.state.activity.at(-1);
    assert.equal(event.event, 'manager_idle_backoff_released');
    assert.equal(event.release_reason, 'worker_exit');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    cleanupFixture(fixture);
  }
});

test('releases on fallback timer', () => {
  const fixture = makeFixture();
  try {
    withExtensionDir(fixture.tmpDir, () => {
      const state = readState(fixture);
      assert.equal(evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 0)?.decision, 'block');
      assert.equal(evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 2_000)?.decision, 'block');
      assert.equal(evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 4_000)?.decision, 'block');
      const released = evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 64_000);
      assert.equal(released?.decision, 'approve');
      assert.equal(released?.stateActivityEntries?.[0]?.release_reason, 'fallback_timer');
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test('emits engaged and released events', () => {
  const fixture = makeFixture();
  try {
    engageIdleBackoff(fixture);
    fs.writeFileSync(path.join(fixture.ticketDir, 'conformance_2026-05-06.md'), '# landed\n');
    const released = runHook(fixture, 'Waiting for Monitor signal.');
    const events = released.state.activity.filter((entry) =>
      entry.event === 'manager_idle_backoff_engaged' || entry.event === 'manager_idle_backoff_released');
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((entry) => entry.event),
      ['manager_idle_backoff_engaged', 'manager_idle_backoff_released'],
    );
    assert.equal(events[0].last_worker_pid, process.pid);
    assert.equal(events[1].release_reason, 'artifact_landed');
    assert.equal(typeof events[1].duration_ms, 'number');
  } finally {
    cleanupFixture(fixture);
  }
});

test('settings round-trip via setup.ts', () => {
  assert.equal(resolveManagerIdleBackoffFallbackMs(45_000), 45_000);
  assert.equal(resolveManagerIdleBackoffFallbackMs(999), 60_000);
  assert.equal(resolveManagerIdleBackoffFallbackMs(700_000), 60_000);

  const fixture = makeFixture({ settings: { manager_idle_backoff_fallback_ms: 12_345 } });
  try {
    withExtensionDir(fixture.tmpDir, () => {
      const state = readState(fixture);
      evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 0);
      evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 2_000);
      evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 4_000);
      const released = evaluateManagerIdleBackoff(state, fixture.stateFile, 'Waiting for Monitor signal.', '', () => {}, 16_500);
      assert.equal(released?.decision, 'approve');
      assert.equal(released?.stateActivityEntries?.[0]?.release_reason, 'fallback_timer');
    });
  } finally {
    cleanupFixture(fixture);
  }
});
