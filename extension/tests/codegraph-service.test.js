// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodegraphService } from '../services/codegraph-service.js';

// --- helpers ---------------------------------------------------------------

function baseSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: false,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5000,
    sync_timeout_ms: 5000,
    query_timeout_ms: 5000,
    ...overrides,
  };
}

function fakeImpl(overrides = {}) {
  return {
    indexAll: async () => ({ filesIndexed: 1 }),
    sync: async () => ({ filesChecked: 1 }),
    searchNodes: () => [{ node: { id: 'n1' }, score: 1 }],
    getCallers: () => [],
    getImpactRadius: () => ({ nodes: new Map() }),
    buildContext: async () => 'context',
    close: () => {},
    ...overrides,
  };
}

/** Build a service with a capturing emit + deterministic ts. */
function harness(settings, deps = {}) {
  const events = [];
  const svc = CodegraphService.create('/tmp/repo', settings, {
    emit: (e) => events.push(e),
    now: () => 'TS',
    env: {},
    ...deps,
  });
  return { svc, events };
}

const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- matrix ----------------------------------------------------------------

test('throwing fake: returns null + one classified error degrade', async () => {
  const impl = fakeImpl({ searchNodes: () => { throw new Error('boom'); } });
  const { svc, events } = harness(baseSettings(), { impl });
  const res = await svc.searchNodes('q');
  assert.equal(res, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'codegraph_degraded');
  assert.equal(events[0].operation, 'searchNodes');
  assert.equal(events[0].reason, 'error');
  assert.equal(events[0].ts, 'TS');
  assert.deepEqual(svc.getSessionCounters(), { ops: 1, degraded: 1, latched: 0 });
});

test('async-hanging fake: times out to null with one timeout degrade', async () => {
  const impl = fakeImpl({ indexAll: never });
  const { svc, events } = harness(baseSettings({ index_timeout_ms: 10 }), { impl });
  const res = await svc.indexAll();
  assert.equal(res, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'codegraph_degraded');
  assert.equal(events[0].operation, 'indexAll');
  assert.equal(events[0].reason, 'timeout');
});

test('orphaned timeout (late RESOLVE): exactly one degrade total', async () => {
  const impl = fakeImpl({ indexAll: () => sleep(40).then(() => ({ filesIndexed: 9 })) });
  const { svc, events } = harness(baseSettings({ index_timeout_ms: 10 }), { impl });
  const res = await svc.indexAll();
  assert.equal(res, null);
  await sleep(60); // let the orphan settle
  assert.equal(events.length, 1, 'orphan resolve must not emit a second event');
  assert.equal(events[0].reason, 'timeout');
});

test('orphaned timeout (late REJECT): one degrade, no unhandledRejection', async () => {
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const impl = fakeImpl({ indexAll: () => sleep(40).then(() => { throw new Error('late corrupt'); }) });
    const { svc, events } = harness(baseSettings({ index_timeout_ms: 10 }), { impl });
    await svc.indexAll();
    await sleep(60);
    assert.equal(events.length, 1, 'orphan reject must not emit a second event');
    assert.equal(events[0].reason, 'timeout');
    assert.equal(unhandled, null, 'orphan reject must not surface as unhandledRejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('kill-switch off: inert, zero events, dependency never loaded', async () => {
  let loadCalled = false;
  const svc = CodegraphService.create('/tmp/repo', baseSettings(), {
    env: { PICKLE_CODEGRAPH: 'off' },
    emit: () => { throw new Error('off must emit nothing'); },
    loadImpl: async () => { loadCalled = true; return fakeImpl(); },
  });
  assert.equal(await svc.indexAll(), null);
  assert.equal(await svc.sync(), null);
  assert.equal(await svc.searchNodes('q'), null);
  assert.equal(await svc.getCallers('n'), null);
  assert.equal(await svc.getImpactRadius('n'), null);
  assert.equal(await svc.buildContext('t'), null);
  svc.close();
  assert.equal(loadCalled, false, 'off must never load the dependency');
  assert.deepEqual(svc.getSessionCounters(), { ops: 0, degraded: 0, latched: 0 });
});

test('locked: classifies database-is-locked', async () => {
  const impl = fakeImpl({ sync: async () => { throw new Error('SQLITE_BUSY: database is locked'); } });
  const { svc, events } = harness(baseSettings(), { impl });
  assert.equal(await svc.sync(), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'locked');
  assert.equal(events[0].operation, 'sync');
});

test('corrupt: quarantine + rebuild ONCE, not latched', async () => {
  let quarantines = 0;
  let rebuilds = 0;
  const impl = fakeImpl({ indexAll: async () => { throw new Error('file is not a database'); } });
  const { svc, events } = harness(baseSettings(), {
    impl,
    quarantine: () => { quarantines += 1; },
    rebuild: async () => { rebuilds += 1; return fakeImpl(); },
    withFileLock: (fn) => fn(),
  });
  assert.equal(await svc.indexAll(), null);
  assert.equal(quarantines, 1, 'corrupt db quarantined exactly once');
  assert.equal(rebuilds, 1, 'rebuilt exactly once');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'corrupt');
  const c = svc.getSessionCounters();
  assert.equal(c.latched, 0, 'a recoverable corrupt must not latch');
});

