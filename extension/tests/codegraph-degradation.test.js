// @tier: fast
//
// CGH-5: codegraph graceful-degradation fixtures.
// Prove fail-open for every reachable failure mode + kill-switch full short-circuit.
// MCP-merge-fail leg omitted: unreachable while expose_mcp_to_workers:false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

const { CodegraphService } = await import(path.join(EXTENSION_ROOT, 'services/codegraph-service.js'));
const { runCodegraphIndexAtSetup } = await import(path.join(EXTENSION_ROOT, 'bin/setup.js'));

// --- helpers -----------------------------------------------------------------

function cgSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: true,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5_000,
    sync_timeout_ms: 5_000,
    query_timeout_ms: 5_000,
    ...overrides,
  };
}

// An impl where every operation fails — simulates a broken/unavailable binary.
function brokenImpl(errorMessage) {
  const fail = async () => { throw new Error(errorMessage); };
  const failSync = () => { throw new Error(errorMessage); };
  return {
    indexAll: fail,
    sync: fail,
    buildContext: fail,
    searchNodes: failSync,
    getCallers: failSync,
    getImpactRadius: failSync,
    close: () => {},
  };
}

// --- describe.each([['index-failure'],['binary-unresolvable'],['read-only-fs']]) ---
//
// AC-CGH-5-1: parametrized loop over all reachable degradation modes.
// Each scenario asserts:
//   1. runCodegraphIndexAtSetup completes without throwing (fail-open)
//   2. codegraph_degraded emitted at least once during setup
//   3. buildContext returns null → no '## Code Graph Context' injected to worker

const FAILURE_CASES = [
  ['index-failure'],
  ['binary-unresolvable'],
  ['read-only-fs'],
];

for (const [mode] of FAILURE_CASES) {
  test(`fail-open[${mode}]: setup completes, codegraph_degraded emitted, no context injected`, async () => {
    const events = [];
    const emit = (e) => events.push(e);

    let deps;
    if (mode === 'binary-unresolvable') {
      // Binary not found: loadImpl returns null every time.
      // Inject sleep no-op to bypass MCP_STARTUP_BACKOFF_MS delays (500ms + 1500ms)
      // so the 3-attempt retry loop stays within fast-tier budget.
      deps = {
        impl: null,
        loadImpl: async () => null,
        sleep: async () => {},
        emit,
        now: () => 'TS',
        env: {},
      };
    } else {
      const errorMsg = mode === 'read-only-fs'
        ? "EACCES: permission denied, open '.codegraph/codegraph.db'"
        : 'codegraph indexAll: internal error';
      deps = {
        impl: brokenImpl(errorMsg),
        emit,
        now: () => 'TS',
        env: {},
      };
    }

    // 1. Setup must not throw (fail-open).
    await assert.doesNotReject(
      () => runCodegraphIndexAtSetup(
        '/tmp/cgh5-fake-workdir',
        cgSettings(),
        /* isResume */ false,
        deps,
        {}, // env: not PICKLE_CODEGRAPH=off — exercise actual failure path
      ),
      `runCodegraphIndexAtSetup must not throw on ${mode} (fail-open)`,
    );

    // 2. codegraph_degraded must be emitted at least once during setup.
    const degraded = events.filter((e) => e.event === 'codegraph_degraded');
    assert.ok(degraded.length >= 1, `codegraph_degraded must be emitted for ${mode}`);

    // 3. buildContext must return null (no '## Code Graph Context' injected).
    // Fresh service instance with same failure deps; index_at_setup:false avoids
    // double-running indexAll just to reach buildContext.
    const ctxEvents = [];
    const svcDeps = { ...deps, emit: (e) => ctxEvents.push(e) };
    const svc = CodegraphService.create(
      '/tmp/cgh5-fake-workdir',
      cgSettings({ index_at_setup: false }),
      svcDeps,
    );
    const ctx = await svc.buildContext({ title: 'ticket task', description: 'some description' });
    assert.equal(ctx, null, `buildContext must return null (degraded) for ${mode}`);
  });
}

// --- PICKLE_CODEGRAPH=off: kill-switch fully short-circuits --- AC-CGH-5-3

test('PICKLE_CODEGRAPH=off: zero events, no native bundle load, buildContext and indexAll return null', async () => {
  const events = [];
  let loadImplCalled = false;

  const killSwitchEnv = { PICKLE_CODEGRAPH: 'off' };
  const deps = {
    impl: null,
    loadImpl: async () => { loadImplCalled = true; return null; },
    emit: (e) => events.push(e),
    now: () => 'TS',
    env: killSwitchEnv,
  };

  // runCodegraphIndexAtSetup early-returns on PICKLE_CODEGRAPH=off (5th param).
  await assert.doesNotReject(
    () => runCodegraphIndexAtSetup(
      '/tmp/cgh5-fake-workdir',
      cgSettings(),
      /* isResume */ false,
      deps,
      killSwitchEnv,
    ),
    'runCodegraphIndexAtSetup must not throw with PICKLE_CODEGRAPH=off',
  );

  assert.equal(events.length, 0, 'PICKLE_CODEGRAPH=off: zero codegraph activity events from setup');
  assert.equal(loadImplCalled, false, 'PICKLE_CODEGRAPH=off: native bundle must never be loaded during setup');

  // The service itself is also fully inert under the kill-switch (deps.env carries it).
  const svc = CodegraphService.create(
    '/tmp/cgh5-fake-workdir',
    cgSettings({ index_at_setup: false }),
    deps,
  );

  const ctx = await svc.buildContext({ title: 'ticket task', description: 'some description' });
  assert.equal(ctx, null, 'PICKLE_CODEGRAPH=off: buildContext must return null (inert)');

  const idx = await svc.indexAll();
  assert.equal(idx, null, 'PICKLE_CODEGRAPH=off: indexAll must return null (inert)');

  assert.equal(events.length, 0, 'PICKLE_CODEGRAPH=off: zero codegraph activity events from any service call');
  assert.equal(loadImplCalled, false, 'PICKLE_CODEGRAPH=off: native bundle must never be loaded from service calls');
});
