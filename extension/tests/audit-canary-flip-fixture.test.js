// @tier: integration
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
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'extension', 'scripts', 'audit-canary-flip.sh');
const CANARY_PATH = 'extension/tests/sample-canary.test.js';

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

function writeCanary(repo, content) {
  const fullPath = path.join(repo, CANARY_PATH);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'audit-canary-flip-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeCanary(repo, 'import { test } from "node:test";\n\ntest("seed", () => {});\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function commit(repo, message) {
  git(repo, ['add', '.']);
  git(repo, ['commit', '--no-gpg-sign', '-m', message]);
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

function parentCanary(marker = 't.todo("xfail until fixed");') {
  return [
    'import { test } from "node:test";',
    '',
    marker,
    'test("canary", () => {',
    '  throw new Error("known failure");',
    '});',
    '',
  ].join('\n');
}

function passingCanary() {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    '',
    'test("canary", () => {',
    '  assert.equal(1 + 1, 2);',
    '});',
    '',
  ].join('\n');
}

function failingCanary() {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    '',
    'test("canary", () => {',
    '  assert.equal(1 + 1, 3);',
    '});',
    '',
  ].join('\n');
}

function unmarkedKnownFailure() {
  return [
    'import { test } from "node:test";',
    '',
    'test("canary", () => {',
    '  throw new Error("known failure without marker");',
    '});',
    '',
  ].join('\n');
}

function fixMessage(subject = 'fix canary') {
  return [subject, '', `Canary: ${CANARY_PATH}`].join('\n');
}

test('audit-canary-flip accepts a well-flipped canary', () => {
  withRepo((repo, mergeBase) => {
    writeCanary(repo, parentCanary());
    commit(repo, 'add failing canary with xfail marker');
    writeCanary(repo, passingCanary());
    const sha = commit(repo, fixMessage());

    const result = runAudit(repo, mergeBase);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), sha);
  });
});

test('audit-canary-flip fails when parent canary has no xfail marker', () => {
  withRepo((repo, mergeBase) => {
    writeCanary(repo, unmarkedKnownFailure());
    commit(repo, 'add canary without marker');
    writeCanary(repo, passingCanary());
    const sha = commit(repo, fixMessage('fix without xfail flip'));

    const result = runAudit(repo, mergeBase);

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${sha} ${CANARY_PATH} missing-parent-xfail-marker`));
  });
});

test('audit-canary-flip fails when the fix commit keeps the marker', () => {
  withRepo((repo, mergeBase) => {
    writeCanary(repo, parentCanary());
    commit(repo, 'add failing canary with xfail marker');
    writeCanary(repo, parentCanary('t.todo("still marked");'));
    const sha = commit(repo, fixMessage('marker not removed'));

    const result = runAudit(repo, mergeBase);

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${sha} ${CANARY_PATH} xfail-marker-still-present`));
  });
});

test('audit-canary-flip fails when the flipped canary does not pass', () => {
  withRepo((repo, mergeBase) => {
    writeCanary(repo, parentCanary());
    commit(repo, 'add failing canary with xfail marker');
    writeCanary(repo, failingCanary());
    const sha = commit(repo, fixMessage('test still fails'));

    const result = runAudit(repo, mergeBase);

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${sha} ${CANARY_PATH} canary-test-failed`));
  });
});
