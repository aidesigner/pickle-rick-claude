// @tier: integration
// Droid-direct-commit evidence fallback: when a droid manager does work directly
// (no spawn-morty worker to stamp completion_commit or include the ticket ID in
// the commit message), readEvidence must accept the most recent commit beyond
// session start as inferred evidence when allow_inferred_completion_commit is set.
// Covers the droid implement-loop success-by-token contract (VAL-IMPL-014).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvidence } from '../services/ticket-completion-evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'droid-direct-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['-C', repoDir, 'init'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { timeout: 8000, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'seed'], { timeout: 8000, stdio: 'ignore' });
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    timeout: 8000, encoding: 'utf8',
  }).trim();
}

function writeTicket(sessionDir, ticketId) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${ticketId}`,
    'status: Done',
    '---',
    '',
    '# Some task',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), content);
}

const TICKET_ID = 'droidticket';

test('droid-direct-commit: allow_inferred flag accepts a non-ticket-ID commit beyond start', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const seedSha = initGitRepo(root);
  writeTicket(sessionDir, TICKET_ID);

  // Simulate a droid manager direct commit: message does NOT include the ticket ID.
  fs.writeFileSync(path.join(root, 'hello.js'), "console.log('hello world');\n");
  execFileSync('git', ['-C', root, 'add', 'hello.js'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', 'Add hello.js'], { timeout: 8000, stdio: 'ignore' });
  const directSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    timeout: 8000, encoding: 'utf8',
  }).trim();

  // With the flag: inferred-fresh, sha = the direct commit.
  const withFlag = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    startCommit: seedSha,
    startTimeEpoch: Math.floor(Date.now() / 1000) - 60,
    flags: { allow_inferred_completion_commit: true },
  });
  assert.equal(withFlag.kind, 'inferred-fresh');
  assert.equal(withFlag.sha, directSha);
});

test('droid-direct-commit: WITHOUT the flag, a non-ticket-ID commit is absent', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const seedSha = initGitRepo(root);
  writeTicket(sessionDir, TICKET_ID);

  fs.writeFileSync(path.join(root, 'hello.js'), "console.log('hi');\n");
  execFileSync('git', ['-C', root, 'add', 'hello.js'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', 'Add hello.js'], { timeout: 8000, stdio: 'ignore' });

  // Without the flag: absent (ticket-ID attribution contract preserved).
  const noFlag = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    startCommit: seedSha,
    startTimeEpoch: Math.floor(Date.now() / 1000) - 60,
    flags: {},
  });
  assert.equal(noFlag.kind, 'absent');
});

test('droid-direct-commit: baseline (start_commit) is excluded from the fallback', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const seedSha = initGitRepo(root);
  writeTicket(sessionDir, TICKET_ID);

  // No new commit beyond seed — the only commit is the baseline.
  const result = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    startCommit: seedSha,
    startTimeEpoch: 0, // allow all commits
    flags: { allow_inferred_completion_commit: true },
  });
  assert.equal(result.kind, 'absent');
});

test('droid-direct-commit: ticket-ID-matching commit wins over the any-new-commit fallback', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const seedSha = initGitRepo(root);
  writeTicket(sessionDir, TICKET_ID);

  // First: a non-matching direct commit.
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', 'a.txt'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', 'Add a'], { timeout: 8000, stdio: 'ignore' });

  // Then: a ticket-ID-matching commit (stronger signal).
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  execFileSync('git', ['-C', root, 'add', 'b.txt'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', `fix(${TICKET_ID}): add b`], { timeout: 8000, stdio: 'ignore' });
  const matchedSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    timeout: 8000, encoding: 'utf8',
  }).trim();

  const result = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    startCommit: seedSha,
    startTimeEpoch: Math.floor(Date.now() / 1000) - 60,
    flags: { allow_inferred_completion_commit: true },
  });
  assert.equal(result.kind, 'inferred-fresh');
  assert.equal(result.sha, matchedSha);
});
