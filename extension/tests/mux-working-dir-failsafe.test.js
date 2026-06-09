// @tier: integration
// AC-2 source fail-safe for missing working_dir on git-mutating paths (ticket b0752ffd).
// Verifies (a) the ExitReason union + isFailureExit invariant for
// 'state_working_dir_missing', and (b) the PICKLE_TEST_MODE tmpdir assertion in
// commitAndContinueDoneFlip (mux-runner) and resetToSha (git-utils) throws BEFORE
// any git mutation when workingDir is outside os.tmpdir().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { isFailureExit, commitAndContinueDoneFlip } from '../bin/mux-runner.js';
import { resetToSha } from '../services/git-utils.js';

function makeTmpGitRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mux-wd-failsafe-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  return dir;
}

describe('AC-2 working_dir fail-safe', () => {
  test('(a) ExitReason/isFailureExit invariant includes state_working_dir_missing', () => {
    // isFailureExit is typed over ExitReason; if 'state_working_dir_missing' were
    // not a member of the union, tsc would reject the call below (compile-time
    // proof). Runtime proof: it classifies as a failure exit.
    assert.equal(isFailureExit('state_working_dir_missing'), true);
    // Negative control: an unrelated string is NOT a failure exit.
    assert.equal(isFailureExit('success'), false);
  });

  test('(b) commitAndContinueDoneFlip throws on non-tmpdir workingDir under PICKLE_TEST_MODE before any git mutation', () => {
    const prior = process.env.PICKLE_TEST_MODE;
    process.env.PICKLE_TEST_MODE = '1';
    try {
      // A non-tmpdir path (repo root). The assertion is the FIRST statement in the
      // function body, so it must throw before any `git add`/commit touches disk.
      assert.throws(
        () => commitAndContinueDoneFlip({
          sessionDir: '/nonexistent-session',
          ticketId: 'deadbeef',
          workingDir: process.cwd(),
          statePath: '/nonexistent-session/state.json',
          flags: null,
          log: () => {},
        }),
        /R-WSRC-4|os\.tmpdir/,
      );
    } finally {
      if (prior === undefined) delete process.env.PICKLE_TEST_MODE;
      else process.env.PICKLE_TEST_MODE = prior;
    }
  });

  test('(b) resetToSha throws on non-tmpdir cwd under PICKLE_TEST_MODE before any git mutation', () => {
    const prior = process.env.PICKLE_TEST_MODE;
    process.env.PICKLE_TEST_MODE = '1';
    try {
      assert.throws(
        () => resetToSha('HEAD', process.cwd()),
        /R-WSRC-4|os\.tmpdir/,
      );
    } finally {
      if (prior === undefined) delete process.env.PICKLE_TEST_MODE;
      else process.env.PICKLE_TEST_MODE = prior;
    }
  });

  test('(b) resetToSha does NOT throw the tmpdir assertion for a real tmp git repo under PICKLE_TEST_MODE', () => {
    const repo = makeTmpGitRepo();
    const prior = process.env.PICKLE_TEST_MODE;
    process.env.PICKLE_TEST_MODE = '1';
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
      // A tmpdir-rooted cwd passes the assertion; reset to its own HEAD is a no-op
      // mutation that must not raise the R-WSRC-4 guard.
      assert.doesNotThrow(() => resetToSha(head, repo));
    } finally {
      if (prior === undefined) delete process.env.PICKLE_TEST_MODE;
      else process.env.PICKLE_TEST_MODE = prior;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
