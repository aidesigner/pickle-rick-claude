// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StateManager } from '../services/state-manager.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
}

function buildState(sessionDir, repo, overrides = {}) {
  return {
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'signal attribution test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    ...overrides,
  };
}

function writeState(sessionDir, repo, overrides = {}) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify(buildState(sessionDir, repo, overrides), null, 2),
  );
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    ignore_dirty_paths: ['prds', 'docs'],
  }, null, 2));
}

function writeBlockingNode(binDir, tracePath) {
  const fakeNodePath = path.join(binDir, 'node');
  fs.writeFileSync(fakeNodePath, `#!/bin/sh
printf '%s|%s\\n' "$$" "$*" >> ${JSON.stringify(tracePath)}
trap 'exit 0' TERM INT HUP
while :; do
  sleep 1
done
`);
  fs.chmodSync(fakeNodePath, 0o755);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForExit(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for pid ${child.pid} to exit`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function readActivityEvents(activityRoot) {
  const files = fs.existsSync(activityRoot)
    ? fs.readdirSync(activityRoot).filter(file => file.endsWith('.jsonl'))
    : [];
  assert.equal(files.length, 1, 'expected one activity jsonl file in the temp data root');
  const content = fs.readFileSync(path.join(activityRoot, files[0]), 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function runSigintScenario() {
  const repo = tmpDir('pipeline-signal-repo-');
  const sessionDir = tmpDir('pipeline-signal-session-');
  const dataRoot = tmpDir('pipeline-signal-data-');
  const fakeBinDir = tmpDir('pipeline-signal-bin-');
  const childTracePath = path.join(sessionDir, 'fake-node.log');

  initRepo(repo);
  writeState(sessionDir, repo);
  writePipeline(sessionDir, repo);
  writeBlockingNode(fakeBinDir, childTracePath);

  const runner = spawn(process.execPath, [
    path.join(process.cwd(), 'bin', 'pipeline-runner.js'),
    sessionDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PICKLE_DATA_ROOT: dataRoot,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  runner.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  runner.stderr?.on('data', chunk => { stderr += chunk.toString(); });

  try {
    assert.ok(runner.pid, 'pipeline-runner subprocess must spawn');
    await waitFor(
      () => fs.existsSync(childTracePath) && fs.readFileSync(childTracePath, 'utf-8').trim(),
      30000,
      'fake phase child to start',
    );
    runner.kill('SIGINT');
    const exit = await waitForExit(runner, 30000);
    const activityEvents = readActivityEvents(path.join(dataRoot, 'activity'));
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    const childTrace = fs.readFileSync(childTracePath, 'utf-8');
    return {
      activityEvents,
      childTrace,
      exit,
      runnerLog,
      sessionDir,
      state,
      stdout,
      stderr,
    };
  } finally {
    if (runner.exitCode === null && !runner.killed) {
      runner.kill('SIGKILL');
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

test('signal_received activity event carries the implemented attribution payload after SIGINT', async () => {
  const result = await runSigintScenario();
  assert.notEqual(result.exit.code, 0, 'SIGINT shutdown should not exit 0');
  assert.match(result.childTrace, /mux-runner\.js/, 'expected the fake node shim to intercept the phase child spawn');

  const signalEvent = result.activityEvents.find(event => event.event === 'signal_received');
  assert.ok(signalEvent, `expected signal_received event; stderr=${result.stderr}`);
  assert.equal(signalEvent.source, 'pickle');
  assert.equal(signalEvent.session, path.basename(result.sessionDir));
  assert.equal(signalEvent.signal, 'SIGINT');
  assert.equal(typeof signalEvent.pid, 'number');
  assert.equal(typeof signalEvent.ppid, 'number');
  assert.equal(typeof signalEvent.is_tty, 'boolean');
  assert.ok(signalEvent.pgid === null || typeof signalEvent.pgid === 'number');
  assert.equal(typeof signalEvent.active_child_pid, 'number');
  assert.equal(typeof signalEvent.active_child_cmd, 'string');
  assert.equal(typeof signalEvent.current_phase, 'string');
  assert.equal(typeof signalEvent.received_at_iso, 'string');
  assert.ok(Array.isArray(signalEvent.handler_stack));
});

test('SIGINT shutdown stamps state.json with the specific signal exit_reason', async () => {
  const result = await runSigintScenario();
  assert.equal(result.state.exit_reason, 'signal:SIGINT');
});

test('SIGINT shutdown writes both signal log lines to pipeline-runner.log', async () => {
  const result = await runSigintScenario();
  assert.match(result.runnerLog, /Received SIGINT — shutting down pipeline/);
  assert.match(result.runnerLog, /signal_received \{/);
});

test('StateManager.read migrates legacy signal exit_reason to signal:SIGINT', () => {
  const sessionDir = tmpDir('pipeline-signal-migration-');
  const statePath = path.join(sessionDir, 'state.json');

  try {
    fs.writeFileSync(statePath, JSON.stringify(buildState(sessionDir, sessionDir, {
      exit_reason: 'signal',
    }), null, 2));

    const sm = new StateManager();
    const loaded = sm.read(statePath);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(loaded.exit_reason, 'signal:SIGINT');
    assert.equal(persisted.exit_reason, 'signal:SIGINT');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
