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
import { ACTIVITY_EVENT_SCHEMA_SECTION } from '../bin/spawn-refinement-team.js';
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

test('judge_measurement_attempted and baseline_attempt_timeout emit per attempt', async () => {
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
      { session: 'session-1', iteration: 7, spawnContext: 'baseline' },
    );

    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_timeout');
    assert.equal(result.attempts, 4);

    const attemptedEvents = events.filter((event) => event.event === 'judge_measurement_attempted');
    const timeoutEvents = events.filter((event) => event.event === 'baseline_attempt_timeout');

    assert.equal(attemptedEvents.length, 4, 'ETIMEDOUT attempts should emit four measurement-attempt events');
    attemptedEvents.forEach((event, index) => {
      assert.equal(typeof event.ts, 'string');
      assert.equal(event.session, 'session-1');
      assert.equal(event.iteration, 7);
      assert.equal(event.backend, 'claude');
      assert.equal(event.judge_backend, 'claude');
      assert.equal(event.model, 'claude-sonnet-4-6');
      assert.equal(event.fallback_activated, true);
      assert.equal(event.spawn_context, 'baseline');
      assert.equal(event.gate_payload.attempt, index + 1);
      assert.equal(Number.isInteger(event.gate_payload.elapsed_ms), true);
      assert.equal(event.gate_payload.elapsed_ms >= 0, true);
      assert.equal(event.gate_payload.outcome, 'timeout');
      assert.equal(event.gate_payload.timeout_class, 'probe_timeout');
      assert.equal(event.gate_payload.probe_kind, 'timeout');
    });

    assert.equal(timeoutEvents.length, 4, 'ETIMEDOUT attempts should emit four timeout events');
    timeoutEvents.forEach((event, index) => {
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
    assert.equal(definitionKeys.includes('judge_measurement_attempted'), true);

    const oneOfRefs = schema.oneOf.map((entry) => entry.$ref);
    assert.equal(oneOfRefs.includes('#/definitions/baseline_attempt_timeout'), true);
    assert.equal(oneOfRefs.includes('#/definitions/judge_measurement_attempted'), true);
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

test('VALID_ACTIVITY_EVENTS includes judge_measurement_attempted', () => {
  assert.equal(
    VALID_ACTIVITY_EVENTS.includes('judge_measurement_attempted'),
    true,
    'judge_measurement_attempted must be registered in VALID_ACTIVITY_EVENTS',
  );
});

test('spawn-refinement-team documents baseline_attempt_timeout schema fields', () => {
  const rowMatch = ACTIVITY_EVENT_SCHEMA_SECTION.match(
    /\|\s*`baseline_attempt_timeout`\s*\|\s*([^|]+)\|/,
  );
  assert.ok(
    rowMatch,
    'ACTIVITY_EVENT_SCHEMA_SECTION must include baseline_attempt_timeout',
  );
  const row = rowMatch[1];
  for (const field of ['session', 'gate_payload.attempt', 'gate_payload.elapsed_ms', 'gate_payload.classifier']) {
    assert.match(
      row,
      new RegExp(String.raw`\`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``),
      `baseline_attempt_timeout row missing required field ${field}`,
    );
  }
});

test('spawn-refinement-team documents judge_measurement_attempted schema fields', () => {
  const rowMatch = ACTIVITY_EVENT_SCHEMA_SECTION.match(
    /\|\s*`judge_measurement_attempted`\s*\|\s*([^|]+)\|/,
  );
  assert.ok(
    rowMatch,
    'ACTIVITY_EVENT_SCHEMA_SECTION must include judge_measurement_attempted',
  );
  const row = rowMatch[1];
  for (const field of [
    'session',
    'iteration',
    'backend',
    'judge_backend',
    'model',
    'fallback_activated',
    'spawn_context',
    'gate_payload.attempt',
    'gate_payload.elapsed_ms',
    'gate_payload.outcome',
    'gate_payload.timeout_class',
    'gate_payload.probe_kind',
  ]) {
    assert.match(
      row,
      new RegExp(String.raw`\`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``),
      `judge_measurement_attempted row missing required field ${field}`,
    );
  }
});
