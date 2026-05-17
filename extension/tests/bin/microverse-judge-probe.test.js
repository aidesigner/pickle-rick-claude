// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  _deps,
  probeJudgeCliAvailability,
  measureLlmMetricWithBackoff,
  classifyJudgeError,
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

describe('classifyJudgeError', () => {
  test('ENOENT → missing', () => {
    assert.equal(classifyJudgeError(makeEnoentError()), 'missing');
  });

  test('ETIMEDOUT → timeout', () => {
    assert.equal(classifyJudgeError(makeEtimedoutError()), 'timeout');
  });

  test('generic error → failed', () => {
    assert.equal(classifyJudgeError(makeGenericError()), 'failed');
  });

  test('non-object → failed', () => {
    assert.equal(classifyJudgeError('a string error'), 'failed');
  });
});

describe('probeJudgeCliAvailability', () => {
  test('returns kind:ok on success', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => 'claude/2.1.0';
    try {
      const result = probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'ok');
    } finally {
      _deps.execFileSync = orig;
    }
  });

  test('returns kind:missing on ENOENT', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw makeEnoentError(); };
    try {
      const result = probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'missing');
      assert.ok('message' in result);
    } finally {
      _deps.execFileSync = orig;
    }
  });

  test('returns kind:timeout on ETIMEDOUT', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw makeEtimedoutError(); };
    try {
      const result = probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'timeout');
      assert.ok('message' in result);
    } finally {
      _deps.execFileSync = orig;
    }
  });

  test('returns kind:failed on generic error', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw makeGenericError(); };
    try {
      const result = probeJudgeCliAvailability('/tmp');
      assert.equal(result.kind, 'failed');
      assert.ok('message' in result);
    } finally {
      _deps.execFileSync = orig;
    }
  });
});

describe('measureLlmMetricWithBackoff — probe classification behavior', () => {
  test('ENOENT probe short-circuits to judge_cli_missing with attempts:0', async () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw makeEnoentError(); };
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.equal(result.exitReason, 'judge_cli_missing');
      assert.equal(result.attempts, 0);
    } finally {
      _deps.execFileSync = orig;
    }
  });

  test('ETIMEDOUT probe does NOT return judge_cli_missing — falls through to backoff loop', async () => {
    const orig = _deps.execFileSync;
    const origSleep = _deps.sleep;
    // probe: ETIMEDOUT; all 4 measurement attempts: also ETIMEDOUT
    _deps.execFileSync = () => { throw makeEtimedoutError(); };
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.notEqual(result.exitReason, 'judge_cli_missing',
        'ETIMEDOUT probe must NOT produce judge_cli_missing');
      assert.equal(result.exitReason, 'judge_timeout');
    } finally {
      _deps.execFileSync = orig;
      _deps.sleep = origSleep;
    }
  });

  test('backoff loop returns judge_timeout when all attempts time out', async () => {
    const orig = _deps.execFileSync;
    const origSleep = _deps.sleep;
    let callCount = 0;
    _deps.execFileSync = () => {
      callCount++;
      // first call = probe (ETIMEDOUT), rest = measurement attempts (also ETIMEDOUT)
      throw makeEtimedoutError();
    };
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.exitReason, 'judge_timeout');
      assert.ok(result.attempts > 0, 'attempts should be > 0 (backoff ran)');
    } finally {
      _deps.execFileSync = orig;
      _deps.sleep = origSleep;
    }
  });

  test('codex session emits fallback telemetry when claude judge measurement succeeds', async () => {
    const orig = {
      execFileSync: _deps.execFileSync,
      logActivity: _deps.logActivity,
    };
    const events = [];
    let measurementCalls = 0;
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'claude/2.1.0';
      measurementCalls++;
      return '8';
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
      _deps.execFileSync = orig.execFileSync;
      _deps.logActivity = orig.logActivity;
    }
  });
});
