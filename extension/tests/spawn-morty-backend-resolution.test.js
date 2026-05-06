// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWorkerBackendFromState } from '../services/backend-spawn.js';

test('worker backend precedence: state.worker_backend wins over state.backend', () => {
  const resolved = resolveWorkerBackendFromState({ backend: 'claude', worker_backend: 'codex' });
  assert.equal(resolved.backend, 'codex');
  assert.equal(resolved.managerBackend, 'claude');
  assert.equal(resolved.workerBackend, 'codex');
  assert.equal(resolved.source, 'worker_backend');
});

test('worker backend precedence: state.backend is the fallback when worker_backend is unset', () => {
  const resolved = resolveWorkerBackendFromState({ backend: 'codex' });
  assert.equal(resolved.backend, 'codex');
  assert.equal(resolved.managerBackend, 'codex');
  assert.equal(resolved.workerBackend, null);
  assert.equal(resolved.source, 'backend');
});

test('worker backend precedence: PICKLE_REFINEMENT_LOCK=1 beats worker_backend and backend', () => {
  const previous = process.env.PICKLE_REFINEMENT_LOCK;
  process.env.PICKLE_REFINEMENT_LOCK = '1';
  try {
    const resolved = resolveWorkerBackendFromState({ backend: 'claude', worker_backend: 'hermes' });
    assert.equal(resolved.backend, 'claude');
    assert.equal(resolved.managerBackend, 'claude');
    assert.equal(resolved.workerBackend, null);
    assert.equal(resolved.source, 'env_lock');
  } finally {
    if (previous === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
    else process.env.PICKLE_REFINEMENT_LOCK = previous;
  }
});
