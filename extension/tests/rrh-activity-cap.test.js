// @tier: fast
/**
 * 84c209ae D2 — Bounded activity ring (B-PDBL D1).
 *
 * The phantom-Done backfill loop grew state.activity to 7021 entries / 1.9MB
 * heading for a 20MB freeze because there was no write-side ceiling. The fix
 * enforces state.activity.length <= 2000 via drop-oldest on EVERY write path,
 * exempting recovery events (`rate_limit_*`, `*_quarantined`,
 * `ticket_ladder_exhausted`) from eviction.
 *
 * Tests:
 *  - D2a: >2000 appends via the write path → length <= 2000 (drop-oldest, newest kept).
 *  - D2b: old exempt recovery events survive the cap (never evicted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeActivityEntry } from '../services/state-manager.js';

const ACTIVITY_RING_MAX = 2000;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeState(sessionDir, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'd2 activity cap test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    activity: [],
    ...overrides,
  }, null, 2));
  return statePath;
}

function readActivity(statePath) {
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(parsed.activity) ? parsed.activity : [];
}

function withSandbox(fn) {
  const dataRoot = tmpDir('pickle-d2-data-');
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  const sessionDir = path.join(dataRoot, 'sessions', 'sess');
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    fn(sessionDir);
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('D2a: >2000 appends are capped at 2000 via drop-oldest (newest survive)', () => {
  withSandbox((sessionDir) => {
    const statePath = writeState(sessionDir);
    const total = ACTIVITY_RING_MAX + 500; // 2500 appends
    for (let i = 0; i < total; i++) {
      writeActivityEntry(statePath, {
        event: 'iteration_start',
        ts: new Date().toISOString(),
        seq: i,
      });
    }
    const activity = readActivity(statePath);
    assert.ok(activity.length <= ACTIVITY_RING_MAX, `expected <= ${ACTIVITY_RING_MAX}, got ${activity.length}`);
    assert.equal(activity.length, ACTIVITY_RING_MAX, 'should be exactly capped when all entries are evictable');

    // Drop-oldest: the newest entry (seq=total-1) must still be present.
    const seqs = activity.map((e) => e.seq);
    assert.equal(seqs[seqs.length - 1], total - 1, 'newest entry must be retained');
    assert.ok(seqs[0] >= total - ACTIVITY_RING_MAX, 'oldest retained entry must be from the tail window');
  });
});

test('D2b: exempt recovery events are NEVER evicted, even when oldest', () => {
  withSandbox((sessionDir) => {
    // Seed the OLDEST three entries as exempt recovery events.
    const exemptSeed = [
      { event: 'rate_limit_wait', ts: new Date().toISOString(), marker: 'EXEMPT_rate_limit' },
      { event: 'crashed_ticket_files_quarantined', ts: new Date().toISOString(), marker: 'EXEMPT_quarantined' },
      { event: 'ticket_ladder_exhausted', ts: new Date().toISOString(), marker: 'EXEMPT_ladder' },
    ];
    const statePath = writeState(sessionDir, { activity: exemptSeed });

    // Now flood with > 2000 evictable entries.
    const flood = ACTIVITY_RING_MAX + 100;
    for (let i = 0; i < flood; i++) {
      writeActivityEntry(statePath, { event: 'iteration_start', ts: new Date().toISOString(), seq: i });
    }

    const activity = readActivity(statePath);
    const markers = activity.filter((e) => typeof e.marker === 'string').map((e) => e.marker);
    assert.ok(markers.includes('EXEMPT_rate_limit'), 'rate_limit_* event must survive');
    assert.ok(markers.includes('EXEMPT_quarantined'), '*_quarantined event must survive');
    assert.ok(markers.includes('EXEMPT_ladder'), 'ticket_ladder_exhausted event must survive');

    // The total stays bounded (best-effort: <= MAX + exempt-overflow, here exempts fit).
    assert.ok(activity.length <= ACTIVITY_RING_MAX, `expected <= ${ACTIVITY_RING_MAX}, got ${activity.length}`);
  });
});

test('D2: all-exempt over-cap entries are kept (best-effort cap over evictable)', () => {
  withSandbox((sessionDir) => {
    // Pre-seed > 2000 exempt entries directly; a single non-exempt append triggers trim.
    const exempt = [];
    const overcap = ACTIVITY_RING_MAX + 50;
    for (let i = 0; i < overcap; i++) {
      exempt.push({ event: 'rate_limit_wait', ts: new Date().toISOString(), seq: i });
    }
    const statePath = writeState(sessionDir, { activity: exempt });

    writeActivityEntry(statePath, { event: 'iteration_start', ts: new Date().toISOString(), seq: 9999 });

    const activity = readActivity(statePath);
    // No exempt entry may be dropped → length stays above the cap (best-effort).
    const exemptCount = activity.filter((e) => e.event === 'rate_limit_wait').length;
    assert.equal(exemptCount, overcap, 'no exempt entry may be evicted even when over cap');
  });
});
