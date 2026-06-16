// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexVersionSatisfiesRange } from '../bin/setup.js';

const line = (v) => `codex-cli ${v}`;

test('floor range >=X.Y.Z accepts the floor and anything above it', () => {
  // The fix: codex ships 0.x with frequent minor bumps; a floor must not break daily.
  assert.equal(codexVersionSatisfiesRange(line('0.133.0'), '>=0.133.0'), true, 'equal to floor');
  assert.equal(codexVersionSatisfiesRange(line('0.133.7'), '>=0.133.0'), true, 'higher patch');
  assert.equal(codexVersionSatisfiesRange(line('0.134.0'), '>=0.133.0'), true, 'higher minor (the daily-churn case)');
  assert.equal(codexVersionSatisfiesRange(line('0.200.5'), '>=0.133.0'), true, 'much higher minor');
  assert.equal(codexVersionSatisfiesRange(line('1.5.0'), '>=0.133.0'), true, 'higher major');
});

test('floor range >=X.Y.Z rejects anything below the floor', () => {
  assert.equal(codexVersionSatisfiesRange(line('0.132.9'), '>=0.133.0'), false, 'lower minor');
  assert.equal(codexVersionSatisfiesRange(line('0.0.0'), '>=0.133.0'), false, 'far below');
});

test('floor range tolerates whitespace after >=', () => {
  assert.equal(codexVersionSatisfiesRange(line('0.140.0'), '>= 0.133.0'), true);
});

test('exact range X.Y.Z behavior is preserved (strict equality)', () => {
  assert.equal(codexVersionSatisfiesRange(line('0.133.0'), '0.133.0'), true);
  assert.equal(codexVersionSatisfiesRange(line('0.134.0'), '0.133.0'), false, 'exact pin still rejects a newer version');
});

test('caret range ^X.Y.Z behavior is preserved (0.x locks the minor)', () => {
  assert.equal(codexVersionSatisfiesRange(line('0.133.9'), '^0.133.0'), true, 'patch bump within 0.133.x');
  assert.equal(codexVersionSatisfiesRange(line('0.134.0'), '^0.133.0'), false, 'minor bump excluded for 0.x caret');
});

test('unparseable version output never satisfies a range', () => {
  assert.equal(codexVersionSatisfiesRange('no version here', '>=0.133.0'), false);
});
