// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { currentExitForFailureHistory, parseLlmJudgeOutput } from '../bin/microverse-runner.js';
import { compareMetric, createMicroverseState } from '../services/microverse-state.js';

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

// R-SLLJ-8: 6 regression cases for LLM-judge non-determinism recovery

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return chunks.join('');
}

  test('R-SLLJ-8 case (a): numeric stall + ledger resolved>0 new=0 → compareMetric returns improved', () => {
    const currentLedger = { resolved: ['v1', 'v2'], new: [], remaining: [] };
    const prevLedger = { resolved: [], new: [], remaining: [] };
    const result = compareMetric(5, 5, 0, 'higher', currentLedger, prevLedger);
    assert.strictEqual(result, 'improved', 'ledger set-ops override numeric stall when violations resolved');
  });

  test('R-SLLJ-8 case (b): numeric improve + ledger new>resolved → compareMetric returns regressed', () => {
    const currentLedger = { resolved: ['v1'], new: ['v2', 'v3', 'v4', 'v5'], remaining: [] };
    const prevLedger = { resolved: [], new: [], remaining: [] };
    const result = compareMetric(7, 5, 0, 'higher', currentLedger, prevLedger);
    assert.strictEqual(result, 'regressed', 'ledger set-ops override numeric improve when new violations exceed resolved');
  });

  test('R-SLLJ-8 case (c): score-only JSON → parseLlmJudgeOutput returns shape legacy, emits judge_legacy_shape_inferred', () => {
    let result;
    const captured = captureStderr(() => {
      result = parseLlmJudgeOutput(JSON.stringify({ score: 7.5 }));
    });
    assert.strictEqual(result.shape, 'legacy');
    assert.ok(captured.includes('judge_legacy_shape_inferred'), `expected stderr to contain judge_legacy_shape_inferred, got: ${captured}`);
  });

  test('R-SLLJ-8 case (d): metric.type=count (non-LLM) → compareMetric uses pure-numeric path', () => {
    assert.strictEqual(compareMetric(7, 5, 0, 'higher'), 'improved', 'higher score should be improved');
    assert.strictEqual(compareMetric(3, 5, 0, 'higher'), 'regressed', 'lower score should be regressed');
    assert.strictEqual(compareMetric(5, 5, 0, 'higher'), 'held', 'equal score should be held');
  });

  test('R-SLLJ-8 case (e): malformed JSON → parseLlmJudgeOutput returns shape malformed, emits judge_json_parse_failed, stall_counter unchanged', () => {
    const state = createMicroverseState({
      prdPath: '/tmp/prd.md',
      metric: { description: 'quality', validation: 'true', type: 'llm', timeout_seconds: 30, tolerance: 0 },
      stallLimit: 50,
    });
    const initialStall = state.convergence.stall_counter;
    let result;
    const captured = captureStderr(() => {
      result = parseLlmJudgeOutput('NOT_VALID_JSON{{{');
    });
    assert.strictEqual(result.shape, 'malformed');
    assert.ok(captured.includes('judge_json_parse_failed'), `expected stderr to contain judge_json_parse_failed, got: ${captured}`);
    assert.strictEqual(state.convergence.stall_counter, initialStall, 'stall_counter must not be incremented for malformed judge output');
  });

  test('R-SLLJ-8 case (f): partial-shape JSON (violations non-array) → shape partial, emits judge_json_parse_failed, stall_counter unchanged', () => {
    const state = createMicroverseState({
      prdPath: '/tmp/prd.md',
      metric: { description: 'quality', validation: 'true', type: 'llm', timeout_seconds: 30, tolerance: 0 },
      stallLimit: 50,
    });
    const initialStall = state.convergence.stall_counter;
    let result;
    const captured = captureStderr(() => {
      result = parseLlmJudgeOutput(JSON.stringify({ score: 5, violations: 'not-an-array' }));
    });
    assert.strictEqual(result.shape, 'partial');
    assert.ok(captured.includes('judge_json_parse_failed'), `expected stderr to contain judge_json_parse_failed, got: ${captured}`);
    assert.strictEqual(state.convergence.stall_counter, initialStall, 'stall_counter must not be incremented for partial-shape judge output');
  });
