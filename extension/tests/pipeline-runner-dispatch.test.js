import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  main,
  setupPhase,
} from '../bin/pipeline-runner.js';

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function writeBaseState(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: true,
    backend: 'claude',
  }, null, 2));
}

function writePipeline(sessionDir, repo, phases, extra = {}) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    ignore_dirty_paths: ['prds', 'docs'],
    ...extra,
  }, null, 2));
}

function makeSession(phases, extra = {}) {
  const repo = tmpDir('pipeline-dispatch-repo-');
  const sessionDir = tmpDir('pipeline-dispatch-session-');
  initRepo(repo);
  writeBaseState(sessionDir, repo);
  writePipeline(sessionDir, repo, phases, extra);
  return { repo, sessionDir };
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
}

function cleanup(paths) {
  for (const p of paths) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

describe('pipeline phase config dispatch', () => {
  test('setupPhase returns expected config for each phase', () => {
    const config = {
      phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      szechuan_domain: 'typescript',
      szechuan_focus: 'error handling',
      ignore_dirty_paths: [],
    };

    const pickle = setupPhase('pickle', config);
    assert.equal(pickle.runnerScript, 'mux-runner.js');
    assert.equal(pickle.setup, null);
    assert.equal(pickle.throwOnEmptyScope, false);
    const pickleState = { chain_meeseeks: true };
    pickle.preSpawnStateMutation(pickleState);
    assert.equal(pickleState.chain_meeseeks, false);

    const anatomy = setupPhase('anatomy-park', config);
    assert.equal(anatomy.prevPhase, 'pickle');
    assert.equal(anatomy.runnerScript, 'microverse-runner.js');
    assert.equal(typeof anatomy.setup, 'function');
    assert.equal(anatomy.refreshScope, true);
    assert.equal(anatomy.throwOnEmptyScope, true);
    assert.equal(anatomy.preSpawnStateMutation, null);

    const szechuan = setupPhase('szechuan-sauce', config);
    assert.equal(szechuan.prevPhase, 'anatomy-park');
    assert.equal(szechuan.runnerScript, 'microverse-runner.js');
    assert.deepEqual(szechuan.setupExtraArgs, { domain: 'typescript', focus: 'error handling' });
    assert.equal(szechuan.throwOnEmptyScope, false);
    assert.equal(szechuan.preSpawnStateMutation, null);
  });

  test('main dispatches pickle through mux-runner without spawning a real runner', async () => {
    const { repo, sessionDir } = makeSession(['pickle']);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'node');
      assert.ok(calls[0].args[0].endsWith(path.join('extension', 'bin', 'mux-runner.js')));
      assert.equal(calls[0].args[1], sessionDir);
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.chain_meeseeks, false);
      assert.equal(state.command_template, 'pickle.md');
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main dispatches anatomy-park through microverse-runner after setup', async () => {
    const { repo, sessionDir } = makeSession(['anatomy-park']);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[0].endsWith(path.join('extension', 'bin', 'microverse-runner.js')));
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      assert.ok(fs.existsSync(path.join(sessionDir, 'anatomy-park.json')));
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.command_template, 'anatomy-park.md');
      assert.equal(state.max_iterations, 100);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main dispatches szechuan-sauce through microverse-runner with domain and focus setup', async () => {
    const { repo, sessionDir } = makeSession(['szechuan-sauce'], {
      szechuan_domain: 'typescript',
      szechuan_focus: 'small functions',
    });
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[0].endsWith(path.join('extension', 'bin', 'microverse-runner.js')));
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      assert.ok(fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8').includes('small functions'));
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.command_template, 'szechuan-sauce.md');
      assert.equal(state.max_iterations, 50);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main preserves anatomy-park empty scope failure', async () => {
    const { repo, sessionDir } = makeSession(['anatomy-park']);
    const head = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1,
      mode: 'branch',
      strategy: 'strict',
      base_ref: 'main',
      base_sha: head,
      head_sha: head,
      allowed_paths: [],
      resolved_at: new Date().toISOString(),
      refresh_history: [],
    }, null, 2));
    __setSpawnRunnerForTests(async () => {
      throw new Error('runner should not be called');
    });
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      await assert.rejects(
        () => main(sessionDir),
        (err) => err && err.name === 'ScopeError' && err.code === 'SCOPE_EMPTY_POST_BUILD',
      );
      const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(status.status, 'failed');
      assert.equal(status.current_phase, 'anatomy-park');
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      cleanup([repo, sessionDir]);
    }
  });
});
