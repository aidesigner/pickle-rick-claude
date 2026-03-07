import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromiseTokens, hasToken, wrapToken } from '../types/index.js';

// ---------------------------------------------------------------------------
// wrapToken
// ---------------------------------------------------------------------------

test('wrapToken: wraps a simple token', () => {
  assert.equal(wrapToken('EPIC_COMPLETED'), '<promise>EPIC_COMPLETED</promise>');
});

test('wrapToken: wraps a multi-word token', () => {
  assert.equal(wrapToken('I AM DONE'), '<promise>I AM DONE</promise>');
});

// ---------------------------------------------------------------------------
// hasToken
// ---------------------------------------------------------------------------

test('hasToken: detects exact match', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETED</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: no match for different token', () => {
  assert.equal(hasToken('<promise>TASK_COMPLETED</promise>', 'EPIC_COMPLETED'), false);
});

test('hasToken: works with surrounding text', () => {
  assert.equal(
    hasToken('Done!\n<promise>EPIC_COMPLETED</promise>\nGoodbye.', 'EPIC_COMPLETED'),
    true
  );
});

test('hasToken: whitespace inside tags IS matched (tolerant)', () => {
  assert.equal(hasToken('<promise> EPIC_COMPLETED </promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: empty text never matches', () => {
  assert.equal(hasToken('', 'EPIC_COMPLETED'), false);
});

test('hasToken: empty token never matches', () => {
  assert.equal(hasToken('<promise></promise>', ''), false);
});

test('hasToken: partial token not matched', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETE</promise>', 'EPIC_COMPLETED'), false);
});

// ---------------------------------------------------------------------------
// PromiseTokens shape
// ---------------------------------------------------------------------------

test('PromiseTokens: all expected keys are defined', () => {
  const required = [
    'EPIC_COMPLETED',
    'TASK_COMPLETED',
    'WORKER_DONE',
    'PRD_COMPLETE',
    'TICKET_SELECTED',
    'ANALYSIS_DONE',
    'EXISTENCE_IS_PAIN',
    'THE_CITADEL_APPROVES',
  ];
  for (const key of required) {
    assert.ok(key in PromiseTokens, `Missing PromiseTokens.${key}`);
    assert.equal(typeof PromiseTokens[key], 'string', `PromiseTokens.${key} must be a string`);
    assert.ok(PromiseTokens[key].length > 0, `PromiseTokens.${key} must not be empty`);
  }
});

test('PromiseTokens: WORKER_DONE is "I AM DONE"', () => {
  assert.equal(PromiseTokens.WORKER_DONE, 'I AM DONE');
});

test('PromiseTokens: each token self-detects via hasToken', () => {
  for (const [key, token] of Object.entries(PromiseTokens)) {
    assert.equal(
      hasToken(`<promise>${token}</promise>`, token),
      true,
      `PromiseTokens.${key} ("${token}") must self-detect`
    );
  }
});

test('PromiseTokens: each token wrapped by wrapToken is detected by hasToken', () => {
  for (const [key, token] of Object.entries(PromiseTokens)) {
    assert.equal(
      hasToken(wrapToken(token), token),
      true,
      `wrapToken(PromiseTokens.${key}) must be detected by hasToken`
    );
  }
});

test('hasToken: uses PromiseTokens.WORKER_DONE to detect "I AM DONE"', () => {
  assert.equal(
    hasToken('<promise>I AM DONE</promise>', PromiseTokens.WORKER_DONE),
    true
  );
});

test('hasToken: leading whitespace inside tags matched', () => {
  assert.equal(hasToken('<promise>  EPIC_COMPLETED</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: trailing whitespace inside tags matched', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETED  </promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: newline inside tags matched', () => {
  assert.equal(hasToken('<promise>\nEPIC_COMPLETED\n</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: tab inside tags matched', () => {
  assert.equal(hasToken('<promise>\tEPIC_COMPLETED\t</promise>', 'EPIC_COMPLETED'), true);
});

test('PromiseTokens: ANALYSIS_DONE is "ANALYSIS_DONE"', () => {
  assert.equal(PromiseTokens.ANALYSIS_DONE, 'ANALYSIS_DONE');
});

test('hasToken: detects ANALYSIS_DONE with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> ANALYSIS_DONE </promise>', PromiseTokens.ANALYSIS_DONE), true);
});

test('PromiseTokens: EXISTENCE_IS_PAIN is "EXISTENCE_IS_PAIN"', () => {
  assert.equal(PromiseTokens.EXISTENCE_IS_PAIN, 'EXISTENCE_IS_PAIN');
});

test('hasToken: detects EXISTENCE_IS_PAIN with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> EXISTENCE_IS_PAIN </promise>', PromiseTokens.EXISTENCE_IS_PAIN), true);
});

test('PromiseTokens: THE_CITADEL_APPROVES is "THE_CITADEL_APPROVES"', () => {
  assert.equal(PromiseTokens.THE_CITADEL_APPROVES, 'THE_CITADEL_APPROVES');
});

test('hasToken: detects THE_CITADEL_APPROVES with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> THE_CITADEL_APPROVES </promise>', PromiseTokens.THE_CITADEL_APPROVES), true);
});
