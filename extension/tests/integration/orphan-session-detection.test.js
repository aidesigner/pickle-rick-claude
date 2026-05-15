// @tier: integration
/**
 * R-CCPM-3: orphan-session detection at iteration boundary
 *
 * Verifies that detectOrphanSessions:
 *  (a) fires exactly once for a synthetic orphan with parent_session_hash
 *  (b) dedups — 3 iterations with same orphan → 1 event total
 *  (c) does NOT fire for a concurrent legitimate session (no parent_session_hash)
 *  (d) schema migration: reading an old-format state.json yields orphans_detected=[]
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { detectOrphanSessions } from '../../bin/mux-runner.js';
import { StateManager } from '../../services/state-manager.js';

const sm = new StateManager();

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/fake/working/dir',
    step: 'pickle',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/fake/session',
    schema_version: 4,
    ...overrides,
  };
}

function writeFakeSession(dataRoot, sessionName, stateOverrides) {
  const sessionDir = path.join(dataRoot, 'sessions', sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateData = makeState({ session_dir: sessionDir, ...stateOverrides });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(stateData));
  return sessionDir;
}

test('orphan-session-detection: synthetic orphan with parent_session_hash fires exactly 1 result', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-test-'));
  const parentSessionDir = writeFakeSession(dataRoot, 'parent-session', {
    working_dir: '/proj/myapp',
    orphans_detected: [],
    parent_session_hash: null,
    invocation_source: 'operator',
    pid: process.pid,
  });
  const orphanSessionDir = writeFakeSession(dataRoot, 'orphan-session', {
    working_dir: '/proj/myapp',
    parent_session_hash: 'abc12345',
    invocation_source: 'manager_subprocess',
    pid: 99999,
    start_time_epoch: 1747350000,
  });

  try {
    const parentState = sm.read(path.join(parentSessionDir, 'state.json'));
    const results = detectOrphanSessions(parentState, dataRoot, parentSessionDir);

    assert.equal(results.length, 1, 'exactly one orphan detected');
    assert.equal(results[0].orphan_session_path, orphanSessionDir);
    assert.equal(results[0].parent_session_hash, 'abc12345');
    assert.equal(results[0].orphan_pid, 99999);
    assert.equal(results[0].orphan_started_at, 1747350000);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan-session-detection: dedup — 3 runs with same orphan → 1 result total', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-dedup-'));
  const parentStatePath = path.join(dataRoot, 'sessions', 'parent-session', 'state.json');
  const parentSessionDir = writeFakeSession(dataRoot, 'parent-session', {
    working_dir: '/proj/myapp',
    orphans_detected: [],
    parent_session_hash: null,
    invocation_source: 'operator',
    pid: process.pid,
  });
  writeFakeSession(dataRoot, 'orphan-session', {
    working_dir: '/proj/myapp',
    parent_session_hash: 'deadbeef',
    invocation_source: 'manager_subprocess',
    pid: 77777,
  });

  try {
    let parentState = sm.read(parentStatePath);
    let totalResults = 0;

    for (let i = 0; i < 3; i++) {
      const results = detectOrphanSessions(parentState, dataRoot, parentSessionDir);
      totalResults += results.length;

      if (results.length > 0) {
        // Simulate what mux-runner does: append to orphans_detected and re-read state
        parentState = sm.update(parentStatePath, s => {
          if (!Array.isArray(s.orphans_detected)) s.orphans_detected = [];
          for (const orphan of results) {
            const basename = path.basename(orphan.orphan_session_path);
            if (!s.orphans_detected.includes(basename)) {
              s.orphans_detected.push(basename);
            }
          }
        });
      }
    }

    assert.equal(totalResults, 1, 'dedup: only 1 result across 3 detection runs');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan-session-detection: concurrent legitimate session (no parent_session_hash) → 0 results', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-legit-'));
  const parentSessionDir = writeFakeSession(dataRoot, 'parent-session', {
    working_dir: '/proj/myapp',
    orphans_detected: [],
    parent_session_hash: null,
    invocation_source: 'operator',
  });
  // Legitimate concurrent operator session — no parent_session_hash, no manager_subprocess invocation_source
  writeFakeSession(dataRoot, 'legit-sibling', {
    working_dir: '/proj/myapp',
    parent_session_hash: null,
    invocation_source: 'operator',
  });

  try {
    const parentState = sm.read(path.join(parentSessionDir, 'state.json'));
    const results = detectOrphanSessions(parentState, dataRoot, parentSessionDir);

    assert.equal(results.length, 0, 'legitimate session must not trigger orphan detection');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan-session-detection: schema migration fills orphans_detected=[] on old-format state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-migrate-'));
  const statePath = path.join(dir, 'state.json');
  // Old-format state: schema_version missing, no new fields
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: '/proj/myapp',
    step: 'pickle',
    iteration: 0,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1700000000,
    completion_promise: null,
    original_prompt: 'old session',
    current_ticket: null,
    history: [],
    started_at: '2025-01-01T00:00:00.000Z',
    session_dir: dir,
  }));

  try {
    const state = sm.read(statePath);
    assert.deepEqual(state.orphans_detected, [], 'schema migration must set orphans_detected to []');
    assert.equal(state.parent_session_hash, null, 'schema migration must set parent_session_hash to null');
    assert.equal(state.invocation_source, 'operator', 'schema migration must set invocation_source to operator');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
