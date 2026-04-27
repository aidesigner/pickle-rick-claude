import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMicroverseState,
  writeMicroverseState,
  readMicroverseState,
} from '../../services/microverse-state.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-iter-reg-'));
}

const BASE_OPTS = {
  prdPath: '/tmp/test.md',
  metric: { name: 'coverage', command: 'echo 80', tolerance: 1 },
  stallLimit: 3,
};

test('createMicroverseState initializes iteration_regressions to 0 and flag to false', () => {
  const state = createMicroverseState(BASE_OPTS);
  assert.equal(state.iteration_regressions, 0);
  assert.equal(state.gate_regression_threshold_warning_emitted, false);
});

test('readMicroverseState defaults iteration_regressions to 0 and flag to false on legacy file', () => {
  const dir = makeTempDir();
  try {
    const legacy = {
      status: 'iterating',
      prd_path: '/tmp/test.md',
      key_metric: { name: 'coverage', command: 'echo 80', tolerance: 1, direction: 'higher' },
      convergence: { stall_limit: 3, stall_counter: 0, history: [] },
      gap_analysis_path: '',
      failed_approaches: [],
      baseline_score: 0,
      failure_history: [],
      approach_exhaustion_fired: false,
      // intentionally omit iteration_regressions and gate_regression_threshold_warning_emitted
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(legacy));
    const state = readMicroverseState(dir);
    assert.notEqual(state, null);
    assert.equal(state.iteration_regressions, 0);
    assert.equal(state.gate_regression_threshold_warning_emitted, false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeMicroverseState preserves modified iteration_regressions across round-trip', () => {
  const dir = makeTempDir();
  try {
    const state = createMicroverseState(BASE_OPTS);
    state.iteration_regressions = 5;
    state.gate_regression_threshold_warning_emitted = true;
    writeMicroverseState(dir, state);
    const read = readMicroverseState(dir);
    assert.notEqual(read, null);
    assert.equal(read.iteration_regressions, 5);
    assert.equal(read.gate_regression_threshold_warning_emitted, true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
