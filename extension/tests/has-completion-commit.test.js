// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasCompletionCommit } from '../services/pickle-utils.js';

function makeTmpRoot(prefix = 'pickle-has-completion-commit-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function writeTicket(sessionDir, ticketId, lines) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

test('hasCompletionCommit: explicit completion_commit wins when SHA exists', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'worker.txt'), 'work\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'bundle/A: R-CCC-5 explicit path', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'explicit01', [
      '---',
      'id: explicit01',
      'title: Explicit completion commit',
      'status: "Done"',
      `completion_commit: "${sha}"`,
      '---',
      '# Explicit completion commit',
    ]);

    const evidence = hasCompletionCommit({ sessionDir, ticketId: 'explicit01', workingDir: root });
    assert.deepEqual(evidence, { sha, source: 'explicit' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hasCompletionCommit: R-code commit subjects infer completion when explicit field is absent', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'worker.txt'), 'work\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'bundle/B: R-CCC-5 inferred path', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'infer001', [
      '---',
      'id: infer001',
      'status: "Done"',
      'order: 1',
      '---',
      '# R-CCC-5 inferred path',
    ]);

    const evidence = hasCompletionCommit({ sessionDir, ticketId: 'infer001', workingDir: root });
    assert.deepEqual(evidence, { sha, source: 'inferred' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hasCompletionCommit: returns absent when neither frontmatter nor git evidence exists', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'absent001', [
      '---',
      'id: absent001',
      'title: No completion evidence',
      'status: "Done"',
      '---',
      '# No completion evidence',
    ]);

    const evidence = hasCompletionCommit({ sessionDir, ticketId: 'absent001', workingDir: root });
    assert.deepEqual(evidence, { sha: null, source: 'absent' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
