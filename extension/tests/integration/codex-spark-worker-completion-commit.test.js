// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../../bin/spawn-morty.js');

function makeTmpRoot(prefix = 'pickle-codex-completion-commit-') {
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

function writeCodexShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const mode = process.env.FAKE_WORKER_MODE || 'auto-fill';
const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
const artifact = path.join(ticketDir, 'research_2026-05-06.md');
fs.mkdirSync(ticketDir, { recursive: true });
fs.writeFileSync(artifact, '# research\\n');
fs.writeFileSync(path.join(process.cwd(), 'worker-change.txt'), mode + '\\n');
execFileSync('git', ['add', 'worker-change.txt'], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): completion-commit regression \${mode}\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
if (mode === 'announce') {
  process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
}
process.stdout.write('worker-log '.repeat(30) + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function writeSession(root, ticketId) {
  const sessionRoot = path.join(root, 'session');
  const ticketDir = path.join(sessionRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify({
    backend: 'codex',
    active: true,
    working_dir: root,
    worker_timeout_seconds: 30,
    start_time_epoch: Math.floor(Date.now() / 1000) - 60,
    activity: [],
  }, null, 2));
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    'title: R-CCC-5 integration replay',
    'status: "Todo"',
    'order: 1',
    '---',
    '# R-CCC-5 integration replay',
  ].join('\n'));
  return { sessionRoot, ticketDir };
}

function runSpawnMorty(root, sessionRoot, ticketDir, ticketId, mode) {
  const binDir = path.join(root, 'bin');
  writeCodexShim(binDir);
  return spawnSync(process.execPath, [
    SPAWN_MORTY_BIN,
    'integration replay',
    '--ticket-id', ticketId,
    '--ticket-path', ticketDir,
    '--timeout', '30',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      EXTENSION_DIR: root,
      PICKLE_DATA_DIR: root,
      FAKE_WORKER_MODE: mode,
      FAKE_TICKET_DIR: ticketDir,
      FAKE_TICKET_ID: ticketId,
    },
    timeout: 60000,
  });
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf8'));
}

test('spawn-morty emits worker_completion_commit_announced when codex worker prints ACK token', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const ticketId = '167fcaf9';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const result = runSpawnMorty(root, sessionRoot, ticketDir, ticketId, 'announce');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const state = readState(sessionRoot);
    const event = state.activity.find((entry) => entry.event === 'worker_completion_commit_announced');
    assert.ok(event, `missing worker_completion_commit_announced in ${JSON.stringify(state.activity)}`);
    assert.equal(event.ticket_id, ticketId);
    assert.match(event.sha, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn-morty auto-fills completion_commit after a successful codex worker turn without ACK', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const ticketId = '167fcaf9';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const result = runSpawnMorty(root, sessionRoot, ticketDir, ticketId, 'auto-fill');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const ticketPath = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
    const ticketContent = fs.readFileSync(ticketPath, 'utf8');
    assert.match(ticketContent, /status: "Done"/);
    assert.match(ticketContent, /completion_commit:\s+"[0-9a-f]{40}"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
