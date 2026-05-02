import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { handleWorkerManagedIteration } = await import(
  path.resolve(__dirname, '../../bin/microverse-runner.js')
);

// Manual live rerun outside CI, if this bounded fixture is not enough:
// /pickle-pipeline --backend codex "rerun Anatomy-park missing-baseline recovery against the target PRD"

function makeMv(overrides = {}) {
  return {
    status: 'iterating',
    prd_path: 'prd.md',
    key_metric: {
      description: 'test',
      validation: 'echo 1',
      type: 'command',
      timeout_seconds: 30,
      tolerance: 1,
    },
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

function makeGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function writeFixtureRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'anatomy-park-baseline-recovery-fixture',
    private: true,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'module.exports = 1;\n');
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function makeGateResult(status = 'green', failures = [], extra = {}) {
  return {
    status,
    failures,
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 10,
    total_raw_failure_count: failures.length,
    new_failures_vs_baseline: failures.length,
    ...extra,
  };
}

function writeBaseline(baselinePath, workingDir, failures = []) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: workingDir,
    project_type: 'npm',
    checks: ['typecheck', 'lint', 'tests'],
    failures,
  }, null, 2));
}

function makeFailure(workingDir) {
  return {
    check: 'lint',
    file: path.join(workingDir, 'src', 'index.js'),
    line: 1,
    ruleOrCode: 'no-simulated-regression',
    message: 'simulated regression',
    severity: 'error',
    occurrence_index: 0,
  };
}

function writeConvergedAnatomyPark(sessionDir, reason = 'clean passes done') {
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
    converged: true,
    reason,
  }));
}

