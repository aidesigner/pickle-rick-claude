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
  // Only top-level fields (single 2-space indent). Nested object-literal
  // field types (e.g. `last_between_ticket_gate: { ts: number; ... }`) live
  // at deeper indents and are not part of the State surface area that the
  // invariant catalog documents.
  return [...match[1].matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((field) => field[1]);
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

test('worker_backend invariant: optional field is documented and typed as an optional backend override', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  const claude = fs.readFileSync(claudePath, 'utf8');

  assert.match(stateSource, /worker_backend\?: Backend;/);
  assert.match(
    claude,
    /INVARIANT: `worker_backend` is the optional worker-spawn backend override; worker spawns prefer it over `backend` when present/,
  );
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
    { tier: 'medium', max_iterations: 30, worker_timeout_seconds: 40 * 60 },
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

// ---------------------------------------------------------------------------
// R-MDS-6: monitor_panes field invariant
// ---------------------------------------------------------------------------

test('R-MDS-6: monitor_panes field exists in State interface', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  assert.match(
    stateSource,
    /monitor_panes\?:\s*\{[^}]*producer_done:\s*boolean[^}]*\}\[\]/,
    'State must declare monitor_panes?: { producer_done: boolean }[]',
  );
});

test('R-MDS-6: monitor_panes missing field on read defaults to false (safe crash recovery)', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const os = await import('node:os');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-mds6-'));
  try {
    const sm = new StateManager();
    const sp = path.join(tmpD, 'state.json');
    // Raw state without monitor_panes — simulates missing field on read
    fs.writeFileSync(sp, JSON.stringify({
      active: false,
      working_dir: tmpD,
      step: 'prd',
      iteration: 1,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Date.now(),
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: tmpD,
      schema_version: 3,
    }, null, 2));

    const state = sm.read(sp);
    assert.ok(Array.isArray(state.monitor_panes), 'monitor_panes must be initialized by migration');
    assert.equal(state.monitor_panes.length, 4, 'must have 4 pane entries');
    assert.ok(
      state.monitor_panes.every((p) => p.producer_done === false),
      'crash-recovery default must be false — no false-suppression of warnings',
    );
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test('R-MDS-6: monitor_panes INVARIANT documented in extension/CLAUDE.md', () => {
  const claude = fs.readFileSync(claudePath, 'utf8');
  assert.match(
    claude,
    /INVARIANT: `monitor_panes`/,
    'extension/CLAUDE.md must document the monitor_panes field invariant',
  );
});

// ---------------------------------------------------------------------------
// R-CCPM-WH-3: schema v4 field invariants
// orphans_detected, parent_session_hash, invocation_source
// ---------------------------------------------------------------------------

function makeV3RawState(dir) {
  return {
    active: false,
    working_dir: dir,
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 2400,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
  };
}

test('R-CCPM-WH-3: orphans_detected defaults to [] on v3→v4 migration', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const os = await import('node:os');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-ccpm-a-'));
  try {
    const sm = new StateManager();
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(makeV3RawState(tmpD), null, 2));
    const state = sm.read(sp);
    assert.ok(Array.isArray(state.orphans_detected), 'orphans_detected must be an array after migration');
    assert.deepEqual(state.orphans_detected, [], 'orphans_detected default must be []');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test('R-CCPM-WH-3: parent_session_hash defaults to null on v3→v4 migration', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const os = await import('node:os');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-ccpm-b-'));
  try {
    const sm = new StateManager();
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(makeV3RawState(tmpD), null, 2));
    const state = sm.read(sp);
    assert.equal(state.parent_session_hash, null, 'parent_session_hash must be null for operator-launched sessions');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test("R-CCPM-WH-3: invocation_source defaults to 'operator' and accepts 'manager_subprocess'", async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const os = await import('node:os');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-ccpm-c-'));
  try {
    const sm = new StateManager();
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(makeV3RawState(tmpD), null, 2));
    const defaultState = sm.read(sp);
    assert.equal(defaultState.invocation_source, 'operator', "invocation_source must default to 'operator'");

    sm.update(sp, (s) => { s.invocation_source = 'manager_subprocess'; });
    const updatedState = sm.read(sp);
    assert.equal(updatedState.invocation_source, 'manager_subprocess', "invocation_source must accept 'manager_subprocess'");
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test('R-CCPM-WH-3: all three v4 fields survive a write→read round-trip via StateManager.update()', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const os = await import('node:os');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-ccpm-d-'));
  try {
    const sm = new StateManager();
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(makeV3RawState(tmpD), null, 2));
    // migrate first
    sm.read(sp);

    sm.update(sp, (s) => {
      s.orphans_detected = ['sess-abc'];
      s.parent_session_hash = 'deadbeef';
      s.invocation_source = 'manager_subprocess';
    });

    const state = sm.read(sp);
    assert.deepEqual(state.orphans_detected, ['sess-abc'], 'orphans_detected must survive round-trip');
    assert.equal(state.parent_session_hash, 'deadbeef', 'parent_session_hash must survive round-trip');
    assert.equal(state.invocation_source, 'manager_subprocess', 'invocation_source must survive round-trip');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});
