// @tier: integration
/**
 * state-corruption.test.js — PINNED, non-disjunctive corruption oracles for StateManager.read().
 *
 * These tests document SHIPPED behavior. There is intentionally NO "recovers OR fails closed"
 * disjunction: each fixture maps to exactly one outcome.
 *   (a) truncated state.json WITH a recoverable dead-pid tmp sibling -> promotion succeeds,
 *       returned state matches the tmp snapshot, no tmp litter remains.
 *   (b) garbage state.json, NO tmp -> readRecoverableJsonObject returns null AND StateManager.read
 *       surfaces the StateError family (code 'CORRUPT'). NEVER a silent default state.
 *
 * Escalate any divergence as a NEW ticket — do not "fix" the contract here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StateManager } from '../../../services/state-manager.js';
import { StateError } from '../../../types/index.js';
import { readRecoverableJsonObject } from '../../../services/recoverable-json.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chaos-corrupt-'));
}

// A snapshot that satisfies isRecoverableStateSnapshotCandidate (state-manager.ts:496).
function mkState(extra = {}) {
  return {
    active: false,
    working_dir: '/tmp/chaos',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'chaos-corruption',
    current_ticket: null,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    session_dir: '/tmp/chaos',
    schema_version: 1,
    ...extra,
  };
}

// -------------------------------------------------------------------------
// Oracle (a): truncated base + recoverable dead-pid tmp -> promotion succeeds
// -------------------------------------------------------------------------

test('truncated state.json WITH recoverable tmp sibling promotes; returned state matches tmp', { timeout: 60_000 }, () => {
  const dir = tmpDir();
  try {
    const statePath = path.join(dir, 'state.json');

    // Truncated/invalid base JSON (mid-write crash residue).
    fs.writeFileSync(statePath, '{"active": tru');

    // Dead-pid tmp sibling carrying the recoverable snapshot. 99999999 is not a live pid,
    // so shouldSkipLiveTmp() returns false and the snapshot is eligible for promotion.
    const tmpSnapshot = mkState({ original_prompt: 'TMP-RECOVERED', iteration: 7 });
    const tmpSibling = path.join(dir, 'state.json.tmp.99999999');
    fs.writeFileSync(tmpSibling, JSON.stringify(tmpSnapshot, null, 2));

    const sm = new StateManager();
    const recovered = sm.read(statePath);

    // PINNED: the promoted tmp content, not a default state.
    assert.equal(recovered.original_prompt, 'TMP-RECOVERED', 'returned state must come from the tmp snapshot');
    assert.equal(recovered.iteration, 7, 'tmp iteration must be promoted');

    // state.json now holds the promoted snapshot (valid JSON with the marker).
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(onDisk.original_prompt, 'TMP-RECOVERED', 'on-disk state.json must be the promoted snapshot');

    // No tmp litter survives recovery.
    const litter = fs.readdirSync(dir).filter((e) => e.startsWith('state.json.tmp.'));
    assert.deepEqual(litter, [], `no state.json.tmp.* litter expected, found: ${litter.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// Oracle (b): garbage base + NO tmp -> StateError family, never default state
// -------------------------------------------------------------------------

test('garbage state.json with NO tmp surfaces StateError family — never a default state', { timeout: 60_000 }, () => {
  const dir = tmpDir();
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, 'this is not json at all {{{ ');

    // Source of the null that callers map into the StateError family (recoverable-json.ts:98).
    assert.equal(
      readRecoverableJsonObject(statePath),
      null,
      'readRecoverableJsonObject must return null for garbage base with no recoverable tmp',
    );

    // The StateManager caller surfaces a StateError — it must NOT return a default/synthesized state.
    const sm = new StateManager();
    let returned;
    assert.throws(
      () => { returned = sm.read(statePath); },
      (err) => {
        assert.ok(err instanceof StateError, `expected StateError family, got ${err && err.name}`);
        assert.equal(err.code, 'CORRUPT', `expected code CORRUPT, got ${err && err.code}`);
        return true;
      },
      'read() must throw the StateError family on garbage with no tmp',
    );
    assert.equal(returned, undefined, 'read() must NOT return a (default) state object');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
