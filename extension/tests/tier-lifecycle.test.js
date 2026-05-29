// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_LIFECYCLE } from '../services/pickle-utils.js';

test('TIER_LIFECYCLE trivial matches Aggressive matrix', () => {
  assert.deepStrictEqual(TIER_LIFECYCLE.trivial, ['implement', 'code_review']);
});

test('TIER_LIFECYCLE small matches Aggressive matrix', () => {
  assert.deepStrictEqual(TIER_LIFECYCLE.small, ['plan', 'implement', 'code_review']);
});

test('TIER_LIFECYCLE medium matches Aggressive matrix', () => {
  assert.deepStrictEqual(TIER_LIFECYCLE.medium, [
    'research',
    'research_review',
    'plan',
    'plan_review',
    'implement',
    'conformance',
    'code_review',
    'simplify',
  ]);
});

test('TIER_LIFECYCLE large matches Aggressive matrix', () => {
  assert.deepStrictEqual(TIER_LIFECYCLE.large, [
    'research',
    'research_review',
    'plan',
    'plan_review',
    'implement',
    'conformance',
    'code_review',
    'simplify',
  ]);
});
