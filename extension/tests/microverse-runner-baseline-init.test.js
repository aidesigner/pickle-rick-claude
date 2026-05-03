// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensurePerIterationGateBaseline } from '../bin/microverse-runner.js';

function tmpDir(prefix = 'pickle-mv-baseline-init-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    ...overrides,
  };
}

function makeGateResult() {
  return {
    status: 'green',
    failures: [],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 10,
    total_raw_failure_count: 0,
    new_failures_vs_baseline: 0,
  };
}

test('baseline init rejects a successful gate run when the baseline file is missing', async () => {
  const workingDir = tmpDir('pickle-mv-baseline-work-');
  const sessionDir = tmpDir('pickle-mv-baseline-session-');
  const logs = [];
  const events = [];

  try {
    await assert.rejects(
      () => ensurePerIterationGateBaseline({
        currentMv: makeMv(),
        workingDir,
        sessionDir,
        enabledFiles: ['anatomy-park.json'],
        log: (msg) => logs.push(msg),
        _deps: {
          runGateFn: async () => makeGateResult(),
          logActivityFn: (event) => events.push(event),
        },
      }),
      /baseline initialization failed/,
    );

    assert.equal(fs.existsSync(path.join(sessionDir, 'gate', 'baseline.json')), false);
    assert.ok(
      logs.some((msg) => msg.includes('baseline initialization failed')),
      `expected failure log, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some((msg) => msg.includes('initialized per-iteration gate baseline')),
      `success log must be gated on disk state, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      events.some((event) => event.event === 'gate_baseline_init_failed'),
      `expected gate_baseline_init_failed event, got ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('baseline init logs success only after the baseline file exists on disk', async () => {
  const workingDir = tmpDir('pickle-mv-baseline-work-');
  const sessionDir = tmpDir('pickle-mv-baseline-session-');
  const logs = [];
  const events = [];

  try {
    await ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: (msg) => logs.push(msg),
      _deps: {
        runGateFn: async ({ baselinePath }) => {
          fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
          fs.writeFileSync(baselinePath, JSON.stringify({ checks: [], failures: [] }, null, 2));
          return makeGateResult();
        },
        logActivityFn: (event) => events.push(event),
      },
    });

    assert.equal(fs.existsSync(path.join(sessionDir, 'gate', 'baseline.json')), true);
    assert.ok(
      logs.some((msg) => msg.includes('initialized per-iteration gate baseline')),
      `expected success log after baseline write, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !events.some((event) => event.event === 'gate_baseline_init_failed'),
      `did not expect gate_baseline_init_failed, got ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
