// @tier: fast
//
// R-QGSK-3: regression test for migrateLegacySkipQualityGatesFlags.
// Verifies that StateManager.read() promotes legacy per-gate skip flags
// into the unified skip_quality_gates_reason field and removes the legacy
// fields, per PRD AC-4 a..e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../services/state-manager.js';
import { LATEST_SCHEMA_VERSION } from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';

function tmpDir(prefix = 'sm-skip-flags-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Minimal valid state at LATEST_SCHEMA_VERSION so read() uses the >= 3
// migration branch (which calls migrateLegacySkipQualityGatesFlags).
function makeState(flagsOverride = {}) {
  return {
    active: false,
    working_dir: '/tmp/test',
    step: null,
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: LATEST_SCHEMA_VERSION,
    pipeline_continue_on_phase_fail: true,
    flags: flagsOverride,
  };
}

function withDataRoot(fn) {
  const dataRoot = tmpDir('sm-skip-flags-data-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC-4 a: only skip_readiness_reason set → promotes to unified, removes legacy
// ---------------------------------------------------------------------------

test('AC-4 a: skip_readiness_reason only → promoted to skip_quality_gates_reason', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({ skip_readiness_reason: 'operator pre-validated bundle' }));
      const sm = new StateManager();
      const state = sm.read(sp);
      assert.equal(
        state.flags?.skip_quality_gates_reason,
        'operator pre-validated bundle',
        'unified flag must be set to readiness reason',
      );
      assert.ok(
        !('skip_readiness_reason' in (state.flags ?? {})),
        'skip_readiness_reason must be removed from flags',
      );
      assert.ok(
        !('skip_ticket_audit_reason' in (state.flags ?? {})),
        'skip_ticket_audit_reason must be absent from flags',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 b: only skip_ticket_audit_reason set → promotes to unified
// ---------------------------------------------------------------------------

test('AC-4 b: skip_ticket_audit_reason only → promoted to skip_quality_gates_reason', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({ skip_ticket_audit_reason: 'manual audit' }));
      const sm = new StateManager();
      const state = sm.read(sp);
      assert.equal(
        state.flags?.skip_quality_gates_reason,
        'manual audit',
        'unified flag must be set to ticket-audit reason',
      );
      assert.ok(
        !('skip_readiness_reason' in (state.flags ?? {})),
        'skip_readiness_reason must be absent',
      );
      assert.ok(
        !('skip_ticket_audit_reason' in (state.flags ?? {})),
        'skip_ticket_audit_reason must be removed',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 c: BOTH legacy flags set → readiness wins; both legacy keys removed
// ---------------------------------------------------------------------------

test('AC-4 c: both legacy flags → readiness wins, both keys removed', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({
        skip_readiness_reason: 'readiness reason',
        skip_ticket_audit_reason: 'audit reason',
      }));
      const sm = new StateManager();
      const state = sm.read(sp);
      assert.equal(
        state.flags?.skip_quality_gates_reason,
        'readiness reason',
        'readiness reason must win when both legacy flags are present',
      );
      assert.ok(
        !('skip_readiness_reason' in (state.flags ?? {})),
        'skip_readiness_reason must be removed',
      );
      assert.ok(
        !('skip_ticket_audit_reason' in (state.flags ?? {})),
        'skip_ticket_audit_reason must be removed',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 d: unified already set + legacy flag present → unified preserved verbatim, legacy removed
// ---------------------------------------------------------------------------

test('AC-4 d: unified already set → preserved verbatim, legacy keys removed', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({
        skip_quality_gates_reason: 'explicit unified reason',
        skip_readiness_reason: 'stale legacy reason',
      }));
      const sm = new StateManager();
      const state = sm.read(sp);
      assert.equal(
        state.flags?.skip_quality_gates_reason,
        'explicit unified reason',
        'unified flag must not be overwritten by legacy value',
      );
      assert.ok(
        !('skip_readiness_reason' in (state.flags ?? {})),
        'stale legacy skip_readiness_reason must be removed',
      );
      assert.ok(
        !('skip_ticket_audit_reason' in (state.flags ?? {})),
        'skip_ticket_audit_reason must be absent',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 e: no skip flags at all → no-op (flags shape unchanged)
// ---------------------------------------------------------------------------

test('AC-4 e: no skip flags → migration is a no-op', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({ strict_teams: false }));
      const diskBefore = fs.readFileSync(sp, 'utf-8');
      const sm = new StateManager();
      const state = sm.read(sp);
      assert.ok(
        !('skip_quality_gates_reason' in (state.flags ?? {})),
        'skip_quality_gates_reason must not be added when no legacy flags present',
      );
      assert.ok(
        !('skip_readiness_reason' in (state.flags ?? {})),
        'skip_readiness_reason must not exist',
      );
      assert.ok(
        !('skip_ticket_audit_reason' in (state.flags ?? {})),
        'skip_ticket_audit_reason must not exist',
      );
      // Disk content must not have gained any skip_quality_gates_reason key
      const diskAfter = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.ok(
        !(diskAfter.flags?.skip_quality_gates_reason),
        'on-disk state must not have skip_quality_gates_reason after no-op migration',
      );
      void diskBefore; // consumed only for symmetry
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
