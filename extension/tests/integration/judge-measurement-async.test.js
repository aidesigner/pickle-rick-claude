// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  measureLlmMetricWithBackoff,
  _deps,
} from '../../bin/microverse-runner.js';
import { resolveJudgeBackend } from '../../services/pickle-utils.js';
import { buildJudgeEnv } from '../../services/judge-spawn-env.js';

// ---------------------------------------------------------------------------
// Fake spawn helpers for the async path (PICKLE_JUDGE_LEGACY_SPAWN must be unset)
// ---------------------------------------------------------------------------

function makeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  return child;
}

function closeOk(data) {
  return () => {
    const child = makeChildProcess();
    setImmediate(() => {
      if (data !== undefined) child.stdout.emit('data', data);
      child.emit('close', 0);
    });
    return child;
  };
}

function closeEnoent() {
  return () => {
    const child = makeChildProcess();
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    setImmediate(() => child.emit('error', err));
    return child;
  };
}

function hang() {
  return () => makeChildProcess();
}

function spawnSequence(factories) {
  let i = 0;
  return (_cmd, _args, _opts) => {
    const factory = i < factories.length ? factories[i++] : hang();
    return factory(_cmd, _args, _opts);
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
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function makeRunnerState(overrides = {}) {
  return {
    active: true,
    working_dir: os.tmpdir(),
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'judge async integration fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: os.tmpdir(),
    backend: 'claude',
    schema_version: 3,
    min_iterations: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('async path: probe ok + measurement ok → score returned (R-SJET-1)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  _deps.spawn = spawnSequence([closeOk(), closeOk('{"score":85}\n')]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await measureLlmMetricWithBackoff('test goal', 1, os.tmpdir());
    assert.ok(result.metric, 'metric must be non-null on happy path');
    assert.equal(result.metric.score, 85);
    assert.equal(result.attempts, 1);
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});

test('async path: hang × 4 → SIGTERM → JudgeMeasurementTimeout → judge_timeout (R-SJET-1)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  _deps.spawn = spawnSequence([closeOk(), hang(), hang(), hang(), hang()]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await measureLlmMetricWithBackoff('test goal', 1, os.tmpdir());
    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_timeout');
    assert.equal(result.attempts, 4);
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});

test('async path: probe ok, measurement ENOENT → judge_cli_missing, attempts=1 (R-SJET-1)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  _deps.spawn = spawnSequence([closeOk(), closeEnoent()]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await measureLlmMetricWithBackoff('test goal', 1, os.tmpdir());
    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_cli_missing');
    assert.equal(result.attempts, 1);
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});

test('async path: primary timeout → fallback engaged → worker_backend set to codex (R-SJET-4)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  const runnerState = makeRunnerState();
  _deps.spawn = spawnSequence([closeOk(), hang(), closeOk('{"score":85}\n')]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await withTempExtensionSettings(
      { microverse: { judge_backend: 'auto', judge_backend_fallback: 'codex' } },
      () => measureLlmMetricWithBackoff(
        'test goal', 1, os.tmpdir(),
        undefined, [], undefined, undefined,
        'claude', [],
        { session: 'sjet-6-test', iteration: 1, spawnContext: 'iteration', runnerState },
      ),
    );
    assert.ok(result.metric, 'metric must be returned after fallback succeeds');
    assert.equal(result.metric.score, 85);
    assert.equal(runnerState.worker_backend, 'codex', 'worker_backend must be set to fallback');
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});

test('async path: all 4 attempts fail after fallback → all_judge_backends_exhausted (R-SJET-4)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  const runnerState = makeRunnerState();
  _deps.spawn = spawnSequence([closeOk(), hang(), hang(), hang(), hang()]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await withTempExtensionSettings(
      { microverse: { judge_backend: 'auto', judge_backend_fallback: 'codex' } },
      () => measureLlmMetricWithBackoff(
        'test goal', 1, os.tmpdir(),
        undefined, [], undefined, undefined,
        'claude', [],
        { session: 'sjet-6-test', iteration: 1, spawnContext: 'iteration', runnerState },
      ),
    );
    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'all_judge_backends_exhausted');
    assert.equal(result.attempts, 4);
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});

test('--resume sticky: judge_backend_resolved=codex → resolveJudgeBackend returns codex (R-SJET-4)', () => {
  const state = makeRunnerState({ judge_backend_resolved: 'codex' });
  const settings = { microverse: { judge_backend: 'auto', judge_backend_fallback: 'codex' } };
  const typedFailure = { failureKind: 'timeout' };
  const backend = resolveJudgeBackend(state, settings, 1, typedFailure);
  assert.equal(backend, 'codex', 'resolveJudgeBackend must return judge_backend_resolved when set');
});

test('nested-claude env: buildJudgeEnv strips CLAUDE_CODE when isNested=true (R-SJET-3)', () => {
  const baseEnv = {
    CLAUDE_CODE: '1',
    ANTHROPIC_API_KEY: 'test-key',
    PATH: '/usr/bin:/bin',
    HOME: '/root',
  };
  const result = buildJudgeEnv('claude', true, baseEnv);
  assert.ok(!('CLAUDE_CODE' in result), 'CLAUDE_CODE must be stripped when nested');
  assert.ok('PATH' in result, 'PATH must be preserved');
  assert.ok('ANTHROPIC_API_KEY' in result, 'ANTHROPIC_API_KEY must be preserved');
  assert.ok('XDG_RUNTIME_DIR' in result, 'XDG_RUNTIME_DIR must be replaced with isolated tmpdir');
});

test('async path: probe ENOENT → judge_cli_missing terminal, attempts=0 (R-SJET-1)', async () => {
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const orig = { spawn: _deps.spawn, sleep: _deps.sleep, logActivity: _deps.logActivity };
  _deps.spawn = spawnSequence([closeEnoent()]);
  _deps.sleep = async () => {};
  _deps.logActivity = () => {};
  try {
    const result = await measureLlmMetricWithBackoff('test goal', 1, os.tmpdir());
    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_cli_missing');
    assert.equal(result.attempts, 0, 'probe ENOENT must short-circuit with 0 measurement attempts');
  } finally {
    _deps.spawn = orig.spawn;
    _deps.sleep = orig.sleep;
    _deps.logActivity = orig.logActivity;
  }
});
