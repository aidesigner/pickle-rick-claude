// @tier: fast
//
// Regression: walkDiff runs UNwrapped by safeRunAnalyzer (audit-runner.ts:84),
// and its per-file `git diff`/`git blame` calls previously used the default
// check=true, which throws on a non-zero git exit. A submodule/gitlink pointer
// in the diff makes `git blame -L 1,1 HEAD -- <gitlink>` exit 128 ("fatal: no
// such path"), so one such entry crashed the ENTIRE Citadel audit. The fix
// makes those per-file calls fail soft so the file degrades to empty metadata
// while every other changed file (and every downstream analyzer) survives.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkDiff } from '../services/citadel/diff-walker.js';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...options.env },
  }).trim();
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diff-walker-gitlink-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'user.email', 'test@test.local']);
  git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

function commit(repo, message) {
  git(repo, ['commit', '-q', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
  });
  return git(repo, ['rev-parse', 'HEAD']);
}

describe('walkDiff — un-blameable changed file (gitlink)', () => {
  test('a submodule/gitlink pointer in the diff does not crash walkDiff', () => {
    const repo = createRepo();
    try {
      fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      git(repo, ['add', '.']);
      const base = commit(repo, 'base');

      // Add a gitlink (mode 160000) pointing at the base commit. `git diff
      // --name-status` reports it Added and `--unified=0` yields a +1 hunk, but
      // `git blame HEAD -- sub` fails with exit 128 because the path is a
      // submodule pointer, not a blameable blob.
      fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2;\n');
      git(repo, ['add', 'b.ts']);
      git(repo, ['update-index', '--add', '--cacheinfo', `160000,${base},sub`]);
      commit(repo, 'add gitlink and sibling');

      // Must not throw — pre-fix this propagated out of walkDiff and crashed
      // the whole buildCitadelAuditReport.
      const summary = walkDiff(`${base}..HEAD`, { repoRoot: repo });

      const paths = summary.changedFiles.map((file) => file.path);
      assert.ok(paths.includes('sub'), 'gitlink path should still appear as a changed file');
      assert.ok(paths.includes('b.ts'), 'sibling file should still be processed');

      const sub = summary.changedFiles.find((file) => file.path === 'sub');
      // Blame degraded to empty for the un-blameable gitlink, audit still ran.
      assert.deepEqual(sub.blame, []);

      // The healthy sibling still gets real blame — fail-soft is scoped to the
      // problematic file, not a blanket disable.
      const sibling = summary.changedFiles.find((file) => file.path === 'b.ts');
      assert.equal(sibling.blame.length, 1);
      assert.equal(sibling.blame[0].author, 'Test User');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
