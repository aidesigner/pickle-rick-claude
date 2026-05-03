// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMicroverseState, recordStall } from '../../services/microverse-state.js';
import { writeStateFile } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  _deps,
  executeMainLoop,
  handleWorkerManagedIteration,
} = await import(path.resolve(__dirname, '../../bin/microverse-runner.js'));

const TEST_METRIC = {
  description: 'none',
  validation: '',
  type: 'none',
  timeout_seconds: 30,
  tolerance: 0,
};

function makeMv(overrides = {}) {
  return {
    ...createMicroverseState({
      prdPath: 'prd.md',
      metric: TEST_METRIC,
      stallLimit: 3,
      convergenceMode: 'worker',
      convergenceFile: 'anatomy-park.json',
    }),
    status: 'iterating',
    gap_analysis_path: 'gap.md',
    ...overrides,
  };
}

function makeGateResult(status = 'green', failureCount = 0) {
  return {
    status,
    failures: Array.from({ length: failureCount }, (_, i) => ({
      check: 'lint',
      file: `src/broken-${i}.ts`,
      line: i + 1,
      ruleOrCode: 'no-simulated-regression',
      message: `simulated regression ${i + 1}`,
      severity: 'error',
      occurrence_index: i,
    })),
    baseline_used: false,
    allowed_paths_used: true,
    elapsed_ms: 123,
    total_raw_failure_count: failureCount,
    new_failures_vs_baseline: failureCount,
  };
}

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stall-repo-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'two\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'worker change'], { cwd: dir, stdio: 'pipe' });
  return { dir, preIterSha };
}

function makeRunnerState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
  };
}

