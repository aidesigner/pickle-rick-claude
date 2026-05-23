// @tier: fast
//
// R-WTFT regression: locks in the worker `test:fast` gate timeout default at
// 600_000 ms (10 min) and validates the `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`
// env-var override path including parse-failure fallback and floor clamping.
//
// Background: the previous 240_000 ms (4 min) cap was killing legitimate runs
// on Opus hardware when the ~4994-test fast suite ran for >4 min, rolling
// back all worker artifacts and flipping tickets Failed mid-validation. See
// session pickle-216774d6 ticket R-WUWC-1 incident (2026-05-23).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS,
  WORKER_TEST_GATE_TIMEOUT_FLOOR_MS,
  WORKER_TEST_GATE_TIMEOUT_ENV_VAR,
  resolveWorkerTestGateTimeoutMs,
} from '../services/pickle-utils.js';

test('R-WTFT default is 600_000 ms (10 min, ~3x headroom over ~3 min real-world fast-suite floor)', () => {
  assert.equal(DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS, 600_000);
});

test('R-WTFT floor for env override is 60_000 ms', () => {
  assert.equal(WORKER_TEST_GATE_TIMEOUT_FLOOR_MS, 60_000);
});

test('R-WTFT env override name is PICKLE_WORKER_TEST_FAST_TIMEOUT_MS', () => {
  assert.equal(WORKER_TEST_GATE_TIMEOUT_ENV_VAR, 'PICKLE_WORKER_TEST_FAST_TIMEOUT_MS');
});

test('R-WTFT no env, no settings -> default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {});
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT env override accepted in valid range (120_000 ms)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '120000',
  });
  assert.equal(got, 120_000);
});

test('R-WTFT env override clamps to floor (30_000 -> 60_000)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '30000',
  });
  assert.equal(got, WORKER_TEST_GATE_TIMEOUT_FLOOR_MS);
});

test('R-WTFT env override at exact floor passes through', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '60000',
  });
  assert.equal(got, 60_000);
});

test('R-WTFT env override well above default passes through (1_800_000 = 30 min)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '1800000',
  });
  assert.equal(got, 1_800_000);
});

test('R-WTFT invalid env (non-numeric) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: 'foo',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (float) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '120000.5',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (negative) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '-1000',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (zero) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '0',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT empty env string falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT env override wins over settings value', () => {
  const settings = { worker_test_gate_timeout_ms: 300_000 };
  const got = resolveWorkerTestGateTimeoutMs(undefined, settings, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '450000',
  });
  assert.equal(got, 450_000);
});

test('R-WTFT settings used when env absent and settings valid', () => {
  const settings = { worker_test_gate_timeout_ms: 300_000 };
  const got = resolveWorkerTestGateTimeoutMs(undefined, settings, {});
  assert.equal(got, 300_000);
});
