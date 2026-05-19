// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  _deps,
  probeJudgeBackendAvailability,
  measureLlmMetricWithBackoff,
  classifyJudgeError,
  JudgeMeasurementTimeout,
  JudgeMeasurementSpawnFailed,
} from '../../bin/microverse-runner.js';

function makeEnoentError() {
  const err = new Error('spawn claude ENOENT');
  err.code = 'ENOENT';
  return err;
}

function makeEtimedoutError() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return err;
}

function makeGenericError() {
  return new Error('something went wrong');
}

function makeSpawnMock(steps, seenOptions = []) {
  return (_cmd, _args, opts) => {
    seenOptions.push(opts);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      const step = steps.shift() ?? { type: 'success', stdout: '' };
      if (step.type === 'error') {
        child.emit('error', step.error);
        return;
      }
      if (step.stdout) child.stdout.write(step.stdout);
      if (step.stderr) child.stderr.write(step.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', step.code ?? 0, null);
    });
    return child;
  };
}

describe('classifyJudgeError', () => {
  test('ENOENT → cli_missing', () => {
    assert.deepEqual(classifyJudgeError(makeEnoentError()), { failureKind: 'cli_missing' });
  });

  test('ETIMEDOUT → timeout', () => {
    assert.deepEqual(classifyJudgeError(makeEtimedoutError()), { failureKind: 'timeout' });
  });

  test('generic error → unknown', () => {
    assert.deepEqual(classifyJudgeError(makeGenericError()), { failureKind: 'unknown' });
  });

  test('non-object → unknown', () => {
    assert.deepEqual(classifyJudgeError('a string error'), { failureKind: 'unknown' });
  });

  test('JudgeMeasurementTimeout → timeout with elapsed_ms', () => {
    const err = new JudgeMeasurementTimeout('judge timed out after 30s', 30000);
    const result = classifyJudgeError(err);
    assert.equal(result.failureKind, 'timeout');
    assert.equal(result.elapsed_ms, 30000);
  });

  test('JudgeMeasurementSpawnFailed ENOENT → cli_missing', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'ENOENT');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'cli_missing' });
  });

  test('JudgeMeasurementSpawnFailed other code → spawn_failed with cause_code', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'EACCES');
    const result = classifyJudgeError(err);
    assert.equal(result.failureKind, 'spawn_failed');
    assert.equal(result.cause_code, 'EACCES');
  });

  test('JudgeMeasurementTimeout instanceof check', () => {
    const err = new JudgeMeasurementTimeout('timed out', 5000);
    assert.ok(err instanceof JudgeMeasurementTimeout);
    assert.equal(err.kind, 'timeout');
    assert.equal(err.elapsed_ms, 5000);
  });

  test('JudgeMeasurementSpawnFailed instanceof check', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'ENOENT');
    assert.ok(err instanceof JudgeMeasurementSpawnFailed);
    assert.equal(err.kind, 'spawn_failed');
    assert.equal(err.cause_code, 'ENOENT');
  });
});

describe('probeJudgeBackendAvailability', () => {
  test('returns kind:ok on success', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    const seenOptions = [];
    _deps.spawn = makeSpawnMock([{ type: 'success', stdout: 'claude/2.1.0' }], seenOptions);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'ok');
      assert.deepEqual(seenOptions[0]?.stdio, ['ignore', 'pipe', 'pipe']);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('returns kind:missing on ENOENT', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'missing');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('returns kind:timeout on ETIMEDOUT', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEtimedoutError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'timeout');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('returns kind:failed on generic error', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeGenericError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'failed');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });
});

describe('measureLlmMetricWithBackoff — probe classification behavior', () => {
  test('ENOENT probe short-circuits to judge_cli_missing with attempts:0', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.equal(result.exitReason, 'judge_cli_missing');
      assert.equal(result.attempts, 0);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('ETIMEDOUT probe does NOT return judge_cli_missing — falls through to backoff loop', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    _deps.spawn = makeSpawnMock([
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
    ]);
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.notEqual(result.exitReason, 'judge_cli_missing',
        'ETIMEDOUT probe must NOT produce judge_cli_missing');
      assert.equal(result.exitReason, 'judge_timeout');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('backoff loop returns judge_timeout when all attempts time out', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    _deps.spawn = makeSpawnMock([
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
    ]);
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.exitReason, 'judge_timeout');
      assert.ok(result.attempts > 0, 'attempts should be > 0 (backoff ran)');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('codex session emits fallback telemetry when claude judge measurement succeeds', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = {
      spawn: _deps.spawn,
      logActivity: _deps.logActivity,
    };
    const events = [];
    const seenOptions = [];
    let measurementCalls = 0;
    _deps.spawn = makeSpawnMock([
      { type: 'success', stdout: 'claude/2.1.0' },
      { type: 'success', stdout: '8' },
    ], seenOptions);
    _deps.logActivity = (event) => {
      events.push({ ts: new Date().toISOString(), ...event });
    };
    try {
      const result = await measureLlmMetricWithBackoff(
        'fix bugs',
        30,
        '/tmp',
        undefined,
        undefined,
        undefined,
        undefined,
        'codex',
        [],
        { session: 'session-1', iteration: 3, spawnContext: 'iteration' },
      );
      assert.deepEqual(result.metric, { raw: '8', score: 8 });
      measurementCalls = seenOptions.length - 1;
      assert.equal(measurementCalls, 1);
      assert.deepEqual(seenOptions[0]?.stdio, ['ignore', 'pipe', 'pipe']);
      assert.deepEqual(seenOptions[1]?.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], {
        ts: events[0].ts,
        event: 'judge_measurement_attempted',
        source: 'pickle',
        session: 'session-1',
        iteration: 3,
        backend: 'codex',
        judge_backend: 'claude',
        model: 'claude-sonnet-4-6',
        fallback_activated: true,
        spawn_context: 'iteration',
        gate_payload: {
          attempt: 1,
          elapsed_ms: events[0].gate_payload.elapsed_ms,
          outcome: 'success',
          timeout_class: null,
          probe_kind: 'ok',
        },
      });
      assert.equal(Number.isInteger(events[0].gate_payload.elapsed_ms), true);
      assert.equal(events[0].gate_payload.elapsed_ms >= 0, true);
    } finally {
      _deps.spawn = orig.spawn;
      _deps.logActivity = orig.logActivity;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });
});