test('SCJM-T4: worker convergence with empty history exits judge_unreachable', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-judge-unreachable-empty-'));
  fs.writeFileSync(
    path.join(sessionDir, 'anatomy-park.json'),
    JSON.stringify({ converged: true, reason: 'worker said done' }),
  );
  const events = [];

  const result = await handleWorkerManagedIteration({
    currentMv: makeMv(),
    preIterSha: 'sha-before',
    workingDir: sessionDir,
    sessionDir,
    enabledFiles: [],
    regressionWarningThreshold: 5,
    backend: 'claude',
    remediatorTimeoutS: 1,
    log: () => {},
    iteration: 1,
    minIterations: 1,
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('green', 0),
      runRemediatorFn: async () => ({ success: true }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(result.converged, false);
  assert.equal(result.exitReason, 'judge_unreachable');
  assert.equal(events.some(event => event.event === 'judge_unreachable'), true);
});

test('SCJM-T4: worker convergence with scoreless history exits judge_unreachable', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-judge-unreachable-scoreless-'));
  fs.writeFileSync(
    path.join(sessionDir, 'anatomy-park.json'),
    JSON.stringify({ converged: true, reason: 'worker said done' }),
  );
  const state = makeMv({
    convergence: {
      stall_limit: 3,
      stall_counter: 0,
      history: [{
        iteration: 1,
        score: null,
        action: 'accept',
        description: 'score unavailable',
        commit: 'abc123',
        pre_iteration_sha: 'def456',
        timestamp: new Date().toISOString(),
      }],
    },
  });
  const events = [];

  const result = await handleWorkerManagedIteration({
    currentMv: state,
    preIterSha: 'sha-before',
    workingDir: sessionDir,
    sessionDir,
    enabledFiles: [],
    regressionWarningThreshold: 5,
    backend: 'claude',
    remediatorTimeoutS: 1,
    log: () => {},
    iteration: 1,
    minIterations: 1,
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('green', 0),
      runRemediatorFn: async () => ({ success: true }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(result.converged, false);
  assert.equal(result.exitReason, 'judge_unreachable');
  assert.equal(events.some(event => event.event === 'judge_unreachable'), true);
});

test('AC-GBM-C1: a single strict-mode red records stall/regression and continues', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stall-session-'));
  const { dir: workingDir, preIterSha } = makeGitRepo();
  const events = [];
  const writtenStates = [];
  let gateCalls = 0;

  const result = await handleWorkerManagedIteration({
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    regressionWarningThreshold: 5,
    backend: 'claude',
    remediatorTimeoutS: 1,
    log: () => {},
    iteration: 1,
    _deps: {
      getHeadShaFn: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim(),
      runGateFn: async ({ mode }) => {
        gateCalls++;
        return mode === 'strict' ? makeGateResult('red', 2) : makeGateResult('green', 0);
      },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, state) => writtenStates.push(structuredClone(state)),
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(gateCalls, 2, 'baseline recapture attempt plus strict changed gate should run');
  assert.equal(result.converged, false, 'single strict red must not converge or fail the phase immediately');
  assert.equal(result.currentMv.iteration_regressions, 1);
  assert.equal(result.currentMv.convergence.stall_counter, 1);
  assert.equal(result.currentMv.convergence.stall_limit, 3);
  assert.equal(writtenStates.at(-1).convergence.stall_counter, 1);

  const strictEvent = events.find((event) => event.event === 'strict_mode_red');
  assert.ok(strictEvent, `strict_mode_red event missing from ${JSON.stringify(events)}`);
  assert.equal(strictEvent.gate_payload.mode, 'strict');
  assert.equal(strictEvent.gate_payload.scope, 'changed');
  assert.equal(strictEvent.gate_payload.since, preIterSha);
  assert.equal(strictEvent.gate_payload.failures_in, 2);
  assert.equal(strictEvent.gate_payload.stall_counter, 1);
  assert.equal(strictEvent.gate_payload.stall_limit, 3);
  assert.equal(strictEvent.gate_payload.failures[0].file, 'src/broken-0.ts');

  const regressionEvent = events.find((event) => event.event === 'iteration_left_regression');
  assert.ok(regressionEvent, `iteration_left_regression event missing from ${JSON.stringify(events)}`);
  assert.equal(regressionEvent.gate_payload.mode, 'strict');
  assert.equal(regressionEvent.gate_payload.failures_in, 2);
});

test('AC-GBM-C1: worker phase returns failure only when stall limit is exhausted', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stall-loop-'));
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stall-wd-'));
  const statePath = path.join(sessionDir, 'state.json');
  writeStateFile(statePath, makeRunnerState(sessionDir, workingDir));

  const state = makeMv({
    convergence: {
      stall_limit: 3,
      stall_counter: 2,
      history: [],
    },
  });

  const original = {
    runIteration: _deps.runIteration,
    runWorkerManagedIteration: _deps.runWorkerManagedIteration,
    getHeadSha: _deps.getHeadSha,
    sleep: _deps.sleep,
  };

  let workerCalls = 0;
  try {
    _deps.getHeadSha = () => 'sha-before';
    _deps.sleep = async () => {};
    _deps.runIteration = async () => ({
      completion: 'success',
      timedOut: false,
      exitCode: 0,
      wallSeconds: 1,
    });
    _deps.runWorkerManagedIteration = async ({ currentMv }) => {
      workerCalls++;
      return {
        currentMv: recordStall({
          ...currentMv,
          iteration_regressions: (currentMv.iteration_regressions ?? 0) + 1,
        }),
        converged: false,
        reason: 'per-iteration gate left unresolved regressions',
      };
    };

    const outcome = await executeMainLoop(state, {
      sessionDir,
      extensionRoot: path.resolve(__dirname, '../..'),
      statePath,
      workingDir,
      startTime: Date.now(),
      initialIteration: 0,
      enableFailureClassification: true,
      cgSettings: {
        enabled_convergence_files: [],
        regression_warning_threshold: 5,
        remediator_timeout_s: 1,
        baseline_max_age_iterations: 30,
        baseline_max_age_seconds: 14_400,
      },
      rateLimitWaitMinutes: 1,
      maxRateLimitRetries: 1,
      log: () => {},
      currentRunnerState: makeRunnerState(sessionDir, workingDir),
      iteration: 0,
      consecutiveRateLimits: 0,
    });

    assert.equal(workerCalls, 1);
    assert.equal(outcome.exitReason, 'error');
    assert.equal(outcome.state.convergence.stall_counter, 3);
    assert.equal(outcome.state.iteration_regressions, 1);
  } finally {
    _deps.runIteration = original.runIteration;
    _deps.runWorkerManagedIteration = original.runWorkerManagedIteration;
    _deps.getHeadSha = original.getHeadSha;
    _deps.sleep = original.sleep;
  }
});
