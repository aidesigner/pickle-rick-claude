// @tier: fast
//
// W1a (ticket 34b4d4e5): collapse quality-gate skip-flags to ONE skip surface.
// Asserts the W1a invariants:
//   1. single operator-facing bypass surface (no legacy write/instruction strings
//      in mux-runner source; the unified flag is present)
//   2. bundle-bootstrap exemption writes the unified flag (consolidation ON) and
//      retains the legacy dual-write under the kill-switch (=off)
//   3. legacy auto-migrate (StateManager.read promotes legacy → unified, drops legacy)
//   4. --skip-ac-shape-gate folds into the unified surface
//   5. skip_smoke_gate_reason stays a SEPARATE flag (ruling 2)
//   6. both-present conflict rule (unified wins)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../services/state-manager.js';
import { LATEST_SCHEMA_VERSION } from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';
import { runAcShapeEnforcement } from '../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const MUX_SRC = fs.readFileSync(path.join(SRC_ROOT, 'bin', 'mux-runner.ts'), 'utf-8');
const SM_SRC = fs.readFileSync(path.join(SRC_ROOT, 'services', 'state-manager.ts'), 'utf-8');

function tmpDir(prefix = 'one-skip-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  const dataRoot = tmpDir('one-skip-data-');
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn(dataRoot);
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// A manifest that FAILS ac-shape enforcement (a smell with no matching ticket
// → violation → runAcShapeEnforcement returns 2) UNLESS it is bypassed.
function failingManifest() {
  return {
    prd_path: '/tmp/prd.md',
    refinement_dir: '/tmp/ref',
    all_success: true,
    cycles_requested: 1,
    cycles_completed: 1,
    max_turns_per_worker: 10,
    ac_shape_smells: [{ ac_id: 'AC-NEEDS-SPLIT' }],
    tickets: [],
    workers: [],
    completed_at: new Date().toISOString(),
  };
}

function writeSessionState(sessionDir, flags) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const state = makeState(flags);
  state.session_dir = sessionDir;
  writeStateFile(path.join(sessionDir, 'state.json'), state);
}

// ---------------------------------------------------------------------------
// 1. Single operator-facing bypass surface
// ---------------------------------------------------------------------------
test('single operator-facing bypass surface: no legacy write/instruction strings', () => {
  // Operator-facing WRITE instructions name the unified flag only.
  assert.equal(
    MUX_SRC.includes('set state.flags.skip_readiness_reason in state.json'),
    false,
    'readiness halt banner must instruct the unified flag, not skip_readiness_reason',
  );
  assert.equal(
    MUX_SRC.includes('set state.flags.skip_ticket_audit_reason in state.json'),
    false,
    'ticket-audit halt banner must instruct the unified flag, not skip_ticket_audit_reason',
  );
  // The skip-log lines name the unified flag.
  assert.equal(
    MUX_SRC.includes('skipped via state.flags.skip_quality_gates_reason'),
    true,
  );
  assert.equal(
    MUX_SRC.includes('bypassed via state.flags.skip_quality_gates_reason'),
    true,
  );
  // The unified flag is the one surface present.
  assert.ok(MUX_SRC.includes('skip_quality_gates_reason'));
});

// ---------------------------------------------------------------------------
// 2. Bundle-bootstrap writes unified (ON) and dual legacy (kill-switch off)
// ---------------------------------------------------------------------------
test('bundle-bootstrap exemption: consolidated path writes the unified flag, kill-switch retains legacy dual-write', () => {
  const block = MUX_SRC.slice(MUX_SRC.indexOf('R-BUNDLE-1 / W1a'));
  const bootstrapBlock = block.slice(0, block.indexOf('readinessGateChecked'));
  // Consolidated (recoveryConsolidationEnabled) branch assigns the unified flag.
  assert.ok(bootstrapBlock.includes('recoveryConsolidationEnabled()'));
  assert.ok(bootstrapBlock.includes('skip_quality_gates_reason: skipQualityGatesReason'));
  // Kill-switch branch retains the legacy dual-write.
  assert.ok(bootstrapBlock.includes('skip_readiness_reason: skipReadinessReason'));
  assert.ok(bootstrapBlock.includes('skip_ticket_audit_reason: skipTicketAuditReason'));
});

