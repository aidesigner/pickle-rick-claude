// @tier: fast
/**
 * R-PIPE-2 / AC-PIPE-02 — pipeline-runner refuses to claim
 * `Phase pickle completed successfully` when the mux-runner stub exits clean
 * (code 0) with 0 Done tickets AND 0 commits since `state.start_commit`.
 * Stamps `state.exit_reason = 'phase_no_progress'` and exits with
 * PipelineRunnerExitCode.PhaseIncomplete (3) so auto-resume.sh can retry-loop.
 *
 * Reverse case: when at least one ticket is marked Done OR at least one
 * commit lands since `state.start_commit`, the pickle phase passes through
 * the existing success path (`state.exit_reason = 'completed'`, exit 0).
 *
 * Closes Bug #48 R-PCFG from `prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md`
 * (operator session 2026-05-18-6108815e, 13-tickets-unimplemented "green" pipeline).
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
  return git(['rev-parse', 'HEAD'], dir);
}

function writeState(sessionDir, repo, startCommit, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    start_commit: startCommit,
    completion_promise: null,
    original_prompt: 'phase_no_progress test',
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
    ignore_dirty_paths: ['prds', 'docs'],
  }, null, 2));
}

function writeTicket(sessionDir, id, order, status = 'Todo') {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `linear_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: phase_no_progress ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

test('R-PIPE-2: pickle phase clean-exit with 0 Done + 0 commits stamps phase_no_progress', async () => {
  const repo = tmpDir('pipe-pnp-repo-');
  const sessionDir = tmpDir('pipe-pnp-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // 3 Todo tickets — none Done
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    // Stub: mux-runner exits clean (code 0) without marking any ticket Done.
    // No commits made in repo. This is the exact hallucinated-completion
    // pattern observed in B-SJET-2 attempts 2026-05-18 PM.
    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'phase_no_progress',
      'pipeline-runner must stamp phase_no_progress when pickle exits clean with 0 Done + 0 commits',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /no progress \(0 Done of 3 tickets, 0 commits/.test(log),
      `log must describe the no-progress condition; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'log must NOT claim "Phase pickle completed successfully" when no progress was made',
    );

    // All 3 tickets must still be Todo
    for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) {
      const ticketFile = path.join(sessionDir, id, `linear_ticket_${id}.md`);
      const content = fs.readFileSync(ticketFile, 'utf-8');
      assert.ok(content.includes('status: Todo'), `ticket ${id} must remain Todo`);
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PIPE-2: pickle phase passes when all tickets are Done', async () => {
  const repo = tmpDir('pipe-pnp-done-repo-');
  const sessionDir = tmpDir('pipe-pnp-done-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // All tickets Done — bundle fully resolved (R-PPPA: a leftover Todo would
    // now stamp phase_incomplete_tickets instead of advancing).
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Pipeline succeeds → process.exit(0)
    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'completed',
      'pipeline-runner must stamp completed when at least one ticket is Done',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /Phase pickle completed successfully/.test(log),
      'log must claim Phase pickle completed successfully when progress happened',
    );
    assert.ok(
      !/no progress/.test(log),
      'log must NOT describe no-progress condition when a ticket is Done',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PIPE-2: pickle phase passes when commits landed since start_commit (no Done tickets)', async () => {
  const repo = tmpDir('pipe-pnp-commits-repo-');
  const sessionDir = tmpDir('pipe-pnp-commits-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // No Done tickets; ticket Skipped (terminal, not pending) + worker
    // committed something after start_commit. commitCount>0 keeps
    // phase_no_progress from firing; Skipped keeps phase_incomplete_tickets
    // from firing (R-PPPA — only Todo/In Progress count as unresolved).
    writeTicket(sessionDir, 'aaa11111', 1, 'Skipped');

    __setSpawnRunnerForTests(async () => {
      // Simulate a worker landing a real commit during the pickle phase.
      fs.writeFileSync(path.join(repo, 'worker.ts'), 'export const y = 2;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'worker change'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'completed',
      'pipeline-runner must stamp completed when a commit landed even if 0 Done',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /Phase pickle completed successfully/.test(log),
      'log must claim success when a commit landed since start_commit',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PPPA: pickle phase clean-exit with N-of-M tickets Done stamps phase_incomplete_tickets', async () => {
  const repo = tmpDir('pipe-pppa-repo-');
  const sessionDir = tmpDir('pipe-pppa-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    // 2 of 5 Done, 3 still Todo — the codex-manager hallucinated EPIC_COMPLETED
    // and mux-runner exited clean. pipeline-runner must NOT advance to citadel.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');
    writeTicket(sessionDir, 'ddd44444', 4, 'Todo');
    writeTicket(sessionDir, 'eee55555', 5, 'In Progress');

    __setSpawnRunnerForTests(async () => {
      // A worker did land a commit, so phase_no_progress does NOT fire — this
      // is exactly the N-of-M case that gate misses.
      fs.writeFileSync(path.join(repo, 'partial.ts'), 'export const z = 3;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'partial work'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'phase_incomplete_tickets',
      'pipeline-runner must stamp phase_incomplete_tickets when pickle exits clean with unresolved tickets',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /3\/5 tickets remain unresolved/.test(log),
      `log must describe the incomplete-bundle condition; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'log must NOT claim success on an incomplete bundle',
    );
    assert.ok(
      !/Phase citadel/.test(log),
      'pipeline must NOT advance to citadel on an incomplete pickle phase',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PPPA: pickle phase with Done + Skipped tickets and no pending advances normally', async () => {
  const repo = tmpDir('pipe-pppa-ok-repo-');
  const sessionDir = tmpDir('pipe-pppa-ok-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // Done + Skipped = all terminal, zero pending — a legitimately complete bundle.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Skipped');

    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.exit_reason, 'completed', 'Done + Skipped with no pending must advance');

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      !/tickets remain unresolved/.test(log),
      'Skipped tickets must not count as unresolved',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
