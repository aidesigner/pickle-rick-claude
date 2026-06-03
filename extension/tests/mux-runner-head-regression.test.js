// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { detectAndRecoverHeadRegression } from '../bin/mux-runner.js';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-hreg-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `commit-${Date.now()}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  return sha;
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function makeTicketFile(sessionDir, ticketId, status, completionCommit) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${ticketId}`,
    `title: Test ticket`,
    `status: "${status}"`,
    completionCommit ? `completion_commit: ${completionCommit}` : '',
    '---',
    '# Test',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), frontmatter);
}

function makeStatePath(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1 }));
  return statePath;
}

// AC-CXOR-1-1 (a): ff-only reattach succeeds when completion_commit SHA is valid
test('R-CXOR-1: detectAndRecoverHeadRegression reattaches orphaned commit via ff-only merge', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline commit');
  const orphanCommit = gitCommit(repoDir, 'test(R-CXOR-1): worker real work');

  // Simulate worker git reset --hard to baseline
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });
  assert.equal(headSha(repoDir), startCommit, 'HEAD should be at startCommit after reset');

  const ticketId = 'test-ticket-1';
  makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
  const statePath = makeStatePath(sessionDir);

  const log = [];
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: orphanCommit,
    sessionDir,
    statePath,
    iteration: 1,
    log: (msg) => log.push(msg),
  });

  assert.equal(result.detected, true, 'regression should be detected');
  assert.equal(result.recovered, true, 'regression should be recovered via ff-only');
  assert.equal(result.action, 'ff_reattached', 'action should be ff_reattached');
  assert.equal(headSha(repoDir), orphanCommit, 'HEAD should be at orphanCommit after reattach');
  assert.ok(log.some(l => l.includes('ff-only reattach to') && l.includes('succeeded')), 'should log reattach success');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-CXOR-1-1 (b): marks Failed when orphan SHA is invalid (unrecoverable)
test('R-CXOR-1: detectAndRecoverHeadRegression marks ticket Failed when orphan unrecoverable', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline commit');

  // Don't make an orphan commit — simulate lost SHA
  const invalidSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  const ticketId = 'test-ticket-2';
  makeTicketFile(sessionDir, ticketId, 'Done', invalidSha);
  const statePath = makeStatePath(sessionDir);

  const log = [];
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: invalidSha,
    sessionDir,
    statePath,
    iteration: 1,
    log: (msg) => log.push(msg),
  });

  assert.equal(result.detected, true, 'regression should be detected (HEAD equals startCommit)');
  assert.equal(result.recovered, false, 'recovery should fail with invalid SHA');
  assert.equal(result.action, 'marked_failed', 'action should be marked_failed');
  assert.equal(headSha(repoDir), startCommit, 'HEAD should still be at startCommit');

  // Verify ticket was flipped to Failed
  const ticketPath = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
  const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
  assert.ok(ticketContent.includes('status: "Failed"') || ticketContent.includes("status: 'Failed'"), 'ticket status should be Failed');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-CXOR-1-1 invariant: NEVER leaves ticket Done at baseline when regression detected
test('R-CXOR-1: NEVER leaves ticket Done at baseline — either reattached or Failed', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline');
  const orphanCommit = gitCommit(repoDir, 'test(R-CXOR-1): real work');
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });

  const ticketId = 'test-ticket-3';
  makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
  const statePath = makeStatePath(sessionDir);

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: orphanCommit,
    sessionDir,
    statePath,
    iteration: 2,
    log: () => {},
  });

  assert.equal(result.detected, true, 'must detect regression');

  // After detection, either HEAD advanced (ff_reattached) OR ticket is Failed — never Done at baseline
  const finalHead = headSha(repoDir);
  if (result.action === 'ff_reattached') {
    assert.notEqual(finalHead, startCommit, 'HEAD must have advanced past baseline on reattach');
  } else {
    assert.equal(result.action, 'marked_failed', 'must mark Failed if not reattached');
    const ticketPath = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
    const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
    assert.ok(!ticketContent.includes('status: "Done"') && !ticketContent.includes("status: 'Done'"), 'ticket must not be Done at baseline');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

// No regression when HEAD advanced past startCommit (normal case)
test('R-CXOR-1: no regression detected when HEAD is ahead of startCommit', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline');
  const advancedCommit = gitCommit(repoDir, 'test(R-CXOR-1): work landed normally');

  const ticketId = 'test-ticket-4';
  makeTicketFile(sessionDir, ticketId, 'Done', advancedCommit);
  const statePath = makeStatePath(sessionDir);

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: advancedCommit,
    sessionDir,
    statePath,
    iteration: 1,
    log: () => {},
  });

  assert.equal(result.detected, false, 'no regression when HEAD advanced normally');
  assert.equal(result.action, 'none', 'action should be none');
  assert.equal(headSha(repoDir), advancedCommit, 'HEAD should remain at advanced commit');

  fs.rmSync(tmp, { recursive: true, force: true });
});