// ---------------------------------------------------------------------------
// 3. Legacy auto-migrate (StateManager.read promotes + drops legacy + warns)
// ---------------------------------------------------------------------------
test('legacy auto-migrate: StateManager.read promotes skip_readiness_reason into unified and drops legacy', () => {
  withDataRoot(() => {
    const dir = tmpDir('one-skip-migrate-');
    try {
      const statePath = path.join(dir, 'state.json');
      writeStateFile(statePath, makeState({ skip_readiness_reason: 'legacy-readiness' }));
      const read = new StateManager().read(statePath);
      assert.equal(read.flags.skip_quality_gates_reason, 'legacy-readiness', 'promoted to unified');
      assert.ok(!('skip_readiness_reason' in read.flags), 'legacy field dropped');
      assert.ok(!('skip_ticket_audit_reason' in read.flags));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. --skip-ac-shape-gate folds into the unified surface
// ---------------------------------------------------------------------------
test('AC-shape gate: explicit --skip-ac-shape-gate CLI flag bypasses (and would-fail manifest returns 0)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-cli-');
    try {
      writeSessionState(sessionDir, {});
      // No unified flag set; CLI flag drives the bypass.
      const code = runAcShapeEnforcement(failingManifest(), {
        sessionDir,
        skipAcShapeGate: 'operator: analyst tickets verified correct',
      });
      assert.equal(code, 0, 'CLI flag bypasses the AC-shape gate');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test('AC-shape gate: unified skip_quality_gates_reason folds in (no CLI flag, would-fail manifest returns 0)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-unified-');
    try {
      writeSessionState(sessionDir, { skip_quality_gates_reason: 'bundle_bootstrap_mode=test' });
      const code = runAcShapeEnforcement(failingManifest(), { sessionDir });
      assert.equal(code, 0, 'unified flag bypasses the AC-shape gate without the CLI flag');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test('AC-shape gate: armed when neither CLI flag nor unified flag is set (would-fail manifest returns 2)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-armed-');
    try {
      writeSessionState(sessionDir, {});
      const code = runAcShapeEnforcement(failingManifest(), { sessionDir });
      assert.equal(code, 2, 'gate stays armed when no bypass surface is set');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test('AC-shape gate: kill-switch off disables the unified fold-in (CLI flag only)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-killswitch-');
    const prev = process.env.PICKLE_RECOVERY_CONSOLIDATION;
    process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off';
    try {
      writeSessionState(sessionDir, { skip_quality_gates_reason: 'unified-should-be-ignored' });
      const code = runAcShapeEnforcement(failingManifest(), { sessionDir });
      assert.equal(code, 2, 'with kill-switch off, the unified flag does NOT bypass the AC-shape gate');
    } finally {
      if (prev === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION;
      else process.env.PICKLE_RECOVERY_CONSOLIDATION = prev;
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. skip_smoke_gate_reason stays SEPARATE (ruling 2)
// ---------------------------------------------------------------------------
test('skip_smoke_gate_reason stays a separate flag (not folded into the quality-gate surface)', () => {
  // The migration shim must NOT touch the smoke-gate flag.
  const shim = SM_SRC.slice(
    SM_SRC.indexOf('function migrateLegacySkipQualityGatesFlags'),
  );
  const shimBody = shim.slice(0, shim.indexOf('\n}\n'));
  assert.equal(
    shimBody.includes('skip_smoke_gate_reason'),
    false,
    'migrateLegacySkipQualityGatesFlags must not reference the smoke-gate flag',
  );
  // The unified read path must NOT fold in the smoke-gate flag.
  const resolver = MUX_SRC.slice(MUX_SRC.indexOf('function resolveQualityGateSkipReason'));
  const resolverBody = resolver.slice(0, resolver.indexOf('\n}\n'));
  assert.equal(
    resolverBody.includes('skip_smoke_gate_reason'),
    false,
    'resolveQualityGateSkipReason must not consult the smoke-gate flag',
  );
  // The smoke-gate flag is still read by its own (spark) gate.
  assert.ok(
    MUX_SRC.includes('skip_smoke_gate_reason'),
    'skip_smoke_gate_reason still exists as a distinct flag',
  );
});

// ---------------------------------------------------------------------------
// 6. Both-present conflict rule: unified wins
// ---------------------------------------------------------------------------
test('both-present conflict rule: unified flag wins, legacy dropped on read', () => {
  withDataRoot(() => {
    const dir = tmpDir('one-skip-conflict-');
    try {
      const statePath = path.join(dir, 'state.json');
      writeStateFile(
        statePath,
        makeState({ skip_quality_gates_reason: 'unified', skip_readiness_reason: 'legacy' }),
      );
      const read = new StateManager().read(statePath);
      assert.equal(read.flags.skip_quality_gates_reason, 'unified', 'unified preserved');
      assert.ok(!('skip_readiness_reason' in read.flags), 'legacy dropped (unified wins)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
