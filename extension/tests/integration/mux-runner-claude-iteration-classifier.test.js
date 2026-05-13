// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectManagerMaxTurnsExit, classifyCompletion } from '../../bin/mux-runner.js';

const __filename = fileURLToPath(import.meta.url);

function makeResultLog(dir, fields) {
  const logFile = path.join(dir, 'iteration.log');
  const event = { type: 'result', stop_reason: 'end_turn', terminal_reason: 'completed', is_error: false, ...fields };
  fs.writeFileSync(logFile, JSON.stringify(event) + '\n');
  return logFile;
}

function baseOutcome(overrides = {}) {
  return { completion: 'continue', timedOut: false, exitCode: 0, wallSeconds: 10, ...overrides };
}

test('detectManagerMaxTurnsExit: clean exit num_turns=50 maxTurns=400 → false (not at budget)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 50 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 400);
    assert.equal(result, false, 'should be false: worker finished naturally under the turn budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: clean exit num_turns=400 maxTurns=400 → true (at budget)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 400 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 400);
    assert.equal(result, true, 'should be true: turn count equals budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: clean exit num_turns=401 maxTurns=400 → true (over budget)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 401 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 400);
    assert.equal(result, true, 'should be true: turn count exceeds budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: no num_turns field → false (conservative)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, {}); // no num_turns
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, 400);
    assert.equal(result, false, 'should be false: cannot confirm max-turns without turn count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: maxTurns=null → false (no budget, conservative)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 400 });
    const result = detectManagerMaxTurnsExit(baseOutcome(), logFile, null);
    assert.equal(result, false, 'should be false: null maxTurns means unknown budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: timedOut=true → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 400 });
    const result = detectManagerMaxTurnsExit(baseOutcome({ timedOut: true, exitCode: null }), logFile, 400);
    assert.equal(result, false, 'timedOut outcome should not classify as max-turns');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectManagerMaxTurnsExit: non-zero exit code → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icdm-test-'));
  try {
    const logFile = makeResultLog(dir, { num_turns: 400 });
    const result = detectManagerMaxTurnsExit(baseOutcome({ exitCode: 1 }), logFile, 400);
    assert.equal(result, false, 'non-zero exit should not classify as max-turns');
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
