// @tier: fast
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  applyStrictPhasesOverride,
  isFatalPhaseFailure,
  recordRecoverablePhaseFailure,
  shouldHaltAfterPhase,
} from '../bin/pipeline-runner.js';
import { MICROVERSE_FATAL_REASONS } from '../types/index.js';

const TMP_DIRS = new Set();

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo({ createFollowupCommit = false } = {}) {
  const repo = tmpDir('pipeline-phase-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'service.ts'), 'export const value = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  if (createFollowupCommit) {
    fs.writeFileSync(path.join(repo, 'service.ts'), 'export const value = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'followup'], repo);
  }
  return { repo, startCommit };
}

function writeState(sessionDir, repo, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'phase halt test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'claude',
    ...overrides,
  }, null, 2));
  return statePath;
}

function makeRuntime({
  createFollowupCommit = false,
  stateOverrides = {},
  configOverrides = {},
} = {}) {
  const sessionDir = tmpDir('pipeline-phase-session-');
  const { repo, startCommit } = makeRepo({ createFollowupCommit });
  const statePath = writeState(sessionDir, repo, {
    start_commit: startCommit,
    ...stateOverrides,
  });
  return {
    runtime: {
      sessionDir,
      extensionRoot: process.cwd(),
      statePath,
      config: {
        phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
        target: repo,
        anatomy_stall_limit: 3,
        szechuan_stall_limit: 5,
        anatomy_max_iterations: 100,
        szechuan_max_iterations: 50,
        citadel_strict: false,
        ignore_dirty_paths: ['prds', 'docs'],
        ...configOverrides,
      },
      target: repo,
      workingDir: repo,
      backend: 'claude',
      phaseEnv: {},
      log: () => {},
    },
    sessionDir,
  };
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('shouldHaltAfterPhase', () => {
  test('shouldHaltAfterPhase pickle continue when commits exist after start_commit', () => {
    const { runtime } = makeRuntime({ createFollowupCommit: true });

    assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), false);
  });

  test('shouldHaltAfterPhase pickle halt when zero commits exist after start_commit', () => {
    const { runtime } = makeRuntime();

    assert.equal(isFatalPhaseFailure('pickle', runtime), true);
    assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), true);
  });

  test('shouldHaltAfterPhase anatomy fatal when exit_reason is judge_cli_missing', () => {
    const { runtime } = makeRuntime({
      stateOverrides: { exit_reason: 'judge_cli_missing' },
    });

    assert.ok(MICROVERSE_FATAL_REASONS.includes('judge_cli_missing'));
    assert.equal(isFatalPhaseFailure('anatomy-park', runtime), true);
    assert.equal(shouldHaltAfterPhase('anatomy-park', 1, runtime), true);
  });

  test('shouldHaltAfterPhase citadel unchanged for high finding in strict mode', () => {
    const { runtime, sessionDir } = makeRuntime({
      configOverrides: { citadel_strict: true },
    });
    fs.writeFileSync(path.join(sessionDir, 'citadel_report.json'), JSON.stringify({
      findings: [{ severity: 'High' }],
      summary: { total: 1 },
      exitCode: 1,
    }, null, 2));

    assert.equal(shouldHaltAfterPhase('citadel', 1, runtime), true);
  });
});

test('strict-phases cli override persists state.pipeline_continue_on_phase_fail=false', () => {
  const { repo } = makeRepo();
  const sessionDir = tmpDir('pipeline-phase-session-');
  const statePath = writeState(sessionDir, repo, {
    schema_version: 3,
    pipeline_continue_on_phase_fail: true,
  });

  const changed = applyStrictPhasesOverride(statePath, true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  assert.equal(changed, true);
  assert.equal(state.pipeline_continue_on_phase_fail, false);
});

test('strict-phases cli override is a no-op when strict mode is not requested', () => {
  const { repo } = makeRepo();
  const sessionDir = tmpDir('pipeline-phase-session-');
  const statePath = writeState(sessionDir, repo, {
    schema_version: 3,
    pipeline_continue_on_phase_fail: true,
  });

  const changed = applyStrictPhasesOverride(statePath, false);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  assert.equal(changed, false);
  assert.equal(state.pipeline_continue_on_phase_fail, true);
});

test('recoverable_phase_failure emitted on every non-fatal exit during simulated 4-phase pipeline', () => {
  const { runtime } = makeRuntime({ createFollowupCommit: true });
  const phases = runtime.config.phases;

  recordRecoverablePhaseFailure(runtime, 'pickle', 1, phases.indexOf('pickle'), 'continue');
  fs.writeFileSync(runtime.statePath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8')),
    exit_reason: 'judge_timeout',
  }, null, 2));
  recordRecoverablePhaseFailure(runtime, 'anatomy-park', 1, phases.indexOf('anatomy-park'), 'continue');
  fs.writeFileSync(runtime.statePath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8')),
    exit_reason: 'error',
  }, null, 2));
  recordRecoverablePhaseFailure(runtime, 'szechuan-sauce', 1, phases.indexOf('szechuan-sauce'), 'continue');

  const state = JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8'));
  const events = state.activity.filter((entry) => entry.event === 'recoverable_phase_failure');

  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((entry) => entry.phase),
    ['pickle', 'anatomy-park', 'szechuan-sauce'],
  );
  assert.deepEqual(events[0].downstream_phases_remaining, ['citadel', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(events[1].downstream_phases_remaining, ['szechuan-sauce']);
  assert.deepEqual(events[2].downstream_phases_remaining, []);
  assert.equal(events[0].reason, 'non-fatal pickle exit, commits present');
  assert.equal(events[0].fatal, false);
  assert.equal(events[0].decision, 'continue');
});
