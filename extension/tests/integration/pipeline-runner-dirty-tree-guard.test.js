// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../bin/pipeline-runner.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function writeState(sessionDir, repo) {
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
    current_ticket: 'TICKET-1',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: true,
    backend: 'claude',
  }, null, 2));
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: [],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    ignore_dirty_paths: ['prds', 'docs'],
  }, null, 2));
}

function makeSession() {
  const repo = tmpDir('pipeline-dirty-guard-repo-');
  const sessionDir = tmpDir('pipeline-dirty-guard-session-');
  initRepo(repo);
  writeState(sessionDir, repo);
  writePipeline(sessionDir, repo);
  return { repo, sessionDir };
}

test('dirty-tree guard ignores tracked dirty files that match .gitignore', () => {
  const { repo, sessionDir } = makeSession();
  try {
    fs.writeFileSync(path.join(repo, 'foo.txt'), 'seed\n');
    git(['add', 'foo.txt'], repo);
    git(['commit', '-q', '-m', 'track file'], repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'foo.txt\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'ignore tracked file'], repo);
    fs.writeFileSync(path.join(repo, 'foo.txt'), 'changed\n');

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /\[FATAL\]/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('dirty-tree guard fatal stderr lists each blocking file on its own line', () => {
  const { repo, sessionDir } = makeSession();
  try {
    fs.writeFileSync(path.join(repo, 'alpha.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'beta.txt'), 'b\n');

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[FATAL\]/);
    assert.match(result.stderr, /Dirty files:\nalpha\.txt\nbeta\.txt\nCommit, stash, or discard changes before starting the pipeline\./);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
