// @tier: fast
//
// anatomy-park (extension subsystem) — regression for the b1089e97
// cross-process aggregation gap in `codegraph_session_summary`.
//
// Data flow under test:
//   buildCodegraphContextSection (spawn-morty PROCESS) → writeActivityEntry
//   → state.activity[] persisted to <sessionRoot>/state.json
//   → mux-runner PROCESS reads the same state.json at session end and emits
//     codegraph_session_summary { injected, skipped, ... }
//
// Bug: the summary derived injected/skipped from mux-runner's OWN in-memory
// CodegraphService counters. Those counters are only incremented by
// recordContextInjected/recordContextSkipped inside buildCodegraphContextSection,
// which runs ONLY in the per-spawn spawn-morty process — a different process with
// a different service instance. So mux-runner's counters were structurally always
// 0, and every codegraph_session_summary reported injected:0/skipped:0 regardless
// of how many context sections were actually injected.
//
// Fix: countCodegraphContextEvents reads the persisted activity log (ground truth
// shared across both processes) instead of the always-zero in-memory counters.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countCodegraphContextEvents } from '../bin/mux-runner.js';

describe('countCodegraphContextEvents (b1089e97 cross-process aggregation)', () => {
  it('counts persisted injected/skipped events from a realistic activity log', () => {
    // Shape mirrors what spawn-morty writes via writeActivityEntry: a mixed
    // activity stream across several ticket spawns, not just the two events.
    const activity = [
      { event: 'iteration_start', ts: '2026-06-14T19:00:00.000Z' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z', ticket: 'aaaa1111', tier: 'medium', terms_count: 4, hits_count: 7, bytes: 2048, build_ms: 12 },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:02:00.000Z', reason: 'no_terms' },
      { event: 'manager_turn_progress', ts: '2026-06-14T19:02:30.000Z' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:03:00.000Z', ticket: 'bbbb2222', tier: 'large', terms_count: 9, hits_count: 3, bytes: 4096, build_ms: 31 },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:04:00.000Z', reason: 'zero_hits' },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:05:00.000Z', reason: 'non_graph_tier' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:06:00.000Z', ticket: 'cccc3333', tier: 'medium', terms_count: 2, hits_count: 5, bytes: 1024, build_ms: 8 },
    ];

    assert.deepEqual(countCodegraphContextEvents(activity), { injected: 3, skipped: 3 });
  });

  it('is the cross-process fix: persisted events count even when in-memory counters are 0', () => {
    // Simulates the real bug: mux-runner's CodegraphService never recorded any
    // injection (its counters would read injected:0), yet the shared state.json
    // activity log holds the spawn-morty-produced events. Counting from activity
    // must report the real number, NOT 0.
    const muxInMemoryCounters = { ops: 5, degraded: 0, latched: 0, injected: 0, skipped: 0 };
    const persistedActivity = [
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z', ticket: 'd1', tier: 'medium', terms_count: 1, hits_count: 1, bytes: 64, build_ms: 1 },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:02:00.000Z', ticket: 'd2', tier: 'medium', terms_count: 1, hits_count: 1, bytes: 64, build_ms: 1 },
    ];

    const derived = countCodegraphContextEvents(persistedActivity);
    assert.equal(derived.injected, 2, 'must reflect persisted events, not the always-zero in-memory counter');
    assert.notEqual(derived.injected, muxInMemoryCounters.injected, 'fix must NOT read the in-memory counter');
  });

  it('returns zeros for absent, empty, or non-codegraph activity', () => {
    assert.deepEqual(countCodegraphContextEvents(undefined), { injected: 0, skipped: 0 });
    assert.deepEqual(countCodegraphContextEvents([]), { injected: 0, skipped: 0 });
    assert.deepEqual(
      countCodegraphContextEvents([{ event: 'iteration_start', ts: '2026-06-14T19:00:00.000Z' }]),
      { injected: 0, skipped: 0 },
    );
  });

  it('tolerates malformed entries without throwing', () => {
    const activity = [
      null,
      undefined,
      {},
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z' },
    ];
    assert.deepEqual(countCodegraphContextEvents(activity), { injected: 1, skipped: 0 });
  });
});
