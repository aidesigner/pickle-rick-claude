// @tier: fast
//
// R-ORSR-1: Recovery type/schema foundation + terminal disposition table.
// INV-RECOVERY-EXHAUSTED-IS-FAILURE: recovery_exhausted is a failure exit (stops
//   auto-resume.sh R-CNAR-4(c)) and NOT a halt exit.
// Back-compat: v5 state without recovery_attempts normalizes to [] via
//   normalizeV5StateDefaults; LATEST_SCHEMA_VERSION stays at 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('INV-RECOVERY-EXHAUSTED-IS-FAILURE: isFailureExit(recovery_exhausted) === true', async () => {
  const { isFailureExit } = await import('../bin/mux-runner.js');
  assert.equal(isFailureExit('recovery_exhausted'), true,
    'recovery_exhausted must be a failure exit (stops auto-resume.sh)');
});

test('INV-RECOVERY-EXHAUSTED-IS-FAILURE: isHaltExit(recovery_exhausted) === false', async () => {
  const { isHaltExit } = await import('../bin/mux-runner.js');
  assert.equal(isHaltExit('recovery_exhausted'), false,
    'recovery_exhausted must NOT be a halt exit (it is fatal, not deferrable)');
});

test('R-ORSR-1 back-compat: v5 state without recovery_attempts normalizes to []', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const { LATEST_SCHEMA_VERSION } = await import('../types/index.js');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'orsr1-bc-'));
  try {
    assert.equal(LATEST_SCHEMA_VERSION, 5, 'LATEST_SCHEMA_VERSION must stay at 5 (no schema bump for R-ORSR-1)');

    const raw = {
      schema_version: 5,
      active: false,
      working_dir: tmpD,
      step: 'research',
      iteration: 0,
      max_iterations: 15,
      max_time_minutes: 0,
      worker_timeout_seconds: 3600,
      start_time_epoch: Date.now(),
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: tmpD,
      tmux_mode: false,
      backend: 'claude',
      flags: {},
      activity: [],
      // Deliberately absent: recovery_attempts
    };
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(raw, null, 2));

    const sm = new StateManager();
    const state = sm.read(sp);
    assert.ok(Array.isArray(state.recovery_attempts),
      'recovery_attempts must be an array after read (schema-neutral v5 default)');
    assert.deepEqual(state.recovery_attempts, [],
      'recovery_attempts must default to [] when absent from state.json');
    assert.equal(LATEST_SCHEMA_VERSION, 5,
      'LATEST_SCHEMA_VERSION must remain 5 after reading a state with recovery_attempts defaulted');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test('R-ORSR-1 back-compat: existing recovery_attempts entries are preserved', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'orsr1-pres-'));
  try {
    const existing = [
      { strategy: 'reset_no_progress_counter', outcome: 'failed', reason: 'counter reset but no progress', iteration: 3 },
    ];
    const raw = {
      schema_version: 5,
      active: false,
      working_dir: tmpD,
      step: 'research',
      iteration: 0,
      max_iterations: 15,
      max_time_minutes: 0,
      worker_timeout_seconds: 3600,
      start_time_epoch: Date.now(),
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: tmpD,
      tmux_mode: false,
      backend: 'claude',
      flags: {},
      activity: [],
      recovery_attempts: existing,
    };
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(raw, null, 2));

    const sm = new StateManager();
    const state = sm.read(sp);
    assert.deepEqual(state.recovery_attempts, existing,
      'populated recovery_attempts must survive migration untouched');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});
