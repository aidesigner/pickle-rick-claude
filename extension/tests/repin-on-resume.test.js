// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertCleanWorkingTree } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// A real git repo is required because re-pinning reads working-dir HEAD.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-repin-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'first'], repo);
  return repo;
}

const SETUP = path.resolve(__dirname, '../bin/setup.js');

function setup(args, repo, dataRoot) {
  // PICKLE_DATA_ROOT sandboxes every setup.js session write into a tmp dir (R-PTSB).
  return execFileSync(process.execPath, [SETUP, ...args], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
}

function sessionRoot(output) {
  const match = output.match(/SESSION_ROOT=(.+)/);
  if (!match) throw new Error(`SESSION_ROOT not found:\n${output}`);
  return match[1].trim();
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

function withFixture(fn) {
  const repo = makeRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-repin-data-'));
  try {
    const sp = sessionRoot(setup(['--tmux', '--task', 'repin-fixture'], repo, dataRoot));
    fn({ repo, dataRoot, sp, statePath: path.join(sp, 'state.json') });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// Stamp a stale pin directly onto state.json (test-only raw write is fine).
function poisonPin(statePath) {
  const s = readState(statePath);
  s.pinned_branch = 'dead-branch';
  s.pinned_sha = '0000000000000000000000000000000000000000';
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}

function advanceRepo(repo) {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(['commit', '-qam', 'second'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

test('repin-on-resume: stale pin (≠ HEAD) is re-derived from working-dir HEAD', () => {
  withFixture(({ repo, dataRoot, sp, statePath }) => {
    poisonPin(statePath);
    const headSha = advanceRepo(repo);

    setup(['--resume', sp], repo, dataRoot);

    const resumed = readState(statePath);
    assert.equal(resumed.pinned_sha, headSha, 'pinned_sha must re-derive from HEAD');
    assert.equal(resumed.pinned_branch, 'main', 'pinned_branch must re-derive from HEAD');
  });
});

test('repin-on-resume: matching pin is left unchanged on plain --resume', () => {
  withFixture(({ repo, dataRoot, sp, statePath }) => {
    const before = readState(statePath);
    assert.equal(before.pinned_branch, 'main');
    const headSha = git(['rev-parse', 'HEAD'], repo);
    assert.equal(before.pinned_sha, headSha, 'bootstrap pin must already match HEAD');

    setup(['--resume', sp], repo, dataRoot);

    const after = readState(statePath);
    assert.equal(after.pinned_sha, before.pinned_sha, 'matching pin sha unchanged');
    assert.equal(after.pinned_branch, before.pinned_branch, 'matching pin branch unchanged');
  });
});

test('repin-on-resume: --repin forces re-derive even when pin was poisoned', () => {
  withFixture(({ repo, dataRoot, sp, statePath }) => {
    const headSha = git(['rev-parse', 'HEAD'], repo);
    poisonPin(statePath);

    setup(['--resume', '--repin', sp], repo, dataRoot);

    const after = readState(statePath);
    assert.equal(after.pinned_sha, headSha, '--repin must re-derive pinned_sha from HEAD');
    assert.equal(after.pinned_branch, 'main', '--repin must re-derive pinned_branch from HEAD');
  });
});

test('repin-on-resume: dirty-tree guard copy names --repin', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n');
    assert.throws(
      () => assertCleanWorkingTree(repo, []),
      (err) => {
        assert.match(err.message, /Dirty files:/, 'preserves the Dirty files: anchor');
        assert.match(err.message, /--repin/, 'names --repin as the remedy');
        return true;
      },
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
