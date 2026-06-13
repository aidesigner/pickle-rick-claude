// @tier: fast
/**
 * AC-ICP-02 — pipeline-runner halts the pipeline and stamps
 * state.exit_reason = 'pipeline_phase_incomplete' when a phase runner exits
 * with code 3 (PipelineRunnerExitCode.PhaseIncomplete). The unfinished ticket
 * list is written to the pipeline log.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  main,
} from '../bin/pipeline-runner.js';
import { PipelineRunnerExitCode } from '../types/index.js';

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

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
}

function writeState(sessionDir, repo, overrides = {}) {
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
    original_prompt: 'halt test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    ...overrides,
  }, null, 2));
}

function writePipeline(sessionDir, repo, phases = ['pickle']) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function writeTicket(sessionDir, id, order) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `linear_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: Halt test ticket ${id}\nstatus: Todo\norder: ${order}\n---\n\n# Test\n`,
  );
}

async function captureMainExit(sessionDir, expectedCode) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === expectedCode,
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

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('PipelineRunnerExitCode.PhaseIncomplete equals 3', () => {
  assert.equal(PipelineRunnerExitCode.PhaseIncomplete, 3);
  assert.equal(PipelineRunnerExitCode.Success, 0);
  assert.equal(PipelineRunnerExitCode.Failure, 1);
});

test('pipeline-runner.halt-on-incomplete-phase', async () => {
  const repo = tmpDir('pipeline-halt-repo-');
  const sessionDir = tmpDir('pipeline-halt-session-');
  try {
    initRepo(repo);
    writeState(sessionDir, repo);
    writePipeline(sessionDir, repo, ['pickle']);

    // Write 3 Todo tickets so reportPhaseIncomplete has something to list
    writeTicket(sessionDir, 'aaa11111', 1);
    writeTicket(sessionDir, 'bbb22222', 2);
    writeTicket(sessionDir, 'ccc33333', 3);

    // Stub: simulate mux-runner capping without EPIC_COMPLETED — exits 3
    __setSpawnRunnerForTests(async () => {
      // mux-runner records iteration_cap_exhausted before exiting 3
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'iteration_cap_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 3, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, 3);

    // state.exit_reason must be pipeline_phase_incomplete (not iteration_cap_exhausted)
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'pipeline-runner must stamp pipeline_phase_incomplete, not iteration_cap_exhausted',
    );

    // pipeline-runner.log must mention unfinished ticket count
    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /hit iteration cap/.test(log) || /iteration cap/.test(log),
      'log must contain iteration cap message',
    );
    assert.ok(
      /unfinished/.test(log) || /remain/.test(log),
      'log must mention unfinished ticket count',
    );

    // All 3 tickets must still be Todo (pipeline did not falsely complete them)
    for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) {
      const ticketFile = path.join(sessionDir, id, `linear_ticket_${id}.md`);
      const content = fs.readFileSync(ticketFile, 'utf-8');
      assert.ok(content.includes('status: Todo'), `ticket ${id} must remain Todo after pipeline halt`);
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
