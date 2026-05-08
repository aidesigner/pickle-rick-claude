// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeStateFile } from '../../services/pickle-utils.js';
import { createMicroverseState } from '../../services/microverse-state.js';
import { measureLlmMetric, _deps } from '../../bin/microverse-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const INIT_PATH = path.join(EXTENSION_ROOT, 'bin', 'init-microverse.js');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'microverse-runner.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeStateFile(filePath, value);
}

function makeGitRepo(root) {
  const workingDir = path.join(root, 'repo');
  fs.mkdirSync(workingDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({ name: 'mv-judge-failure-fixture', private: true }, null, 2));
  execFileSync('git', ['add', '.'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workingDir, stdio: 'pipe' });
  return workingDir;
}

function makeRunnerState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 3,
    max_time_minutes: 10,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'microverse judge failure integration fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    command_template: 'microverse.md',
    backend: 'codex',
    schema_version: 3,
    min_iterations: 1,
  };
}

function writeChildRunner(root) {
  const childPath = path.join(root, 'run-microverse-child.mjs');
  fs.writeFileSync(childPath, [
    `import * as fs from 'node:fs';`,
    `import * as path from 'node:path';`,
    `const sessionDir = process.argv[2];`,
    `const runner = await import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)});`,
    `runner._deps.sleep = async () => {};`,
    `runner._deps.getHeadSha = () => 'fixture-sha';`,
    `runner._deps.execFileSync = (cmd, args) => {`,
    `  // Judge always uses claude binary even when session backend=codex (R-SCJM-2).`,
    `  if (cmd === 'claude') {`,
    `    fs.writeFileSync(path.join(sessionDir, 'captured-judge-argv.json'), JSON.stringify(args, null, 2));`,
    `    throw new Error('fixture judge unreachable');`,
    `  }`,
    `  return '';`,
    `};`,
    `runner._deps.runIteration = async (_sessionDir, iteration) => {`,
    `  fs.writeFileSync(path.join(_sessionDir, 'tmux_iteration_' + iteration + '.log'), 'fixture worker success\\\\n');`,
    `  if (iteration >= 1) {`,
    `    fs.writeFileSync(path.join(_sessionDir, 'microverse-result.json'), JSON.stringify({ converged: true, reason: 'fixture worker said done' }, null, 2));`,
    `  }`,
    `  return { completion: 'success', timedOut: false, exitCode: 0, wallSeconds: 1 };`,
    `};`,
    `await runner.main(sessionDir);`,
    '',
  ].join('\n'));
  return childPath;
}

test('codex backend: judge uses claude binary with default model (R-SCJM-2)', () => {
  // Regression guard for R-SCJM-2: with session backend=codex, the judge
  // must spawn via claude (not codex) and always include --model claude-sonnet-4-6.
  const originalExec = _deps.execFileSync;
  const capturedArgv = [];
  _deps.execFileSync = (cmd, args) => {
    assert.equal(cmd, 'claude', `judge must use claude binary even when session backend=codex, got: ${cmd}`);
    capturedArgv.push(args);
    throw new Error('fixture judge unreachable');
  };

  try {
    const first = measureLlmMetric('default metric fixture', 30, os.tmpdir(), undefined, [], undefined, undefined, 'codex');
    const second = measureLlmMetric('default metric fixture', 30, os.tmpdir(), undefined, [], undefined, undefined, 'codex');

    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(capturedArgv.length, 2);
    for (const argv of capturedArgv) {
      const modelIdx = argv.indexOf('--model');
      assert.ok(modelIdx >= 0, `claude judge must include --model flag: ${JSON.stringify(argv)}`);
      assert.equal(argv[modelIdx + 1], 'claude-sonnet-4-6', `judge must use DEFAULT_JUDGE_MODEL: ${JSON.stringify(argv)}`);
    }
  } finally {
    _deps.execFileSync = originalExec;
  }
});

test('microverse-runner codex worker convergence with empty history honors worker convergence for metric_type=none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-runner-judge-failure-'));
  try {
    const sessionDir = path.join(root, 'session');
    const workingDir = makeGitRepo(root);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJson(path.join(sessionDir, 'state.json'), makeRunnerState(sessionDir, workingDir));

    execFileSync(process.execPath, [
      INIT_PATH,
      sessionDir,
      workingDir,
      '--stall-limit',
      '3',
      '--convergence-mode',
      'worker',
      '--convergence-file',
      'microverse-result.json',
    ], { cwd: EXTENSION_ROOT, stdio: 'pipe' });
    const initializedMv = createMicroverseState({
      prdPath: 'prd.md',
      metric: {
        description: 'worker-managed convergence',
        validation: '',
        type: 'none',
        timeout_seconds: 30,
        tolerance: 0,
      },
      stallLimit: 3,
      convergenceMode: 'worker',
      convergenceFile: 'microverse-result.json',
    });
    initializedMv.status = 'iterating';
    initializedMv.gap_analysis_path = 'gap.md';
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(initializedMv, null, 2));
    writeJson(path.join(sessionDir, 'microverse-result.json'), { converged: false, reason: 'not started' });

    const childPath = writeChildRunner(root);
    const result = spawnSync(process.execPath, [childPath, sessionDir], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PICKLE_DATA_ROOT: path.join(root, 'pickle-data'),
      },
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, combinedOutput);
    assert.equal(fs.existsSync(path.join(sessionDir, 'captured-codex-argv.json')), false, 'worker-managed convergence must not invoke judge CLI');

    const finalMv = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(finalMv.exit_reason, 'converged');
    assert.equal(finalMv.status, 'converged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
