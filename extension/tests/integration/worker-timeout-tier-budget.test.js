// @tier: integration
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getTicketTierBudgetWithOverrides } from '../../services/pickle-utils.js';
import { makeState } from './test-harness.js';

const TIER_ROWS = [
  ['trivial', 300],
  ['small', 600],
  ['medium', 2400],
  ['large', 4800],
];

const PRECEDENCE_ROWS = [
  {
    label: 'compiled-default',
    buildCase(tier, documentedTimeout) {
      return {
        tier,
        state: makeState(),
        settings: null,
        expected: documentedTimeout,
        fallbackExpected: documentedTimeout,
      };
    },
  },
  {
    label: 'pickle_settings.tier_caps',
    buildCase(tier, documentedTimeout) {
      return {
        tier,
        state: makeState(),
        settings: {
          schema_version: 2,
          tier_caps: {
            [tier]: { worker_timeout_seconds: documentedTimeout + 17 },
          },
        },
        expected: documentedTimeout + 17,
        fallbackExpected: documentedTimeout,
      };
    },
  },
  {
    label: 'state.flags.tier_cap_override',
    buildCase(tier, documentedTimeout) {
      return {
        tier,
        state: makeState({
          flags: {
            tier_cap_override: {
              [tier]: { worker_timeout_seconds: documentedTimeout + 29 },
            },
          },
        }),
        settings: {
          schema_version: 2,
          tier_caps: {
            [tier]: { worker_timeout_seconds: documentedTimeout + 17 },
          },
        },
        expected: documentedTimeout + 29,
        fallbackExpected: documentedTimeout + 17,
      };
    },
  },
];

describe.each ??= function each(rows) {
  return function runEach(_title, suite) {
    for (const row of rows) {
      describe(row.label, () => suite(row));
    }
  };
};

describe.each(PRECEDENCE_ROWS)('worker timeout tier budget precedence', ({ label, buildCase }) => {
  it('builds fresh fixtures per suite row', () => {
    const left = buildCase('medium', 2400);
    const right = buildCase('medium', 2400);

    assert.notStrictEqual(left.state, right.state);
    if (left.settings !== null || right.settings !== null) {
      assert.notStrictEqual(left.settings, right.settings);
    }
  });

  for (const [tier, documentedTimeout] of TIER_ROWS) {
    it(`${tier} resolves to the documented timeout for ${label}`, () => {
      const active = buildCase(tier, documentedTimeout);
      const resolved = getTicketTierBudgetWithOverrides(active.state, tier, active.settings);
      assert.equal(resolved.worker_timeout_seconds, active.expected);

      const fallback = label === 'compiled-default'
        ? getTicketTierBudgetWithOverrides(makeState(), tier, null)
        : label === 'pickle_settings.tier_caps'
          ? getTicketTierBudgetWithOverrides(makeState(), tier, null)
          : getTicketTierBudgetWithOverrides(makeState(), tier, active.settings);

      assert.equal(fallback.worker_timeout_seconds, active.fallbackExpected);
    });
  }
});
