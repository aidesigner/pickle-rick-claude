// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createMicroverseState,
  writeMicroverseState,
  readMicroverseState,
  readRecoverableJsonObject,
  generateViolationId,
  updateViolationLedger,
  compareMetric,
} from '../../services/microverse-state.js';

const READ_MICROVERSE_BIN = path.resolve('bin/read-microverse.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-iter-reg-'));
}

const BASE_OPTS = {
  prdPath: '/tmp/test.md',
  metric: {
    description: 'coverage',
    validation: 'echo 80',
    type: 'command',
    timeout_seconds: 30,
    tolerance: 1,
  },
  stallLimit: 3,
};

test('createMicroverseState initializes iteration_regressions to 0 and flag to false', () => {
  const state = createMicroverseState(BASE_OPTS);
  assert.equal(state.iteration_regressions, 0);
  assert.equal(state.gate_regression_threshold_warning_emitted, false);
});

test('R-APMW-4: new state defaults consecutive_subprocess_errors to 0', () => {
  const state = createMicroverseState(BASE_OPTS);
  assert.equal(state.consecutive_subprocess_errors, 0);
});

test('readMicroverseState defaults iteration_regressions to 0 and flag to false on legacy file', () => {
  const dir = makeTempDir();
  try {
    const legacy = {
      status: 'iterating',
      prd_path: '/tmp/test.md',
      key_metric: {
        description: 'coverage',
        validation: 'echo 80',
        type: 'command',
        timeout_seconds: 30,
        tolerance: 1,
        direction: 'higher',
      },
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

test('R-APMW-4: legacy state.json (missing field) reads as 0', () => {
  const dir = makeTempDir();
  try {
    const legacy = {
      status: 'iterating',
      prd_path: '/tmp/test.md',
      key_metric: {
        description: 'coverage',
        validation: 'echo 80',
        type: 'command',
        timeout_seconds: 30,
        tolerance: 1,
        direction: 'higher',
      },
      convergence: { stall_limit: 3, stall_counter: 0, history: [] },
      gap_analysis_path: '',
      failed_approaches: [],
      baseline_score: 0,
      failure_history: [],
      approach_exhaustion_fired: false,
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(legacy));
    const state = readMicroverseState(dir);
    assert.notEqual(state, null);
    assert.equal(state.consecutive_subprocess_errors, 0);
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

test('R-APMW-4: state round-trip preserves field', () => {
  const dir = makeTempDir();
  try {
    const state = createMicroverseState(BASE_OPTS);
    state.consecutive_subprocess_errors = 2;
    writeMicroverseState(dir, state);
    const read = readMicroverseState(dir);
    assert.notEqual(read, null);
    assert.equal(read.consecutive_subprocess_errors, 2);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('read-microverse CLI promotes dead writer tmp before reading iteration_regressions', () => {
  const dir = makeTempDir();
  try {
    const stale = createMicroverseState(BASE_OPTS);
    stale.iteration_regressions = 0;
    writeMicroverseState(dir, stale);

    const recovered = createMicroverseState(BASE_OPTS);
    recovered.iteration_regressions = 4;
    fs.writeFileSync(path.join(dir, 'microverse.json.tmp.999999'), JSON.stringify(recovered, null, 2));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(path.join(dir, 'microverse.json.tmp.999999'), future, future);

    const result = spawnSync(process.execPath, [READ_MICROVERSE_BIN, dir, 'iteration_regressions'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '4');
    assert.equal(fs.existsSync(path.join(dir, 'microverse.json.tmp.999999')), false);
    assert.equal(readMicroverseState(dir)?.iteration_regressions, 4);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('readRecoverableJsonObject ignores stale tmp cleanup failures and returns the base object', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'cache.json');
  const staleTmp = `${target}.tmp.999999`;
  try {
    fs.writeFileSync(target, JSON.stringify({ value: 'base' }));
    fs.writeFileSync(staleTmp, JSON.stringify({ value: 'stale-tmp' }));
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    fs.utimesSync(staleTmp, oldTime, oldTime);
    fs.utimesSync(target, newTime, newTime);
    fs.chmodSync(dir, 0o555);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { value: 'base' });
    assert.equal(fs.existsSync(staleTmp), true, 'unremovable stale tmp should be left for a later cleanup');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* ignore cleanup chmod failure */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// generateViolationId — R-SLLJ-3
// ---------------------------------------------------------------------------

test('generateViolationId is deterministic — same input produces same output across 10 calls', () => {
  const violation = { id: 'v1', path: 'src/foo.ts', line: 42, rule: 'no-any', severity: 'high', description: 'x' };
  const first = generateViolationId(violation);
  for (let i = 0; i < 9; i++) {
    assert.equal(generateViolationId(violation), first);
  }
});

test('generateViolationId file-line-rule format produces 8-char hex string', () => {
  const violation = { id: 'v1', path: 'src/foo.ts', line: 10, rule: 'no-any', severity: 'med', description: 'y' };
  const id = generateViolationId(violation);
  assert.match(id, /^[a-f0-9]{8}$/, `expected 8-char hex but got "${id}"`);
});

test('generateViolationId cross-file architectural with path "<arch>" preserves literal format, no hash', () => {
  const violation = { id: 'graph-service', path: '<arch>', rule: 'circular-dep', severity: 'high', description: 'z' };
  const id = generateViolationId(violation);
  assert.equal(id, 'module:graph-service:rule:circular-dep');
  assert.doesNotMatch(id, /^[a-f0-9]{8}$/);
});

test('generateViolationId cross-file architectural with rule namespace "arch:" strips prefix and uses literal format', () => {
  const violation = { id: 'auth-module', path: 'src/auth.ts', rule: 'arch:no-cross-layer', severity: 'med', description: 'w' };
  const id = generateViolationId(violation);
  assert.equal(id, 'module:auth-module:rule:no-cross-layer');
});

// ---------------------------------------------------------------------------
// updateViolationLedger — fuzzy line-match, beyond ±5, migration
// ---------------------------------------------------------------------------

test('updateViolationLedger fuzzy line-match within ±5 reuses ID and updates last_seen_iter', () => {
  const state = createMicroverseState(BASE_OPTS);
  state.violation_ledger = [];

  // First iteration: violation at line 42
  const judgeResult1 = {
    score: 80,
    violations: [{ id: 'v1', path: 'src/foo.ts', line: 42, rule: 'no-any', severity: 'high', description: 'use of any' }],
    resolved: [], new: [], remaining: [], shape: 'full',
  };
  updateViolationLedger(state, judgeResult1, 1);
  assert.equal(state.violation_ledger.length, 1);
  const firstId = state.violation_ledger[0].id;
  assert.equal(state.violation_ledger[0].first_seen_iter, 1);
  assert.equal(state.violation_ledger[0].last_seen_iter, 1);

  // Second iteration: same violation shifted to line 47 (within ±5)
  const judgeResult2 = {
    score: 78,
    violations: [{ id: 'v1', path: 'src/foo.ts', line: 47, rule: 'no-any', severity: 'high', description: 'use of any' }],
    resolved: [], new: [], remaining: [], shape: 'full',
  };
  updateViolationLedger(state, judgeResult2, 2);
  assert.equal(state.violation_ledger.length, 1, 'should reuse, not create new entry');
  assert.equal(state.violation_ledger[0].id, firstId, 'ID must be reused');
  assert.equal(state.violation_ledger[0].first_seen_iter, 1, 'first_seen_iter must not change');
  assert.equal(state.violation_ledger[0].last_seen_iter, 2, 'last_seen_iter must be updated');
});

test('updateViolationLedger beyond ±5 lines replaces the live entry with a new ID', () => {
  const state = createMicroverseState(BASE_OPTS);
  state.violation_ledger = [];

  const judgeResult1 = {
    score: 80,
    violations: [{ id: 'v1', path: 'src/bar.ts', line: 42, rule: 'strict-null', severity: 'med', description: 'null check' }],
    resolved: [], new: [], remaining: [], shape: 'full',
  };
  updateViolationLedger(state, judgeResult1, 1);
  assert.equal(state.violation_ledger.length, 1);
  const firstId = state.violation_ledger[0].id;

  // line 50 is 8 lines away from 42 — beyond ±5
  const judgeResult2 = {
    score: 78,
    violations: [{ id: 'v2', path: 'src/bar.ts', line: 50, rule: 'strict-null', severity: 'med', description: 'null check' }],
    resolved: [], new: [], remaining: [], shape: 'full',
  };
  updateViolationLedger(state, judgeResult2, 2);
  assert.equal(state.violation_ledger.length, 1, 'live ledger should contain only the current violation set');
  assert.notEqual(state.violation_ledger[0].id, firstId, 'replacement entry must have a different ID');
  assert.equal(state.violation_ledger[0].line, 50, 'replacement entry should track the new location');
});

// ---------------------------------------------------------------------------
// compareMetric — R-SLLJ-4 set-ops branch
// ---------------------------------------------------------------------------

test('compareMetric set-ops improved: resolved>0 and no overlap between new and remaining', () => {
  const current = { resolved: ['a', 'b'], new: [], remaining: ['c', 'd', 'e'] };
  const previous = { resolved: [], new: ['a', 'b', 'c', 'd', 'e'], remaining: [] };
  const result = compareMetric(75, 80, 1, 'higher', current, previous);
  assert.equal(result, 'improved');
});

test('compareMetric set-ops regressed: new.size > resolved.size', () => {
  const current = { resolved: ['a'], new: ['x', 'y', 'z', 'w'], remaining: ['b', 'c'] };
  const previous = { resolved: [], new: ['a', 'b', 'c'], remaining: [] };
  const result = compareMetric(70, 80, 1, 'higher', current, previous);
  assert.equal(result, 'regressed');
});

test('compareMetric set-ops held: resolved=0 and new=0', () => {
  const current = { resolved: [], new: [], remaining: ['c', 'd'] };
  const previous = { resolved: [], new: ['c', 'd'], remaining: [] };
  const result = compareMetric(78, 80, 1, 'higher', current, previous);
  assert.equal(result, 'held');
});

test('compareMetric half-ledger fallback: current ledger only, violations.length < previousScore → improved', () => {
  const current = { resolved: [], new: ['v1'], remaining: ['v2', 'v3'] };
  // 3 violations (1 new + 2 remaining) < 10 (previousScore) → improved
  const result = compareMetric(0, 10, 1, 'higher', current, undefined);
  assert.equal(result, 'improved');
});

test('compareMetric no-ledger numeric fallback: pre-fix behavior preserved when both ledgers absent', () => {
  // higher direction: current > previous + tolerance → improved
  assert.equal(compareMetric(85, 80, 1, 'higher'), 'improved');
  // lower direction: current < previous - tolerance → improved
  assert.equal(compareMetric(5, 10, 1, 'lower'), 'improved');
  // within tolerance → held
  assert.equal(compareMetric(80, 80, 1, 'higher'), 'held');
});

test('readMicroverseState migration: missing violation_ledger defaults to []', () => {
  const dir = makeTempDir();
  try {
    const legacy = {
      status: 'iterating',
      prd_path: '/tmp/test.md',
      key_metric: {
        description: 'coverage',
        validation: 'echo 80',
        type: 'command',
        timeout_seconds: 30,
        tolerance: 1,
        direction: 'higher',
      },
      convergence: { stall_limit: 3, stall_counter: 0, history: [] },
      gap_analysis_path: '',
      failed_approaches: [],
      baseline_score: 0,
      failure_history: [],
      approach_exhaustion_fired: false,
      iteration_regressions: 0,
      gate_regression_threshold_warning_emitted: false,
      // intentionally omit violation_ledger
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(legacy));
    const state = readMicroverseState(dir);
    assert.notEqual(state, null);
    assert.deepEqual(state.violation_ledger, [], 'missing violation_ledger must default to []');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
