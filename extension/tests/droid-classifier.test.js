// @tier: fast
// Unit/fixture tests for the droid backend envelope classifier branch
// (feature pr-droid-classifier). These cover VAL-IMPL-015/016/017/018/019:
// droid's structured output envelopes must be parsed so promise-token
// completion detection works, while tokens in user/system/init lines are
// ignored and non-promise output does NOT trigger completion.
//
// Fixtures use the real captured droid envelope shapes from mission readiness
// (library/environment.md):
//   - stream-json: {"type":"message","role":"assistant","text":"..."}  (FLAT .text)
//                  {"type":"completion","finalText":"..."}             (terminal)
//                  {"type":"system","subtype":"init",...} / {"type":"message","role":"user",...}
//   - json:        {"type":"result","result":"...","is_error":false,...} (terminal)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyCompletion,
  detectOutputFormat,
  extractAssistantContent,
} from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures', 'iteration-logs');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

const PROMISE = '<promise>EPIC_COMPLETED</promise>';
const WORKER_DONE = '<promise>I AM DONE</promise>';

// --- detectOutputFormat: droid envelopes are recognized as a distinct format ---

test('detectOutputFormat: droid stream-json (message+completion) -> "droid"', () => {
  const content = readFixture('droid-stream-json-assistant-text-promise.log');
  assert.equal(detectOutputFormat(content), 'droid');
});

test('detectOutputFormat: droid completion-only stream -> "droid"', () => {
  const content = readFixture('droid-completion-finaltext-promise.log');
  assert.equal(detectOutputFormat(content), 'droid');
});

test('detectOutputFormat: droid json result (single terminal object) is handled (not plain-text miss)', () => {
  const content = readFixture('droid-json-result-promise.log');
  // A lone {type:"result"} terminal is handled by the classifier regardless of
  // the reported format; assert it is NOT misclassified as codex-block and that
  // the assistant content is extracted.
  assert.notEqual(detectOutputFormat(content), 'codex-block');
  assert.ok(extractAssistantContent(content).includes(PROMISE));
});

// --- VAL-IMPL-015: stream-json assistant .text promise -> complete ---

test('VAL-IMPL-015: stream-json assistant .text with promise token -> task_completed', () => {
  const content = readFixture('droid-stream-json-assistant-text-promise.log');
  assert.equal(classifyCompletion(content), 'task_completed');
});

test('VAL-IMPL-015: extractAssistantContent reads FLAT .text on {type:message,role:assistant} (not Claude nested content[])', () => {
  const content = readFixture('droid-stream-json-assistant-text-promise.log');
  const extracted = extractAssistantContent(content);
  assert.ok(extracted.includes(PROMISE), 'assistant .text promise token must be extracted');
  // The flat .text value (not a nested content[].text) is what carries the token.
  assert.match(extracted, /All tickets are complete/);
});

// --- VAL-IMPL-016: json .result promise -> complete ---

test('VAL-IMPL-016: json terminal .result with promise token -> task_completed', () => {
  const content = readFixture('droid-json-result-promise.log');
  assert.equal(classifyCompletion(content), 'task_completed');
});

// --- VAL-IMPL-017: completion .finalText promise -> complete ---

test('VAL-IMPL-017: {type:completion} .finalText with promise token -> task_completed', () => {
  const content = readFixture('droid-completion-finaltext-promise.log');
  assert.equal(classifyCompletion(content), 'task_completed');
});

test('VAL-IMPL-017: .finalText is mapped even when assistant .text lacks the token', () => {
  const content = readFixture('droid-completion-finaltext-promise.log');
  const extracted = extractAssistantContent(content);
  // The assistant .text in this fixture is "Working on the implementation now." (no token);
  // the token lives ONLY in .finalText and must still be extracted.
  assert.ok(extracted.includes(PROMISE), '.finalText promise must be extracted');
  assert.doesNotMatch(
    extractAssistantContent(
      '{"type":"message","role":"assistant","text":"Working on the implementation now."}\n'
    ),
    /EPIC_COMPLETED/,
  );
});

