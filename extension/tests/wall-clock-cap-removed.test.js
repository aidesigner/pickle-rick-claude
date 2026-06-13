// @tier: fast
//
// W5a (ticket 6e81cd21) — regression lock for p2-remove-pipeline-wall-clock-time-cap.
//
// The wall-clock cap is DEFAULT-OFF: a fresh session writes no `max_time_minutes`, and every
// enforcement site treats absent/`0` as "no cap". This suite is the 4h-reset / 30-min-budget
// repro: with no cap, a 13h-elapsed session does NOT exit `limit`/false-success — the iteration
// cap and per-worker timeouts remain the only bounds. The opt-in path (operator-set cap) is
// preserved. If a future change re-introduces a default cap or re-clamps the rate-limit wait by
// remaining budget, these assertions trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateManagerRelaunch } from '../services/manager-relaunch.js';
import { Defaults } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETUP_TS = path.join(REPO_ROOT, 'extension', 'src', 'bin', 'setup.ts');
const PICKLE_SETTINGS = path.join(REPO_ROOT, 'pickle_settings.json');

const HOUR_SEC = 3600;
const pendingTickets = [
  { id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: 'pending', status: 'Todo', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function stateFixture(overrides = {}) {
  return {
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 100,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    working_dir: process.cwd(),
    backend: 'claude',
    manager_relaunch_count: 0,
    schema_version: 3,
    ...overrides,
  };
}

// --- Test A: no cap (absent OR 0) never produces a time_limit relaunch exit, even at 13h elapsed.
test('wall-clock cap absent: 13h-elapsed session does NOT exit time_limit (no false-success)', () => {
  const state = stateFixture({ start_time_epoch: Math.floor(Date.now() / 1000) - 13 * HOUR_SEC });
  delete state.max_time_minutes;
  const decision = evaluateManagerRelaunch(state, pendingTickets, null);
  assert.notEqual(decision.reason, 'time_limit', 'absent cap must not trip the wall-clock exit');
  assert.equal(decision.shouldRelaunch, true);
  assert.equal(decision.reason, 'eligible');
});

test('wall-clock cap = 0: 13h-elapsed session does NOT exit time_limit', () => {
  const state = stateFixture({
    max_time_minutes: 0,
    start_time_epoch: Math.floor(Date.now() / 1000) - 13 * HOUR_SEC,
  });
  const decision = evaluateManagerRelaunch(state, pendingTickets, null);
  assert.notEqual(decision.reason, 'time_limit');
  assert.equal(decision.shouldRelaunch, true);
});

// --- Test B: with the cap off, the iteration/relaunch cap remains the bound.
test('iteration cap still bounds the run when the wall-clock cap is off', () => {
  const state = stateFixture({
    manager_relaunch_count: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP,
    start_time_epoch: Math.floor(Date.now() / 1000) - 13 * HOUR_SEC,
  });
  delete state.max_time_minutes;
  const decision = evaluateManagerRelaunch(state, pendingTickets, null);
  assert.equal(decision.shouldRelaunch, false);
  assert.equal(decision.reason, 'cap_exceeded', 'the relaunch cap, not a wall clock, is the bound');
  assert.equal(decision.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
});

// --- Test C: the opt-in path is preserved — an operator-set cap still enforces.
test('opt-in cap still enforces: explicit 120-min cap, 3h elapsed exits time_limit', () => {
  const state = stateFixture({
    max_time_minutes: 120,
    start_time_epoch: Math.floor(Date.now() / 1000) - 3 * HOUR_SEC,
  });
  const decision = evaluateManagerRelaunch(state, pendingTickets, null);
  assert.equal(decision.reason, 'time_limit', 'explicit cap past elapsed must still exit');
  assert.equal(decision.shouldRelaunch, false);
});

test('opt-in cap not yet reached does NOT exit time_limit', () => {
  const state = stateFixture({
    max_time_minutes: 720,
    start_time_epoch: Math.floor(Date.now() / 1000) - 1 * HOUR_SEC,
  });
  const decision = evaluateManagerRelaunch(state, pendingTickets, null);
  assert.notEqual(decision.reason, 'time_limit');
  assert.equal(decision.shouldRelaunch, true);
});

// --- Test D: no default is written at setup, and the no-cap event is emitted (AC-NTC-01/09 landed).
test('setup.ts writes no default cap and emits time_cap_disabled_default; settings carry no default', () => {
  const setupSrc = fs.readFileSync(SETUP_TS, 'utf8');
  assert.ok(
    !setupSrc.includes('default_max_time_minutes'),
    'setup.ts must not reference default_max_time_minutes (no default cap written)',
  );
  assert.ok(
    setupSrc.includes("event: 'time_cap_disabled_default'"),
    'fresh no-cap session must emit time_cap_disabled_default',
  );
  assert.ok(
    setupSrc.includes("config.explicitFlags.has('max-time')"),
    'max_time_minutes must be written only when the operator passes --max-time',
  );

  const settings = JSON.parse(fs.readFileSync(PICKLE_SETTINGS, 'utf8'));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(settings, 'default_max_time_minutes'),
    'pickle_settings.json must not carry a default_max_time_minutes',
  );
});
