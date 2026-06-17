// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMechanicalCitadelFinding,
  MECHANICAL_FINDING_MATCHERS,
} from '../../services/citadel/mechanical-finding-classifier.js';

/** Build a CitadelFinding fixture with the real required fields (reporter.ts:9). */
function finding(id, severity = 'Medium') {
  return { id, severity, message: `synthetic ${id}`, file: 'foo.ts', line: 10 };
}

describe('isMechanicalCitadelFinding', () => {
  test('brace-free-if Medium → mechanical', () => {
    assert.equal(isMechanicalCitadelFinding(finding('banned-construct:brace-free-if:foo.ts:10')), true);
  });

  test('nested-ternary Medium → non-mechanical', () => {
    assert.equal(isMechanicalCitadelFinding(finding('banned-construct:nested-ternary:foo.ts:10')), false);
  });

  test('orphan-* findings → non-mechanical', () => {
    assert.equal(isMechanicalCitadelFinding(finding('orphan-test-file:foo.test.js')), false);
    assert.equal(isMechanicalCitadelFinding(finding('orphan-enforce:bar.ts')), false);
    assert.equal(isMechanicalCitadelFinding(finding('orphan-test-case:baz')), false);
  });

  test('any Critical-severity finding → non-mechanical (even a brace-free-if id)', () => {
    assert.equal(isMechanicalCitadelFinding(finding('banned-construct:brace-free-if:foo.ts:10', 'Critical')), false);
    assert.equal(isMechanicalCitadelFinding(finding('orphan-test-file:foo.test.js', 'Critical')), false);
  });
});

describe('MECHANICAL_FINDING_MATCHERS', () => {
  test('ships exactly the one brace-free-if matcher', () => {
    assert.equal(MECHANICAL_FINDING_MATCHERS.length, 1);
    assert.equal(MECHANICAL_FINDING_MATCHERS[0].id, 'banned-construct:brace-free-if');
  });

  test('each matcher exposes an id and a matches predicate', () => {
    for (const matcher of MECHANICAL_FINDING_MATCHERS) {
      assert.equal(typeof matcher.id, 'string');
      assert.equal(typeof matcher.matches, 'function');
    }
  });
});