// --- VAL-IMPL-018: non-promise envelopes (any shape) -> not done ---

test('VAL-IMPL-018: stream-json non-promise envelope -> continue (not done)', () => {
  const content = readFixture('droid-stream-json-no-promise.log');
  assert.equal(classifyCompletion(content), 'continue');
});

test('VAL-IMPL-018: json non-promise .result -> continue (not done)', () => {
  const content = readFixture('droid-json-result-no-promise.log');
  assert.equal(classifyCompletion(content), 'continue');
});

test('VAL-IMPL-018: empty/garbage droid-shaped output -> continue (no false completion)', () => {
  // A completion envelope with ordinary text and no token must not be treated
  // as done merely because it is a terminal object.
  const content =
    '{"type":"system","subtype":"init","session_id":"s","model":"glm-5.2","tools":[]}\n' +
    '{"type":"message","role":"assistant","text":"still working"}\n' +
    '{"type":"completion","finalText":"still working","numTurns":1}\n';
  assert.equal(classifyCompletion(content), 'continue');
});

// --- VAL-IMPL-019: promise token in user/system/init content is ignored ---

test('VAL-IMPL-019: promise token only in user/system lines -> continue (not done)', () => {
  const content = readFixture('droid-stream-json-promise-in-user-only.log');
  assert.equal(classifyCompletion(content), 'continue');
});

test('VAL-IMPL-019: extractAssistantContent excludes user/system/init lines', () => {
  const content = readFixture('droid-stream-json-promise-in-user-only.log');
  const extracted = extractAssistantContent(content);
  assert.equal(extracted.includes(PROMISE), false,
    'promise token in user/system content must NOT leak into assistant content');
});

test('VAL-IMPL-019: token in system/init line alone is ignored', () => {
  const content =
    '{"type":"system","subtype":"init","session_id":"s","model":"glm-5.2","tools":[],' +
    '"text":"<promise>EPIC_COMPLETED</promise>"}\n' +
    '{"type":"message","role":"assistant","text":"no token here"}\n' +
    '{"type":"completion","finalText":"no token here","numTurns":1}\n';
  assert.equal(classifyCompletion(content), 'continue');
  assert.equal(extractAssistantContent(content).includes(PROMISE), false);
});

// --- Worker-done token (I AM DONE) extraction: assistant-only, same rules ---

test('droid: WORKER_DONE (<promise>I AM DONE</promise>) in assistant .text is extracted', () => {
  const content = readFixture('droid-stream-json-worker-done-assistant.log');
  const extracted = extractAssistantContent(content);
  assert.ok(extracted.includes(WORKER_DONE),
    'WORKER_DONE in assistant .text/.finalText must be extracted (per-ticket completion path)');
});

test('droid: WORKER_DONE only in user content is NOT extracted', () => {
  const content = readFixture('droid-stream-json-worker-done-in-user-only.log');
  const extracted = extractAssistantContent(content);
  assert.equal(extracted.includes(WORKER_DONE), false,
    'WORKER_DONE in user content must not leak into assistant content');
});

// --- Regression guard: Claude / codex / mixed-json fixtures unchanged ---

test('regression: claude stream-json still detected as "stream-json" (not droid)', () => {
  const content = readFixture('claude-stream-json.log');
  assert.equal(detectOutputFormat(content), 'stream-json');
  assert.equal(classifyCompletion(content), 'continue');
});

test('regression: claude real completion still task_completed', () => {
  const content = readFixture('claude-real-completion.log');
  assert.equal(classifyCompletion(content), 'task_completed');
});

test('regression: mixed-json-noise still codex-block (droid detection does not over-fire)', () => {
  const content = readFixture('mixed-json-noise.log');
  assert.equal(detectOutputFormat(content), 'codex-block');
});

test('regression: plain text with no delimiters/JSON -> plain-text', () => {
  const drifted = 'Starting analysis...\nImplementing the fix now.\nI AM DONE\n';
  assert.equal(detectOutputFormat(drifted), 'plain-text');
});