test('microverse-runner.recapture-attempted microverse-runner.recapture-succeeded: Anatomy-park recaptures a missing baseline after commit before final worker exit', async () => {
  const workingDir = makeGitRepo('ap-baseline-recovery-ok-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-baseline-recovery-ok-session-'));

  try {
    writeFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');
    const preIterSha = headSha(workingDir);

    fs.writeFileSync(path.join(workingDir, 'src', 'index.js'), 'module.exports = 2;\n');
    commitAll(workingDir, 'iteration updates subsystem');
    const postIterSha = headSha(workingDir);
    const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
    writeConvergedAnatomyPark(sessionDir);

    const events = [];
    const calls = [];
    const logs = [];

    const result = await handleWorkerManagedIteration({
      currentMv: makeMv({
        convergence: {
          stall_limit: 3,
          stall_counter: 0,
          history: [{
            iteration: 2,
            score: 100,
            action: 'accept',
            description: 'scored worker convergence',
            commit: postIterSha,
            pre_iteration_sha: preIterSha,
            timestamp: new Date().toISOString(),
          }],
        },
      }),
      preIterSha,
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      regressionWarningThreshold: 5,
      backend: 'claude',
      remediatorTimeoutS: 60,
      iteration: 3,
      log: (msg) => logs.push(msg),
      _deps: {
        getHeadShaFn: () => postIterSha,
        runGateFn: async (opts) => {
          calls.push({
            mode: opts.mode,
            scope: opts.scope,
            baselinePath: opts.baselinePath,
            head: headSha(workingDir),
          });
          if (opts.mode === 'baseline' && opts.scope === 'full') {
            opts.onEvent?.('gate_baseline_disk_check', { phase: 'pre_write', path: opts.baselinePath, exists: false });
            writeBaseline(opts.baselinePath, workingDir);
            opts.onEvent?.('gate_baseline_disk_check', { phase: 'post_write', path: opts.baselinePath, exists: true });
            opts.onEvent?.('gate_baseline_captured', { path: opts.baselinePath, failure_count: 0 });
            return makeGateResult('green', [], { total_raw_failure_count: 0, new_failures_vs_baseline: 0 });
          }
          assert.equal(opts.mode, 'baseline', 'changed gate should use baseline mode after successful recapture');
          assert.equal(opts.scope, 'changed');
          assert.equal(opts.baselinePath, baselinePath);
          opts.onEvent?.('gate_run_complete', { status: 'green', mode: 'baseline', scope: 'changed' });
          return makeGateResult('green', [], { baseline_used: true, total_raw_failure_count: 0, new_failures_vs_baseline: 0 });
        },
        runRemediatorFn: async () => { assert.fail('remediator must not run for a green recovered gate'); },
        writeMicroverseStateFn: () => {},
        logActivityFn: (event) => events.push(event),
      },
    });

    assert.equal(result.converged, true);
    assert.equal(result.reason, 'clean passes done');
    assert.equal(result.currentMv.iteration_regressions, 0);
    assert.deepEqual(
      calls.map((call) => ({ mode: call.mode, scope: call.scope })),
      [
        { mode: 'baseline', scope: 'full' },
        { mode: 'baseline', scope: 'changed' },
      ],
    );
    assert.equal(calls[0].head, preIterSha, 'recapture must run against the pre-iteration tree');
    assert.equal(calls[1].head, postIterSha, 'changed gate must run after restoring the post-iteration tree');
    assert.ok(fs.existsSync(baselinePath), 'recapture must write the missing baseline file');
    assert.ok(events.some((event) => event.event === 'gate_baseline_disk_check' && event.gate_payload?.phase === 'pre_write'));
    assert.ok(events.some((event) => event.event === 'gate_baseline_disk_check' && event.gate_payload?.phase === 'post_write'));
    assert.ok(events.some((event) => event.event === 'gate_baseline_captured'));
    assert.ok(events.some((event) => event.event === 'gate_run_complete' && event.gate_payload?.status === 'green'));
    const attemptedIndex = events.findIndex((event) => event.event === 'baseline_recapture_attempted');
    const succeededIndex = events.findIndex((event) => event.event === 'baseline_recapture_succeeded');
    assert.notEqual(attemptedIndex, -1, `expected baseline_recapture_attempted event, got ${JSON.stringify(events)}`);
    assert.notEqual(succeededIndex, -1, `expected baseline_recapture_succeeded event, got ${JSON.stringify(events)}`);
    assert.equal(events[attemptedIndex].iteration, 3);
    assert.equal(events[succeededIndex].iteration, 3);
    assert.ok(attemptedIndex < succeededIndex, 'baseline_recapture_attempted must precede baseline_recapture_succeeded');
    assert.ok(
      new Date(events[attemptedIndex].ts).getTime() < new Date(events[succeededIndex].ts).getTime(),
      'baseline_recapture_attempted timestamp must precede baseline_recapture_succeeded',
    );
    assert.ok(!events.some((event) => event.event === 'baseline_recapture_failed'));
    assert.ok(!events.some((event) => event.event === 'strict_mode_red'));
    assert.ok(
      logs.some((msg) => msg.includes('recaptured per-iteration gate baseline')),
      `expected recapture success log, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('AC-GBM-D1: Anatomy-park failed recapture falls back to strict mode with forensic events and defers convergence', async () => {
  const workingDir = makeGitRepo('ap-baseline-recovery-fail-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-baseline-recovery-fail-session-'));

  try {
    writeFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');
    const preIterSha = headSha(workingDir);

    fs.writeFileSync(path.join(workingDir, 'src', 'index.js'), 'module.exports = 3;\n');
    commitAll(workingDir, 'iteration introduces unresolved regression');
    const postIterSha = headSha(workingDir);
    const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
    writeConvergedAnatomyPark(sessionDir, 'worker reported clean');

    const events = [];
    const calls = [];
    const logs = [];
    let persistedMv;
    const failure = makeFailure(workingDir);

    const result = await handleWorkerManagedIteration({
      currentMv: makeMv(),
      preIterSha,
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      regressionWarningThreshold: 5,
      backend: 'claude',
      remediatorTimeoutS: 60,
      iteration: 4,
      log: (msg) => logs.push(msg),
      _deps: {
        getHeadShaFn: () => postIterSha,
        runGateFn: async (opts) => {
          calls.push({
            mode: opts.mode,
            scope: opts.scope,
            baselinePath: opts.baselinePath,
            head: headSha(workingDir),
          });
          if (opts.mode === 'baseline' && opts.scope === 'full') {
            opts.onEvent?.('gate_run_complete', { status: 'green', mode: 'baseline', scope: 'full' });
            return makeGateResult('green', [], { total_raw_failure_count: 0, new_failures_vs_baseline: 0 });
          }
          assert.equal(opts.mode, 'strict', 'failed recapture should fall back to strict mode');
          assert.equal(opts.scope, 'changed');
          assert.equal(opts.baselinePath, undefined);
          opts.onEvent?.('gate_run_complete', { status: 'red', mode: 'strict', scope: 'changed' });
          return makeGateResult('red', [failure], { total_raw_failure_count: 1, new_failures_vs_baseline: 1 });
        },
        runRemediatorFn: async () => ({ success: false }),
        writeMicroverseStateFn: (_, next) => { persistedMv = next; },
        logActivityFn: (event) => events.push(event),
      },
    });

    assert.equal(result.converged, false, 'final worker convergence must be deferred when strict fallback remains red');
    assert.equal(result.reason, 'per-iteration gate left unresolved regressions');
    assert.equal(result.currentMv.iteration_regressions, 1);
    assert.equal(result.currentMv.convergence.stall_counter, 1, 'strict red should record a stall');
    assert.ok(persistedMv, 'regression state must be persisted before worker convergence is deferred');
    assert.equal(persistedMv.iteration_regressions, 1, 'regression state must be persisted');
    assert.equal(fs.existsSync(baselinePath), false, 'failed recapture must not fabricate a baseline file');
    assert.deepEqual(
      calls.map((call) => ({ mode: call.mode, scope: call.scope })),
      [
        { mode: 'baseline', scope: 'full' },
        { mode: 'strict', scope: 'changed' },
      ],
    );
    assert.equal(calls[0].head, preIterSha, 'failed recapture must still inspect the pre-iteration tree');
    assert.equal(calls[1].head, postIterSha, 'strict fallback must run after restoring the post-iteration tree');
    assert.ok(events.some((event) => event.event === 'baseline_recapture_failed' && event.gate_payload?.path === baselinePath));
    assert.ok(events.some((event) => event.event === 'strict_mode_red' && event.gate_payload?.mode === 'strict'));
    assert.ok(events.some((event) => event.event === 'iteration_left_regression' && event.gate_payload?.mode === 'strict'));
    assert.ok(events.some((event) => event.event === 'gate_run_complete' && event.gate_payload?.status === 'red'));
    assert.ok(
      logs.some((msg) => msg.includes('falling back to strict mode')),
      `expected strict fallback log, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes('convergence deferred')),
      `expected final worker deferral log, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
