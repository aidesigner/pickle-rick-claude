// @tier: fast
//
// AC-STALE: shouldSyncCodegraph — pure staleness-decision function exported from mux-runner.
// Injectable now/statSync seams; no filesystem side-effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { shouldSyncCodegraph } = await import(
  path.resolve(__dirname, '../bin/mux-runner.js')
);

const DB = '/fake/.codegraph/codegraph.db';

test('AC-STALE-STALE: stale db (age > threshold) → returns true', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (31 * 60 * 1000) }); // 31 min old
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), true);
});

test('AC-STALE-FRESH: fresh db (age < threshold) → returns false', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (5 * 60 * 1000) }); // 5 min old
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), false);
});

test('AC-STALE-MISSING: statSync throws (db absent) → returns false', () => {
  const now = () => 1_000_000;
  const statSync = () => { throw new Error('ENOENT'); };
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), false);
});

test('AC-STALE-BOUNDARY: age === threshold (exact boundary) → returns true (>= semantics)', () => {
  const now = () => 1_000_000;
  const thresholdMs = 30 * 60 * 1000;
  const statSync = () => ({ mtimeMs: 1_000_000 - thresholdMs });
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), true);
});

test('AC-STALE-ZERO: threshold=0 → always stale for any present db', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - 1 }); // 1ms old
  assert.equal(shouldSyncCodegraph(DB, 0, now, statSync), true);
});

test('AC-STALE-INJECTION: injected now + statSync are used (no real fs)', () => {
  let nowCalled = false;
  let statCalled = false;
  const now = () => { nowCalled = true; return 1_000_000; };
  const statSync = () => { statCalled = true; return { mtimeMs: 0 }; };
  shouldSyncCodegraph(DB, 30, now, statSync);
  assert.ok(nowCalled, 'injected now must be called');
  assert.ok(statCalled, 'injected statSync must be called');
});
