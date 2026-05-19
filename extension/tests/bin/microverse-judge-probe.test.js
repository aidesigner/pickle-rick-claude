// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  _deps,
  probeJudgeCliAvailability,
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

// Returns an execFile mock that calls callback asynchronously (process.nextTick).
function makeExecFileMock(err, stdout = '') {
  return (_cmd, _args, _opts, callback) => {
    const proc = { stdin: { destroy: () => {} }, kill: () => {} };
    process.nextTick(() => callback(err, stdout, ''));
    return proc;
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

describe('probeJudgeCliAvailability', () => {
  test('returns kind:ok on success', async () => {
    const orig = _deps.execFile;
    _deps.execFile = makeExecFileMock(null, 'claude/2.1.0');
    try {
      const result = await probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'ok');
    } finally {
      _deps.execFile = orig;
    }
  });

  test('returns kind:missing on ENOENT', async () => {
    const orig = _deps.execFile;
    _deps.execFile = makeExecFileMock(makeEnoentError());
    try {
      const result = await probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'missing');
      assert.ok('message' in result);
    } finally {
      _deps.execFile = orig;
    }
  });

  test('returns kind:timeout on ETIMEDOUT', async () => {
    const orig = _deps.execFile;
    _deps.execFile = makeExecFileMock(makeEtimedoutError());
    try {
      const result = await probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'timeout');
      assert.ok('message' in result);
    } finally {
      _deps.execFile = orig;
    }
  });

  test('returns kind:failed on generic error', async () => {
    const orig = _deps.execFile;
    _deps.execFile = makeExecFileMock(makeGenericError());
    try {
      const result = await probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'failed');
      assert.ok('message' in result);
    } finally {
      _deps.execFile = orig;
    }
  });
});

describe('measureLlmMetricWithBackoff — probe classification behavior', () => {
  test('ENOENT probe short-circuits to judge_cli_missing with attempts:0', async () => {
    const orig = _deps.execFile;
    _deps.execFile = makeExecFileMock(makeEnoentError());
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.equal(result.exitReason, 'judge_cli_missing');
      assert.equal(result.attempts, 0);
    } finally {
      _deps.execFile = orig;
    }
  });

  test('ETIMEDOUT probe does NOT return judge_cli_missing — falls through to backoff loop', async () => {
    const orig = { execFile: _deps.execFile, sleep: _deps.sleep };
    _deps.execFile = makeExecFileMock(makeEtimedoutError());
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.notEqual(result.exitReason, 'judge_cli_missing',
        'ETIMEDOUT probe must NOT produce judge_cli_missing');
      assert.equal(result.exitReason, 'judge_timeout');
    } finally {
      _deps.execFile = orig.execFile;
      _deps.sleep = orig.sleep;
    }
  });

  test('backoff loop returns judge_timeout when all attempts time out', async () => {
    const orig = { execFile: _deps.execFile, sleep: _deps.sleep };
    _deps.execFile = makeExecFileMock(makeEtimedoutError());
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.exitReason, 'judge_timeout');
      assert.ok(result.attempts > 0, 'attempts should be > 0 (backoff ran)');
    } finally {
      _deps.execFile = orig.execFile;
      _deps.sleep = orig.sleep;
    }
  });

  test('codex session emits fallback telemetry when claude judge measurement succeeds', async () => {
    const orig = {
      execFile: _deps.execFile,
      logActivity: _deps.logActivity,
    };
    const events = [];
    let measurementCalls = 0;
    _deps.execFile = (_cmd, args, _opts, callback) => {
      const proc = { stdin: { destroy: () => {} }, kill: () => {} };
      process.nextTick(() => {
        if (Array.isArray(args) && args[0] === '--version') {
          callback(null, 'claude/2.1.0', '');
        } else {
          measurementCalls++;
          callback(null, '8', '');
        }
      });
      return proc;
    };
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
      assert.equal(measurementCalls, 1);
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
      _deps.execFile = orig.execFile;
      _deps.logActivity = orig.logActivity;
    }
  });
});
