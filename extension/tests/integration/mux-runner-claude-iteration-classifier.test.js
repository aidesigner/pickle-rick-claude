// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectManagerMaxTurnsExit, classifyCompletion } from '../../bin/mux-runner.js';

function makeResultLog(dir, fields) {
  const logFile = path.join(dir, 'iteration.log');
  const event = { type: 'result', stop_reason: 'end_turn', terminal_reason: 'completed', is_error: false, ...fields };
  fs.writeFileSync(logFile, JSON.stringify(event) + '\n');
  return logFile;
}

function baseOutcome(overrides = {}) {
  return { completion: 'error', timedOut: false, exitCode: 0, wallSeconds: 10, ...overrides };
}

test('detectManagerMaxTurnsExit: clean claude end_turn result returns true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 40 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 40);
    assert.equal(result, true, 'should be true: clean end_turn completion with exit code 0 matches the signature');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: timedOut=true → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 40 });
    const result = detectManagerMaxTurnsExit(baseOutcome({ timedOut: true, exitCode: null }), logFile, 40);
    assert.equal(result, false, 'timedOut outcome should not classify as max-turns');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: non-zero exit code → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 40 });
    const result = detectManagerMaxTurnsExit(baseOutcome({ exitCode: 1 }), logFile, 40);
    assert.equal(result, false, 'non-zero exit should not classify as max-turns');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: is_error=true → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { is_error: true, num_turns: 40 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 40);
    assert.equal(result, false, 'is_error=true should not classify as max-turns');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: missing log file → false', () => {
  const result = detectManagerMaxTurnsExit(baseOutcome(), path.join(os.tmpdir(), 'missing-max-turns-log.jsonl'), 40);
  assert.equal(result, false, 'missing logs should fail closed');
});

test('detectManagerMaxTurnsExit: completion=continue → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 40 });
    const result = detectManagerMaxTurnsExit(baseOutcome({ completion: 'continue' }), logFile, 40);
    assert.equal(result, false, 'helper only classifies the error-branch shape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: last result event wins even if earlier event does not match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = path.join(dir, 'iteration.log');
    fs.writeFileSync(logFile, [
      JSON.stringify({ type: 'result', stop_reason: 'tool_use', terminal_reason: 'completed', is_error: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] } }),
      JSON.stringify({ type: 'result', stop_reason: 'end_turn', terminal_reason: 'completed', is_error: false, num_turns: 40 }),
      '',
    ].join('\n'));
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 40);
    assert.equal(result, true, 'the detector should inspect the last result event');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: last result stop_reason mismatch → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = path.join(dir, 'iteration.log');
    fs.writeFileSync(logFile, [
      JSON.stringify({ type: 'result', stop_reason: 'end_turn', terminal_reason: 'completed', is_error: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] } }),
      JSON.stringify({ type: 'result', stop_reason: 'tool_use', terminal_reason: 'completed', is_error: false, num_turns: 40 }),
      '',
    ].join('\n'));
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 40);
    assert.equal(result, false, 'the last result event must match the end_turn signature');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: below-budget turn count → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 39 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 40);
    assert.equal(result, false, 'helper should fail closed when the last result event did not reach the budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCompletion: codex prompt-echo EPIC_COMPLETED in user block → continue (not task_completed)', () => {
  // Codex can echo the system prompt back as a "user" block before its own response.
  // If the prompt itself contains EPIC_COMPLETED (as instruction text), the classifier
  // must NOT count that as a real completion claim. Only a "codex" block token counts.
  const output = [
    'user',
    'You must emit <promise>EPIC_COMPLETED</promise> when all tickets are done.',
    'codex',
    'I will now work on the next ticket.',
  ].join('\n');
  const result = classifyCompletion(output);
  assert.equal(result, 'continue', 'EPIC_COMPLETED in user/prompt block must not trigger task_completed');
});

test('classifyCompletion: EPIC_COMPLETED in codex assistant block → task_completed', () => {
  const output = [
    'user',
    'Complete the task.',
    'codex',
    `Work is done. <promise>EPIC_COMPLETED</promise>`,
  ].join('\n');
  const result = classifyCompletion(output);
  assert.equal(result, 'task_completed', 'EPIC_COMPLETED in codex assistant block should trigger task_completed');
});