test('second corrupt after rebuild: latches sticky, then inert', async () => {
  let quarantines = 0;
  // First impl corrupts; rebuilt impl also corrupts -> second corrupt latches.
  const corruptImpl = fakeImpl({ indexAll: async () => { throw new Error('database disk image is malformed'); } });
  const { svc, events } = harness(baseSettings(), {
    impl: corruptImpl,
    quarantine: () => { quarantines += 1; },
    rebuild: async () => fakeImpl({ indexAll: async () => { throw new Error('malformed'); } }),
    withFileLock: (fn) => fn(),
  });
  await svc.indexAll(); // first corrupt -> rebuild once
  await svc.indexAll(); // second corrupt -> latch
  const latchEvents = events.filter((e) => e.operation === 'latch');
  assert.equal(latchEvents.length, 1, 'exactly one latch event');
  assert.equal(quarantines, 1, 'quarantine happens only on the first corrupt');
  assert.equal(svc.getSessionCounters().latched, 1);

  const before = events.length;
  assert.equal(await svc.searchNodes('q'), null, 'post-latch calls are inert-null');
  assert.equal(await svc.sync(), null);
  assert.equal(events.length, before, 'post-latch calls emit nothing further');
});

test('rebuild failure latches immediately', async () => {
  const impl = fakeImpl({ indexAll: async () => { throw new Error('not a database'); } });
  const { svc, events } = harness(baseSettings(), {
    impl,
    quarantine: () => {},
    rebuild: async () => { throw new Error('rebuild blew up'); },
    withFileLock: (fn) => fn(),
  });
  await svc.indexAll();
  assert.equal(svc.getSessionCounters().latched, 1);
  const latchEvents = events.filter((e) => e.operation === 'latch');
  assert.equal(latchEvents.length, 1);
  // first corrupt degrade + latch event = 2 total
  assert.equal(events.length, 2);
  assert.equal(events[0].reason, 'corrupt');
});

test('counters exact across a forced-degrade sequence', async () => {
  const impl = fakeImpl({
    indexAll: never,
    sync: async () => { throw new Error('database is locked'); },
  });
  const { svc } = harness(baseSettings({ index_timeout_ms: 10 }), { impl });
  await svc.searchNodes('q'); // ops=1, degraded=0 (success)
  await svc.indexAll();        // ops=2, degraded=1 (timeout)
  await svc.sync();            // ops=3, degraded=2 (locked)
  assert.deepEqual(svc.getSessionCounters(), { ops: 3, degraded: 2, latched: 0 });
});

test('index success emits codegraph_index_built, no degrade', async () => {
  const { svc, events } = harness(baseSettings(), { impl: fakeImpl() });
  const res = await svc.indexAll();
  assert.deepEqual(res, { filesIndexed: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'codegraph_index_built');
  assert.equal(events[0].operation, 'indexAll');
});

test('sync success emits codegraph_sync_completed', async () => {
  const { svc, events } = harness(baseSettings(), { impl: fakeImpl() });
  await svc.sync();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'codegraph_sync_completed');
});

test('buildContext success returns value, emits nothing', async () => {
  const { svc, events } = harness(baseSettings(), { impl: fakeImpl() });
  assert.equal(await svc.buildContext({ title: 't' }), 'context');
  assert.equal(events.length, 0);
});

test('schema_skew classification', async () => {
  const impl = fakeImpl({ sync: async () => { throw new Error('schema migration required'); } });
  const { svc, events } = harness(baseSettings(), { impl });
  await svc.sync();
  assert.equal(events[0].reason, 'schema_skew');
});

test('enabled but dependency unavailable: degrades, never throws', async () => {
  const { svc, events } = harness(baseSettings(), {
    impl: null,
    loadImpl: async () => null,
  });
  assert.equal(await svc.searchNodes('q'), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'codegraph_degraded');
  assert.equal(events[0].reason, 'error');
  // load failure is not a dispatched op
  assert.equal(svc.getSessionCounters().ops, 0);
});

test('persistently unavailable dependency degrades once, not per call', async () => {
  const { svc, events } = harness(baseSettings(), {
    impl: null,
    loadImpl: async () => null,
  });
  await svc.searchNodes('q');
  await svc.indexAll();
  await svc.sync();
  assert.equal(events.length, 1, 'absent dependency must emit exactly one degrade for the session');
});
