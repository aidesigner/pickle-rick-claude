// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { measureLlmMetricWithBackoff, _deps } from '../bin/microverse-runner.js';

function makeRunnerState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'worker fallback fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    backend: 'claude',
  };
}

function withTempExtensionSettings(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ext-settings-'));
  const prev = {
    EXTENSION_DIR: process.env.EXTENSION_DIR,
    EXTENSION_DIR_TEST: process.env.EXTENSION_DIR_TEST,
    NODE_ENV: process.env.NODE_ENV,
  };
  fs.writeFileSync(path.join(dir, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
  process.env.EXTENSION_DIR = dir;
  process.env.EXTENSION_DIR_TEST = '1';
  process.env.NODE_ENV = 'test';
  const cleanup = () => {
    if (prev.EXTENSION_DIR === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = prev.EXTENSION_DIR;
    if (prev.EXTENSION_DIR_TEST === undefined) delete process.env.EXTENSION_DIR_TEST;
    else process.env.EXTENSION_DIR_TEST = prev.EXTENSION_DIR_TEST;
    if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function makeEtimedoutError() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return err;
}

test('measureLlmMetricWithBackoff persists worker fallback after first typed failure', async () => {
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-fallback-'));
  const statePath = path.join(root, 'state.json');
  const runnerState = makeRunnerState(root, root);
  fs.writeFileSync(statePath, JSON.stringify(runnerState, null, 2));

  const orig = {
    execFileSync: _deps.execFileSync,
    logActivity: _deps.logActivity,
    sleep: _deps.sleep,
  };
  const events = [];
  const measurementCmds = [];
  let attemptCount = 0;
  _deps.execFileSync = (cmd, args) => {
    if (Array.isArray(args) && args[0] === '--version') return 'claude/2.1.0';
    measurementCmds.push({ cmd, args });
    attemptCount += 1;
    if (attemptCount === 1) throw makeEtimedoutError();
    return '9';
  };
  _deps.logActivity = (event) => events.push(event);
  _deps.sleep = async () => {};

  try {
    const result = await withTempExtensionSettings(
      { microverse: { judge_backend: 'auto', judge_backend_fallback: 'codex' } },
      () => measureLlmMetricWithBackoff(
        'fix bugs',
        30,
        root,
        undefined,
        [],
        undefined,
        undefined,
        'claude',
        [],
        {
          session: 'session-1',
          iteration: 1,
          spawnContext: 'iteration',
          statePath,
          runnerState,
        },
      ),
    );

    assert.deepEqual(result.metric, { raw: '9', score: 9 });
    assert.equal(measurementCmds.length, 2);
    assert.equal(measurementCmds[0].cmd, 'claude');
    assert.equal(measurementCmds[1].cmd, 'claude', 'judge binary must remain claude after worker fallback');
    assert.equal(runnerState.judge_backend_resolved, 'codex');
    assert.equal(runnerState.worker_backend, 'codex');

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(persisted.judge_backend_resolved, 'codex');
    assert.equal(persisted.worker_backend, 'codex');

    const judgeEvents = events.filter((event) => event.event === 'judge_measurement_attempted');
    assert.equal(judgeEvents.length, 2);
    assert.equal(judgeEvents[0].backend, 'claude');
    assert.equal(judgeEvents[0].fallback_activated, false);
    assert.equal(judgeEvents[1].backend, 'codex');
    assert.equal(judgeEvents[1].fallback_activated, true);
    assert.equal(judgeEvents[0].judge_backend, 'claude');
    assert.equal(judgeEvents[1].judge_backend, 'claude');
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = orig.execFileSync;
    _deps.logActivity = orig.logActivity;
    _deps.sleep = orig.sleep;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
