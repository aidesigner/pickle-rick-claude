// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getTicketTierBudgetWithOverrides } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const stateTypesPath = path.join(extensionRoot, 'src', 'types', 'index.ts');
const claudePath = path.join(extensionRoot, 'CLAUDE.md');

function extractStateFields(source) {
  const match = source.match(/export interface State \{([\s\S]*?)\n\}/);
  assert.ok(match, 'State interface exists');
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((field) => field[1]);
}

function extractFieldInvariantSection(source) {
  const match = source.match(/## state\.json Field Invariants\n\n([\s\S]*?)(?:\n## |\n?$)/);
  assert.ok(match, 'state.json Field Invariants section exists');
  return match[1];
}

test('AC-BUNDLE-17: trap-door entries stay under 1500 chars', () => {
  const claude = fs.readFileSync(claudePath, 'utf8');
  const overlong = claude
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith('- `') && line.length > 1500);

  assert.deepEqual(overlong, []);
});

test('AC-BUNDLE-17: every State field has exactly one field invariant', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  const claude = fs.readFileSync(claudePath, 'utf8');
  const fields = extractStateFields(stateSource);
  const section = extractFieldInvariantSection(claude);

  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = section.match(new RegExp(`INVARIANT: \`${escaped}\``, 'g')) ?? [];
    assert.equal(matches.length, 1, `${field} must appear in exactly one INVARIANT clause`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// R-CNAR-1: ticket-tier-budget override-precedence invariants.
// state.flags.tier_cap_override.<tier>.<field> wins over
// pickle_settings.tier_caps.<tier>.<field>, which wins over
// the compiled-in TICKET_TIER_BUDGETS defaults. Per-field merging is
// independent so a partial override never cascade-zeroes the other field.
// ──────────────────────────────────────────────────────────────────────────

test('R-CNAR-1 ticket-tier-budget invariant: state.flags > pickle_settings.tier_caps > defaults', () => {
  const settings = {
    schema_version: 2,
    tier_caps: {
      medium: { max_iterations: 50, worker_timeout_seconds: 5000 },
    },
  };
  const stateOverride = {
    flags: { tier_cap_override: { medium: { max_iterations: 77 } } },
  };

  // 1) defaults only (state=null, settings=null)
  assert.deepEqual(
    getTicketTierBudgetWithOverrides(null, 'medium', null),
    { tier: 'medium', max_iterations: 30, worker_timeout_seconds: 20 * 60 },
  );

  // 2) settings beats defaults (state=null)
  assert.deepEqual(
    getTicketTierBudgetWithOverrides(null, 'medium', settings),
    { tier: 'medium', max_iterations: 50, worker_timeout_seconds: 5000 },
  );

  // 3) state.flags beats settings on the field it sets, settings wins on the
  //    field state.flags omits.
  assert.deepEqual(
    getTicketTierBudgetWithOverrides(stateOverride, 'medium', settings),
    { tier: 'medium', max_iterations: 77, worker_timeout_seconds: 5000 },
  );
});

test('R-CNAR-1 ticket-tier-budget invariant: pickle_settings.schema_version v1 and v2 are both honored', () => {
  const v1 = { tier_caps: { large: { max_iterations: 90 } } }; // no schema_version
  const v2 = { schema_version: 2, tier_caps: { large: { max_iterations: 90 } } };
  const expected = { tier: 'large', max_iterations: 90, worker_timeout_seconds: 80 * 60 };
  assert.deepEqual(getTicketTierBudgetWithOverrides(null, 'large', v1), expected);
  assert.deepEqual(getTicketTierBudgetWithOverrides(null, 'large', v2), expected);
});

test('R-CNAR-1 ticket-tier-budget invariant: documented in extension/CLAUDE.md trap-door', () => {
  const claude = fs.readFileSync(claudePath, 'utf8');
  // Trap-door bullet must reference the canonical accessor name and the
  // override-precedence chain so future readers cannot miss it.
  assert.match(
    claude,
    /getTicketTierBudgetWithOverrides[\s\S]*tier_cap_override[\s\S]*tier_caps[\s\S]*TICKET_TIER_BUDGETS/,
    'extension/CLAUDE.md must document the tier-cap override precedence chain',
  );
});
