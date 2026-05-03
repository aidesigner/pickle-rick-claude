// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXTENSION_DIR, '..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'extension', 'scripts', 'audit-fix-commits.sh');

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pickle Rick Tests',
      GIT_AUTHOR_EMAIL: 'pickle-rick@example.invalid',
      GIT_COMMITTER_NAME: 'Pickle Rick Tests',
      GIT_COMMITTER_EMAIL: 'pickle-rick@example.invalid',
    },
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'audit-fix-commits-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  mkdirSync(path.join(repo, 'extension', 'tests'), { recursive: true });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function commit(repo, message) {
  git(repo, ['commit', '--allow-empty', '--no-gpg-sign', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function runAudit(repo, mergeBase) {
  return spawnSync('bash', [AUDIT_SCRIPT], {
    cwd: repo,
    env: {
      ...process.env,
      MERGE_BASE: mergeBase,
    },
    encoding: 'utf8',
  });
}

function withRepo(fn) {
  const repo = makeRepo();
  try {
    const mergeBase = git(repo, ['rev-parse', 'HEAD']);
    fn(repo, mergeBase);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('accepts well-formed Section A/B/C/D fix commits', () => {
  withRepo((repo, mergeBase) => {
    commit(repo, [
      'section a fix',
      '',
      'Resolves: prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md#R-RTC-3',
      'Test-Tier: expensive',
      'Canary: extension/tests/integration/deploy-lifecycle-soak.test.js',
    ].join('\n'));
    commit(repo, [
      'section b fix',
      '',
      'Resolves: prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md#R-RTC-4',
      'Test-Tier: integration',
      'Canary: extension/tests/integration/pipeline-empty-queue-e2e.test.js',
    ].join('\n'));
    commit(repo, [
      'section c fix',
      '',
      'Resolves: prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md#R-RTC-5',
      'Test-Tier: fast',
      'Canary: extension/tests/stop-hook-state-matrix.test.js',
    ].join('\n'));
    commit(repo, [
      'section d fix',
      '',
      'Resolves: prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md#R-RTC-8',
      'Test-Tier: contract',
      'Contract: extension/tests/contract/cli-contract.test.js',
    ].join('\n'));

    const result = runAudit(repo, mergeBase);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('fails commit missing Test-Tier trailer and cites SHA', () => {
  withRepo((repo, mergeBase) => {
    const sha = commit(repo, [
      'missing test tier',
      '',
      'Resolves: prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md#R-RTC-3',
      'Canary: extension/tests/integration/deploy-lifecycle-soak.test.js',
    ].join('\n'));

    const result = runAudit(repo, mergeBase);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${sha} missing:Test-Tier`));
  });
});

test('fails invalid requirement id', () => {
  withRepo((repo, mergeBase) => {
    commit(repo, [
      'invalid requirement',
      '',
      'Resolves: prds/foo.md#R-XYZ-1',
      'Test-Tier: fast',
      'Canary: extension/tests/stop-hook-state-matrix.test.js',
    ].join('\n'));

    const result = runAudit(repo, mergeBase);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing:Resolves/);
  });
});
