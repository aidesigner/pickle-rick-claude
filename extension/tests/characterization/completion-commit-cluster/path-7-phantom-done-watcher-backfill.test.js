// @tier: integration
// Characterization test for Path 7: phantom-done-watcher-backfill
// inspectPhantomDoneTicketFile(filePath, sessionDir, workingDir, priorStatus)
// at mux-runner.js:1089 — inspects a single Done ticket file.
//
// Two sub-outcomes:
//   backfill: completion_commit absent, git-log finds inferred SHA
//     → writes completion_commit_inferred:<sha>, returns {changed:true, reason:'backfilled'}
//   revert: completion_commit absent, no git evidence
//     → reverts status to priorStatus, returns {changed:true, reason:'reverted'}
//
// Decision-matrix: path_id 7 — assert what the code DOES today.
// Backfill sub-path uses a local tmp git repo. Revert sub-path needs no git.
// No live git against the host repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectPhantomDoneTicketFile } from '../../../bin/mux-runner.js';
import { readFrontmatterField } from '../../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 7);

function makeTmp(prefix = 'char-path7-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Extract ticket ID from fixture skeleton keys
function ticketIdFromEntry(entry) {
  const key = Object.keys(entry.fixture.session_dir_skeleton).find(k => /^[a-f0-9]+\/linear_ticket/.test(k));
  return key ? key.split('/')[0] : null;
}

function initGitRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], opts);
}

function writeTicket(sessionDir, ticketId, frontmatter) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: "${v}"`);
  }
  lines.push('order: 1', '---', '# Body');
  const ticketPath = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, lines.join('\n'));
  return ticketPath;
}

// ---
// Sub-path A: backfill — git-log finds matching commit → writes completion_commit_inferred
// ---
test('path-7 backfill: Done ticket + no completion_commit + matching git commit → backfilled, completion_commit_inferred written', () => {
  const root = makeTmp();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = ticketIdFromEntry(ENTRY);
    const ticketPath = writeTicket(sessionDir, ticketId, {
      id: ticketId,
      status: 'Done',
      title: 'Backfill candidate ticket',
      // NO completion_commit
    });

    // Create a git commit referencing the ticket id
    fs.writeFileSync(path.join(root, 'work.txt'), 'work output\n');
    execFileSync('git', ['add', 'work.txt'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', `feat(${ticketId}): backfill candidate`, '--no-gpg-sign'],
      { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const result = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, 'Todo');

    // Characterize: backfill sub-path writes completion_commit_inferred and returns backfilled
    assert.equal(result.changed, true, `expected changed=true, got ${result.changed}`);
    assert.equal(result.reason, 'backfilled', `expected reason=backfilled, got '${result.reason}'`);
    assert.ok(result.commit, `expected commit sha in result, got '${result.commit}'`);

    const content = fs.readFileSync(ticketPath, 'utf8');
    const inferred = readFrontmatterField(content, 'completion_commit_inferred');
    assert.ok(inferred !== null, 'completion_commit_inferred should be written to frontmatter');

    // Status remains Done (backfill keeps Done)
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done', `expected status=Done after backfill, got '${status}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---
// Sub-path B: revert — no git evidence → reverts to priorStatus
// ---
test('path-7 revert: Done ticket + no completion_commit + no git evidence → reverted to priorStatus', () => {
  const root = makeTmp();
  const workingDir = makeTmp('char-path7-notgit-');
  try {
    const sessionDir = path.join(root, 'session');
    const ticketId = ticketIdFromEntry(ENTRY);
    const ticketPath = writeTicket(sessionDir, ticketId, {
      id: ticketId,
      status: 'Done',
      title: 'Backfill candidate ticket',
    });

    // workingDir is not a git repo → findMatchingCommit fails gracefully → null
    const result = inspectPhantomDoneTicketFile(ticketPath, sessionDir, workingDir, 'Todo');

    // Characterize: no git evidence → reverted
    assert.equal(result.changed, true, `expected changed=true for revert, got ${result.changed}`);
    assert.equal(result.reason, 'reverted', `expected reason=reverted, got '${result.reason}'`);

    const content = fs.readFileSync(ticketPath, 'utf8');
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Todo', `expected status reverted to Todo, got '${status}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---
// inspectPhantomDoneTicketFile: existing explicit completion_commit → not_done exit
// (short-circuit: has_completion_commit, no git needed)
// ---
test('path-7: existing completion_commit → changed=false, reason=has_completion_commit', () => {
  const root = makeTmp();
  try {
    const sessionDir = path.join(root, 'session');
    const ticketId = ticketIdFromEntry(ENTRY);
    const ticketPath = writeTicket(sessionDir, ticketId, {
      id: ticketId,
      status: 'Done',
      completion_commit: 'abc1234',
      title: 'Already-committed ticket',
    });

    const result = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, 'In Progress');

    assert.equal(result.changed, false, `expected changed=false, got ${result.changed}`);
    assert.equal(result.reason, 'has_completion_commit',
      `expected reason=has_completion_commit, got '${result.reason}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-7: decision-matrix evidence_source matches inferred', () => {
  assert.equal(ENTRY.evidence_source, 'inferred',
    `expected evidence_source=inferred for path 7, got '${ENTRY.evidence_source}'`);
});
