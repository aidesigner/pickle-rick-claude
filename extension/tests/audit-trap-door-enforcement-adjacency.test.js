// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-trap-door-enforcement.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Pickle Rick Tests',
  GIT_AUTHOR_EMAIL: 'pickle-rick@example.invalid',
  GIT_COMMITTER_NAME: 'Pickle Rick Tests',
  GIT_COMMITTER_EMAIL: 'pickle-rick@example.invalid',
};

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
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
  const repo = mkdtempSync(path.join(tmpdir(), 'audit-adjacency-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function commit(repo, message) {
  git(repo, ['commit', '--allow-empty', '--no-gpg-sign', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function runAudit(repo) {
  return spawnSync('bash', [AUDIT_SCRIPT], {
    cwd: EXTENSION_ROOT,
    env: {
      ...process.env,
      CLOSER_AUDIT_REPO_OVERRIDE: repo,
    },
    encoding: 'utf8',
  });
}

function withRepo(fn) {
  const repo = makeRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const FULL_ADJACENCY_SECTION = [
  '',
  '## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)',
  '1. Adjacent-path enumeration: Y',
  '2. Adjacent-mode enumeration: Y',
  '3. Trap-door delta: Y',
  '4. Cross-module importer check: N/A',
  '5. Stamp-pair parity: Y',
  '6. Pre-flight context grep: Y',
].join('\n');

test('R-CLOSER-ADJACENCY-AUDIT: passes when no closer commits', () => {
  withRepo((repo) => {
    commit(repo, 'feat: add something nice');
    commit(repo, 'chore: bump version to 1.2.3');

    const result = runAudit(repo);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });
});

test('R-CLOSER-ADJACENCY-AUDIT: passes when closer commit has complete section', () => {
  withRepo((repo) => {
    const msg = [
      'fix(ab123456): R-SOME-TICKET-1 closer — fix edge case',
      FULL_ADJACENCY_SECTION,
    ].join('\n');

    commit(repo, msg);

    const result = runAudit(repo);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });
});

test('R-CLOSER-ADJACENCY-AUDIT: fails when closer commit missing section header', () => {
  withRepo((repo) => {
    const msg = 'fix(ab123456): R-SOME-TICKET-1 closer — fix edge case\n\nFixes the thing.';
    commit(repo, msg);

    const result = runAudit(repo);
    assert.notEqual(result.status, 0, 'audit should fail when adjacency section is missing');
    assert.match(result.stderr, /R-CLOSER-ADJACENCY-AUDIT/);
    assert.match(result.stderr, /missing.*Adjacency audit/);
  });
});

test('R-CLOSER-ADJACENCY-AUDIT: fails when section has fewer than 6 Y/N items', () => {
  withRepo((repo) => {
    const shortSection = [
      '',
      '## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)',
      '1. Adjacent-path enumeration: Y',
      '2. Adjacent-mode enumeration: Y',
      '3. Trap-door delta: Y',
    ].join('\n');

    const msg = [
      'fix(ab123456): R-SOME-TICKET-1 closer — incomplete audit',
      shortSection,
    ].join('\n');

    commit(repo, msg);

    const result = runAudit(repo);
    assert.notEqual(result.status, 0, 'audit should fail with only 3 Y/N items');
    assert.match(result.stderr, /R-CLOSER-ADJACENCY-AUDIT/);
    assert.match(result.stderr, /3\/6 Y\/N items/);
  });
});

test('R-CLOSER-ADJACENCY-AUDIT: detects closer commit via body reference', () => {
  withRepo((repo) => {
    // commit subject does not match closer pattern but body references the audit protocol
    const msg = [
      'docs(ab123456): R-SOME-TICKET-1 update notes',
      '',
      'This commit references R-CLOSER-ADJACENCY-AUDIT.',
      FULL_ADJACENCY_SECTION,
    ].join('\n');

    commit(repo, msg);

    const result = runAudit(repo);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });
});
