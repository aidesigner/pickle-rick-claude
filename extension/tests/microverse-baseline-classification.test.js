// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  _deps,
  executeGapAnalysis,
} from '../bin/microverse-runner.js';
import { readMicroverseState } from '../services/microverse-state.js';
import { isMicroverseFailureExit } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-baseline-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function createSessionDir(workingDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-baseline-session-'));
  const runnerState = {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 120,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    tmux_mode: true,
    command_template: 'microverse.md',
    backend: 'claude',
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(runnerState, null, 2));
  const mvState = {
    status: 'gap_analysis',
    prd_path: '/tmp/prd.md',
    key_metric: {
      description: 'judge quality gate',
      validation: 'improve code quality',
      type: 'llm',
      timeout_seconds: 60,
      tolerance: 0,
      judge_model: 'claude-sonnet-4-6',
    },
    convergence: { stall_limit: 3, stall_counter: 0, history: [] },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 0,
  };
  fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(mvState, null, 2));
  return { dir, runnerState };
}

function makeContext(sessionDir, runnerState, workingDir) {
  return {
    sessionDir,
    extensionRoot,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    startTime: Date.now(),
    initialIteration: 0,
    enableFailureClassification: false,
    cgSettings: {
      enabled_convergence_files: [],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    rateLimitWaitMinutes: 0,
    maxRateLimitRetries: 0,
    log: () => {},
    currentRunnerState: runnerState,
    iteration: 0,
    consecutiveRateLimits: 0,
  };
}

function makeSpawnError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const makeEtimedoutError = () => makeSpawnError('spawnSync claude ETIMEDOUT', 'ETIMEDOUT');
const makeEnoentError = () => makeSpawnError('spawnSync claude ENOENT', 'ENOENT');
const makeUnsupportedModelError = () => new Error('claude-sonnet-4-6 model is not supported when using Codex with a ChatGPT account');
const makeSchemaInvalidError = () => new Error('schema-invalid: response payload did not satisfy the expected schema');

async function runBaselineFailureScenario({ probeResult = 'ok', attemptErrorFactory }) {
  const original = {
    execFileSync: _deps.execFileSync,
    runIteration: _deps.runIteration,
    sleep: _deps.sleep,
  };
  const workingDir = createTempGitRepo();
  const session = createSessionDir(workingDir);
  const ctx = makeContext(session.dir, session.runnerState, workingDir);
  let measurementCalls = 0;

  _deps.runIteration = async () => ({
    completion: 'success',
    timedOut: false,
    exitCode: 0,
    wallSeconds: 1,
  });
  _deps.sleep = async () => {};
  _deps.execFileSync = (_cmd, args) => {
    if (Array.isArray(args) && args[0] === '--version') {
      if (probeResult === 'timeout') throw makeEtimedoutError();
      if (probeResult === 'missing') throw makeEnoentError();
      if (probeResult === 'failed') throw attemptErrorFactory();
      return 'Claude Code 2.1.126';
    }
    measurementCalls++;
    throw attemptErrorFactory();
  };

  try {
    await assert.rejects(
      executeGapAnalysis(readMicroverseState(session.dir), ctx),
      (err) => err?.name === 'MicroverseExitError',
    );
    return {
      persisted: readMicroverseState(session.dir),
      measurementCalls,
    };
  } finally {
    _deps.execFileSync = original.execFileSync;
    _deps.runIteration = original.runIteration;
    _deps.sleep = original.sleep;
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

describe('microverse-baseline-classification', () => {
  test('all attempts ETIMEDOUT -> judge_timeout transient', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeEtimedoutError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'judge_timeout');
    assert.equal(persisted.status, 'stopped');
    assert.equal(isMicroverseFailureExit(persisted.exit_reason), false);
  });

  test('ENOENT -> judge_cli_missing fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeEnoentError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'judge_cli_missing');
    assert.equal(persisted.status, 'stopped');
    assert.equal(isMicroverseFailureExit(persisted.exit_reason), true);
  });

  test('unsupported-model -> baseline_unmeasurable_unrecoverable fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeUnsupportedModelError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'baseline_unmeasurable_unrecoverable');
    assert.equal(persisted.status, 'stopped');
    assert.equal(isMicroverseFailureExit(persisted.exit_reason), true);
  });

  test('schema-invalid -> baseline_unmeasurable_unrecoverable fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeSchemaInvalidError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'baseline_unmeasurable_unrecoverable');
    assert.equal(persisted.status, 'stopped');
    assert.equal(isMicroverseFailureExit(persisted.exit_reason), true);
  });
});
