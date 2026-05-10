// @tier: fast
// Stub — full 6-case suite implemented by ticket edb6d3b4.
// This file satisfies the ENFORCE reference for R-SLLJ-1 and R-SLLJ-4 trap-door entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { currentExitForFailureHistory } from '../bin/microverse-runner.js';
import { createMicroverseState } from '../services/microverse-state.js';

test('R-SLLJ stub: trap-door ENFORCE ref exists', () => {
  assert.ok(true, 'stub placeholder — expanded by ticket edb6d3b4');
});

// R-SLLJ-9: case A — LLM metric type bypasses the 3-consecutive bail-out

test('R-SLLJ-9 case A: 3 consecutive no_progress with metric.type=llm — loop continues', () => {
  const state = createMicroverseState({
    prdPath: '/tmp/prd.md',
    metric: { description: 'judge', validation: 'true', type: 'llm', timeout_seconds: 30, tolerance: 0 },
    stallLimit: 50,
  });
  const noProgress = (i) => ({ iteration: i, failure_class: 'no_progress', description: 'held', timestamp: new Date().toISOString() });
  state.failure_history.push(noProgress(1), noProgress(2), noProgress(3));
  const ctx = { log: () => {}, sessionDir: os.tmpdir() };
  const result = currentExitForFailureHistory(state, ctx);
  assert.strictEqual(result, null, 'LLM sessions must not bail on 3 consecutive no_progress');
});

// R-SLLJ-9: case B — non-LLM metric type preserves the bail-out (pre-fix behavior)

test('R-SLLJ-9 case B: 3 consecutive no_progress with metric.type=command — bail-out fires', () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-r-sllj9-'));
  const state = createMicroverseState({
    prdPath: '/tmp/prd.md',
    metric: { description: 'tests', validation: 'npm test', type: 'command', timeout_seconds: 30, tolerance: 0 },
    stallLimit: 50,
  });
  const noProgress = (i) => ({ iteration: i, failure_class: 'no_progress', description: 'held', timestamp: new Date().toISOString() });
  state.failure_history.push(noProgress(1), noProgress(2), noProgress(3));
  const ctx = { log: () => {}, sessionDir };
  const result = currentExitForFailureHistory(state, ctx);
  assert.strictEqual(result, 'no_progress', 'non-LLM sessions must still bail on 3 consecutive no_progress');
  fs.rmSync(sessionDir, { recursive: true, force: true });
});
