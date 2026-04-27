import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runPerIterationGateHook } = await import(
  path.resolve(__dirname, '../../bin/microverse-runner.js')
);

function makeMv(overrides = {}) {
  return {
    status: 'iterating',
    prd_path: 'prd.md',
    key_metric: { description: 'test', validation: 'echo 1', type: 'command', timeout_seconds: 30, tolerance: 1 },
    convergence: { stall_limit: 5, stall_counter: 0, history: [] },
    gap_analysis_path: 'gap.md',
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    iteration_regressions: 0,
    gate_regression_threshold_warning_emitted: false,
    ...overrides,
  };
}

function makeGateResult(status = 'green', failureCount = 0) {
  return {
    status,
    failures: Array.from({ length: failureCount }, (_, i) => ({
      check: 'lint',
      file: `src/foo${i}.ts`,
      line: i + 1,
      ruleOrCode: 'no-unused-vars',
      message: 'unused',
      severity: 'error',
      occurrence_index: 0,
    })),
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 100,
    total_raw_failure_count: failureCount,
    new_failures_vs_baseline: failureCount,
  };
}

const BASE_OPTS = {
  preIterSha: 'sha-before',
  workingDir: '/tmp/test-wd',
  sessionDir: '/tmp/test-session',
  enabledFiles: ['anatomy-park.json'],
  regressionWarningThreshold: 5,
  backend: 'claude',
  remediatorTimeoutS: 600,
  log: () => {},
};

// Fixture i: gate enabled + commits happened + gate green → no events
test('gate-fixture-i: green gate + commits → no regression events', async () => {
  const events = [];
  const writtenStates = [];

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('green', 0),
      runRemediatorFn: async () => { assert.fail('remediator must not be called on green gate'); },
      writeMicroverseStateFn: (_, s) => writtenStates.push(s),
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(events.length, 0, `No events for green gate, got: ${JSON.stringify(events)}`);
  assert.equal(writtenStates.length, 0, 'No state writes for green gate');
  assert.equal(mv.iteration_regressions, 0);
});

// Fixture ii: gate red + remediator succeeds → no regression event
test('gate-fixture-ii: red gate + remediator success → no regression', async () => {
  const events = [];

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 2),
      runRemediatorFn: async () => ({ success: true }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.ok(
    !events.some(e => e.event === 'iteration_left_regression'),
    'No regression event when remediator succeeds',
  );
  assert.equal(mv.iteration_regressions, 0, 'iteration_regressions must not increment on success');
});

// Fixture iii: convergence_file not in allowlist → gate does not fire
test('gate-fixture-iii: convergence_file not in allowlist → gate not called', async () => {
  let gateCallCount = 0;
  const events = [];

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ convergence_file: 'my-custom.json' }),
    enabledFiles: ['anatomy-park.json'],
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => { gateCallCount++; return makeGateResult('red', 1); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called when file not in allowlist');
  assert.equal(events.length, 0, `No events for disabled gate, got: ${JSON.stringify(events)}`);
});

// Fixture iv: gate red + remediator fails → iteration_regressions increments
test('gate-fixture-iv: red gate + remediator fail → iteration_regressions increments', async () => {
  const events = [];
  let lastWrittenMv;

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ iteration_regressions: 2 }),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 3),
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, s) => { lastWrittenMv = s; },
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(mv.iteration_regressions, 3, 'iteration_regressions must increment from 2 → 3');
  assert.ok(lastWrittenMv, 'state must be persisted after regression');
  assert.equal(lastWrittenMv.iteration_regressions, 3);

  const regEvent = events.find(e => e.event === 'iteration_left_regression');
  assert.ok(regEvent, `iteration_left_regression event must be emitted, got: ${JSON.stringify(events)}`);
  assert.equal(regEvent.gate_payload.failures_in, 3);
});

// Fixture v: convergence_file = 'microverse.json' → not in default allowlist, zero gate events
test('gate-fixture-v: microverse.json convergence_file → zero gate events', async () => {
  let gateCallCount = 0;
  const events = [];

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ convergence_file: 'microverse.json' }),
    enabledFiles: ['anatomy-park.json'],
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => { gateCallCount++; return makeGateResult('red', 1); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called for microverse.json');
  assert.ok(
    !events.some(e => typeof e.event === 'string' && e.event.startsWith('gate_')),
    `No gate_* events for microverse.json, got: ${JSON.stringify(events)}`,
  );
});

// Fixture vi: no commits → gate_skipped with reason 'no_commits'
test('gate-fixture-vi: no commits → gate_skipped event', async () => {
  const events = [];
  let gateCallCount = 0;

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    _deps: {
      getHeadShaFn: () => 'sha-before', // same SHA → no commits
      runGateFn: async () => { gateCallCount++; return makeGateResult('green', 0); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called when no commits happened');
  const skipEvent = events.find(e => e.event === 'gate_skipped');
  assert.ok(skipEvent, `gate_skipped event must be emitted, got: ${JSON.stringify(events)}`);
  assert.equal(skipEvent.gate_payload?.reason, 'no_commits');
});

// Threshold warning: 6 regressions → warning fires exactly once, second crossing silent
test('threshold-warning: 6 regressions → exactly one warning, second crossing silent', async () => {
  const logs = [];
  const events = [];

  // Start at regressionWarningThreshold=5 with iteration_regressions=5 (at threshold, not above)
  let mv = makeMv({ iteration_regressions: 5, gate_regression_threshold_warning_emitted: false });

  const runWithRegression = async (currentMv) => runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv,
    log: (msg) => logs.push(msg),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 1),
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  // First run: regressions 5 → 6 (> threshold=5), warning fires
  mv = await runWithRegression(mv);
  assert.equal(mv.iteration_regressions, 6);
  assert.equal(mv.gate_regression_threshold_warning_emitted, true);

  const warningEvents = events.filter(e => e.event === 'gate_regression_threshold_warning');
  assert.equal(warningEvents.length, 1, 'warning event fired exactly once after first crossing');
  assert.ok(logs.some(l => l.includes('regression')), 'warning log must mention regression');

  // Second run: warning must NOT fire again
  mv = await runWithRegression(mv);
  const warningEventsAfter = events.filter(e => e.event === 'gate_regression_threshold_warning');
  assert.equal(warningEventsAfter.length, 1, 'warning must not fire a second time');
  assert.equal(mv.gate_regression_threshold_warning_emitted, true, 'flag must remain true');
});
