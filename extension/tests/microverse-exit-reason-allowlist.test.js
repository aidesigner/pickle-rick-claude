// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMicroverseFailureExit } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const stateTypesPath = path.join(extensionRoot, 'src', 'types', 'index.ts');

function readStateTypesSource() {
  return fs.readFileSync(stateTypesPath, 'utf8');
}

function extractFailureReasonMembers(source) {
  const match = source.match(/const MICROVERSE_FAILURE_REASONS = new Set<MicroverseExitReason>\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'MICROVERSE_FAILURE_REASONS initializer exists');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map(([, name]) => name));
}

test('MICROVERSE_FAILURE_REASONS allowlist set-equality', () => {
  const actual = extractFailureReasonMembers(readStateTypesSource());
  const expected = new Set([
    'error',
    'rate_limit_exhausted',
    'judge_unreachable',
    'baseline_unmeasurable_unrecoverable',
    'judge_cli_missing',
  ]);

  assert.deepEqual([...actual.symmetricDifference(expected)], []);
});

test('isMicroverseFailureExit split', () => {
  const expectations = new Map([
    ['converged', false],
    ['limit_reached', false],
    ['stopped', false],
    ['error', true],
    ['rate_limit_exhausted', true],
    ['approach_exhaustion', false],
    ['no_progress', false],
    ['judge_unreachable', true],
    ['judge_timeout', false],
    ['baseline_unmeasurable', false],
    ['judge_cli_missing', true],
    ['baseline_unmeasurable_transient', false],
    ['baseline_unmeasurable_unrecoverable', true],
  ]);

  for (const [reason, expected] of expectations) {
    assert.equal(
      isMicroverseFailureExit(reason),
      expected,
      `expected ${reason} to classify as ${expected ? 'fatal' : 'non-fatal'}`,
    );
  }
});

test('MICROVERSE_FAILURE_REASONS initializer excludes bare baseline_unmeasurable', () => {
  const actual = extractFailureReasonMembers(readStateTypesSource());
  assert.equal(actual.has('baseline_unmeasurable'), false);
});
