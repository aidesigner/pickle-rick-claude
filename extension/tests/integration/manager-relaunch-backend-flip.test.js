// @tier: integration
// AC-XBL-08 — Regression test: state.backend=codex yields shouldRelaunch:true;
// mutating to state.backend=claude yields shouldRelaunch:false, reason:'not_codex'.
// ZERO production-code change (R-XBL-4 was dropped — behavior already shipped at
// codex-manager-relaunch.ts:69, mux-runner.ts:2078-2086 + :3206-3212).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateCodexManagerRelaunch } from '../../services/codex-manager-relaunch.js';
import { StateManager } from '../../services/state-manager.js';

function makeTmpDir(prefix = 'pickle-xbl08-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PENDING_TICKETS = [
  { id: 'ticket-001', status: 'Todo', title: 'Pending work', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: 'ticket-002', status: 'Done', title: 'Already done', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function withCleanEnv(fn) {
  const prevRefinement = process.env.PICKLE_REFINEMENT_LOCK;
  const prevBackend = process.env.PICKLE_BACKEND;
  try {
    delete process.env.PICKLE_REFINEMENT_LOCK;
    delete process.env.PICKLE_BACKEND;
    return fn();
  } finally {
    if (prevRefinement === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
    else process.env.PICKLE_REFINEMENT_LOCK = prevRefinement;
    if (prevBackend === undefined) delete process.env.PICKLE_BACKEND;
    else process.env.PICKLE_BACKEND = prevBackend;
  }
}

function makeState(overrides = {}) {
  return {
    active: true,
    backend: 'codex',
    working_dir: '/tmp/test-repo',
    iteration: 1,
    max_iterations: 5,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 720,
    schema_version: 1,
    codex_manager_relaunch_count: 0,
    original_prompt: 'manager-relaunch-backend-flip regression fixture',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    ...overrides,
  };
}

test('AC-XBL-08: manager-relaunch-backend-flip — codex backend yields shouldRelaunch:true', () => {
  withCleanEnv(() => {
    const state = makeState({ backend: 'codex' });
    const decision = evaluateCodexManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(decision.shouldRelaunch, true, 'state.backend=codex with pending tickets must trigger relaunch');
    assert.equal(decision.reason, 'eligible', 'reason must be eligible for codex with pending work');
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — mutating to claude yields shouldRelaunch:false reason:not_codex', () => {
  withCleanEnv(() => {
    const state = makeState({ backend: 'claude' });
    const decision = evaluateCodexManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(decision.shouldRelaunch, false, 'state.backend=claude must not trigger codex relaunch');
    assert.equal(decision.reason, 'not_codex', 'reason must be not_codex when backend is claude');
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — sequential flip: codex→true then claude→false', () => {
  // Core regression: single state object mutated between decisions, same ticket list.
  // Locks in codex-manager-relaunch.ts:69 behavior.
  withCleanEnv(() => {
    const state = makeState({ backend: 'codex' });

    const first = evaluateCodexManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(first.shouldRelaunch, true, 'first decision (codex) must shouldRelaunch');
    assert.equal(first.reason, 'eligible', 'first decision reason must be eligible');

    state.backend = 'claude';

    const second = evaluateCodexManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(second.shouldRelaunch, false, 'second decision (claude) must not shouldRelaunch');
    assert.equal(second.reason, 'not_codex', 'second decision reason must be not_codex');
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — state-file-backed: StateManager read path', () => {
  // Verifies the real dispatch path: state read via StateManager then evaluated.
  const tmpDir = makeTmpDir();
  try {
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');

    const sm = new StateManager();

    fs.writeFileSync(statePath, JSON.stringify(makeState({ backend: 'codex', working_dir: sessionDir, session_dir: sessionDir }), null, 2));

    withCleanEnv(() => {
      const codexState = sm.read(statePath);
      const first = evaluateCodexManagerRelaunch(codexState, PENDING_TICKETS, null);
      assert.equal(first.shouldRelaunch, true, 'state-file codex backend must shouldRelaunch');
      assert.equal(first.reason, 'eligible');
    });

    sm.update(statePath, s => { s.backend = 'claude'; });

    withCleanEnv(() => {
      const claudeState = sm.read(statePath);
      const second = evaluateCodexManagerRelaunch(claudeState, PENDING_TICKETS, null);
      assert.equal(second.shouldRelaunch, false, 'state-file claude backend must not shouldRelaunch');
      assert.equal(second.reason, 'not_codex');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
