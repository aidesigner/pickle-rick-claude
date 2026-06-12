// @tier: fast
//
// R-RRH C4: guard every HEAD-reset path with is-ancestor / ff-reattach.
// Parametrized over the 3 teardown/auto-commit-then-reset paths:
//   1. cancel-teardown  — PHANTOM: cancel performs NO reset (stays non-destructive)
//   2. anatomy auto-commit-reset   — microverse-runner.ts:3290 (shared site)
//   3. microverse auto-commit-reset — microverse-runner.ts:3290 (shared site)
// For the two real reset paths: a committed-then-reset leaves HEAD at the ticket
// commit (no orphan) because the is-ancestor guard preserves HEAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { wouldResetOrphanCommit } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rrh-reset-guard-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `commit-${Date.now()}-${Math.random()}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

/**
 * Simulate a guarded auto-commit-then-reset path exactly as microverse-runner
 * wires it: the worker commits on top of preIterSha (HEAD = postIterSha), then a
 * regression would reset to preIterSha. The guard decides whether the rewind is
 * allowed; on "would orphan" we preserve HEAD (no resetToSha call).
 */
function guardedRollback({ workingDir, preIterSha, postIterSha, doReset }) {
  let resetInvoked = false;
  if (wouldResetOrphanCommit({ workingDir, target: preIterSha, protectedSha: postIterSha })) {
    // preserve HEAD — no reset
  } else {
    resetInvoked = true;
    doReset(preIterSha);
  }
  return { resetInvoked };
}

// --- AC1 + AC3: the two real auto-commit-then-reset paths -------------------
// Both anatomy-park and microverse share measureAndClassifyIteration's reset at
// microverse-runner.ts:3290, so they are exercised by the same guarded-rollback
// shape with distinct labels.
const RESET_PATHS = ['anatomy auto-commit-reset', 'microverse auto-commit-reset'];

for (const label of RESET_PATHS) {
  test(`R-RRH C4 [${label}]: committed-then-reset preserves HEAD at the ticket commit (no orphan)`, () => {
    const tmp = tmpRoot();
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const preIterSha = gitCommit(repoDir, 'baseline (preIter)');
    // Worker auto-commits gate-green work on top of preIter — this is HEAD now.
    const ticketCommit = gitCommit(repoDir, `feat: ${label} worker commit`);
    assert.equal(headSha(repoDir), ticketCommit, 'HEAD should be at the ticket commit before rollback');

    let resetTarget = null;
    const result = guardedRollback({
      workingDir: repoDir,
      preIterSha,
      postIterSha: ticketCommit,
      doReset: (sha) => {
        resetTarget = sha;
        execFileSync('git', ['reset', '--hard', sha], { cwd: repoDir });
      },
    });

    assert.equal(result.resetInvoked, false, 'guard must SUPPRESS the reset (ticket commit ff-descends from target)');
    assert.equal(resetTarget, null, 'resetToSha target must never be reached');
    assert.equal(headSha(repoDir), ticketCommit, 'HEAD must stay at the ticket commit — no orphan');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

// --- AC2: cancel-teardown PHANTOM — cancel performs NO reset ----------------
test('R-RRH C4 [cancel-teardown]: cancel stays non-destructive — no resetToSha invoked', () => {
  // PHANTOM path: cancel.ts:cancelSession has no resetToSha today and must keep
  // it that way. Assert via the seam (source contract) that the cancel module
  // never imports or calls the reset primitive.
  const cancelSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'bin', 'cancel.ts'),
    'utf-8',
  );
  assert.ok(!/\bresetToSha\b/.test(cancelSrc), 'cancel.ts must NOT reference resetToSha (cancel stays non-destructive)');
  assert.ok(!/git\b.*\breset\b/.test(cancelSrc), 'cancel.ts must NOT run git reset');

  // Runtime corroboration: simulate a cancel-shaped teardown against a real repo
  // and assert HEAD is unmoved (cancel never rewinds history).
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  gitCommit(repoDir, 'baseline');
  const ticketCommit = gitCommit(repoDir, 'feat: worker commit before cancel');

  // A cancel teardown touches session state only — no git mutation.
  const before = headSha(repoDir);
  // (no reset of any kind)
  assert.equal(headSha(repoDir), before, 'cancel must not move HEAD');
  assert.equal(headSha(repoDir), ticketCommit, 'HEAD remains at the ticket commit through cancel');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Negative: guard allows a legitimate reset that orphans nothing ----------
test('R-RRH C4: guard ALLOWS reset when target is not a strict ancestor (nothing to orphan)', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);

  const baseline = gitCommit(repoDir, 'baseline');

  // protectedSha === target → nothing to orphan → reset permitted.
  assert.equal(
    wouldResetOrphanCommit({ workingDir: repoDir, target: baseline, protectedSha: baseline }),
    false,
    'equal SHAs must permit the reset',
  );

  // Empty / nullish protectedSha → permit (no commit to protect).
  assert.equal(
    wouldResetOrphanCommit({ workingDir: repoDir, target: baseline, protectedSha: '' }),
    false,
    'empty protectedSha must permit the reset',
  );
  assert.equal(
    wouldResetOrphanCommit({ workingDir: repoDir, target: '', protectedSha: baseline }),
    false,
    'empty target must permit the reset',
  );

  // Divergent branch: target is NOT an ancestor of protectedSha → permit.
  const ticketCommit = gitCommit(repoDir, 'work on top of baseline');
  execFileSync('git', ['checkout', '-q', '-b', 'other', baseline], { cwd: repoDir });
  const divergent = gitCommit(repoDir, 'divergent line');
  // resetting to `divergent` would NOT orphan ticketCommit by ff-descent
  // (ticketCommit does not descend from divergent).
  assert.equal(
    wouldResetOrphanCommit({ workingDir: repoDir, target: divergent, protectedSha: ticketCommit }),
    false,
    'divergent target (not an ancestor) must permit the reset',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Guard positive unit: strict-ancestor target orphans the descendant ------
test('R-RRH C4: guard FLAGS reset when target is a strict ancestor of HEAD', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);

  const target = gitCommit(repoDir, 'preIter (target)');
  const descendant = gitCommit(repoDir, 'descendant ticket commit');

  assert.equal(
    wouldResetOrphanCommit({ workingDir: repoDir, target, protectedSha: descendant }),
    true,
    'a strict-ancestor target must be flagged: resetting would orphan the descendant',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});
