// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _deps,
  measureLlmMetricWithBackoff,
} from '../bin/microverse-runner.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../src/types/activity-events.schema.json'), 'utf8'),
);

function makeEtimedoutError() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return err;
}

test('baseline_attempt_timeout emits per attempt', async () => {
  const origExecFileSync = _deps.execFileSync;
  const origSleep = _deps.sleep;
  const origLogActivity = _deps.logActivity;
  const events = [];

  _deps.execFileSync = () => {
    throw makeEtimedoutError();
  };
  _deps.sleep = async () => {};
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
      'claude',
      [],
      { session: 'session-1', iteration: 7 },
    );

    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_timeout');
    assert.equal(result.attempts, 4);

    assert.equal(events.length, 4, 'ETIMEDOUT attempts should emit four timeout events');
    events.forEach((event, index) => {
      assert.equal(event.event, 'baseline_attempt_timeout');
      assert.equal(typeof event.ts, 'string');
      assert.equal(event.session, 'session-1');
      assert.equal(event.iteration, 7);
      assert.deepEqual(event.gate_payload.classifier, 'timeout');
      assert.equal(event.gate_payload.attempt, index + 1);
      assert.equal(Number.isInteger(event.gate_payload.elapsed_ms), true);
      assert.equal(event.gate_payload.elapsed_ms >= 0, true);
    });

    const definitionKeys = Object.keys(schema.definitions);
    assert.equal(definitionKeys.includes('baseline_attempt_timeout'), true);

    const oneOfRefs = schema.oneOf.map((entry) => entry.$ref);
    assert.equal(oneOfRefs.includes('#/definitions/baseline_attempt_timeout'), true);
  } finally {
    _deps.execFileSync = origExecFileSync;
    _deps.sleep = origSleep;
    _deps.logActivity = origLogActivity;
  }
});

test('VALID_ACTIVITY_EVENTS includes baseline_attempt_timeout', () => {
  assert.equal(
    VALID_ACTIVITY_EVENTS.includes('baseline_attempt_timeout'),
    true,
    'baseline_attempt_timeout must be registered in VALID_ACTIVITY_EVENTS',
  );
});
