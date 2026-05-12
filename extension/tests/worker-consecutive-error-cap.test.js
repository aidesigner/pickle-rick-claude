// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Defaults } from '../types/index.js';

test('R-APMW-3: WORKER_CONSECUTIVE_ERROR_CAP is a number', () => {
  assert.equal(typeof Defaults.WORKER_CONSECUTIVE_ERROR_CAP, 'number');
});

test('R-APMW-3: WORKER_CONSECUTIVE_ERROR_CAP default is 3', () => {
  assert.equal(Defaults.WORKER_CONSECUTIVE_ERROR_CAP, 3);
});

test('R-APMW-3: WORKER_CONSECUTIVE_ERROR_CAP is in [2, 10]', () => {
  assert.ok(
    Defaults.WORKER_CONSECUTIVE_ERROR_CAP >= 2 && Defaults.WORKER_CONSECUTIVE_ERROR_CAP <= 10,
  );
});
