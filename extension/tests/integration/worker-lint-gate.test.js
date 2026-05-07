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
const WORKER_TIMEOUT_MS = 90_000;

function writeExtensionSentinel(root) {
  const sentinelDir = path.join(root, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function makeTmpRoot(prefix = 'pickle-worker-lint-gate-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  writeExtensionSentinel(root);
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(root, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
}

function writeCodexShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
fs.mkdirSync(ticketDir, { recursive: true });
fs.writeFileSync(path.join(ticketDir, 'research_2026-05-06.md'), '# research\\n');
const target = path.join(process.cwd(), 'extension', 'src', 'lint-fixture.ts');
fs.writeFileSync(target, 'export function tooComplex(x) { if (x===1) return 1; if (x===2) return 2; return 3; }\\n');
execFileSync('git', ['add', 'extension/src/lint-fixture.ts'], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): worker lint gate fixture\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
process.stdout.write('worker-log '.repeat(30) + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeNpxShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'npx');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const logPath = path.join(process.cwd(), '..', 'npx-calls.json');
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push(args);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
if (args[0] === 'eslint' && args.includes('--fix')) process.exit(0);
if (args[0] === 'eslint') {
  process.stderr.write('1 error\\n');
  process.exit(1);
}
if (args[0] === 'tsc') process.exit(0);
process.exit(0);
`);
  fs.chmodSync(shimPath, 0o755);
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
    'title: Worker lint gate failure',
    'status: "Todo"',
    'order: 1',
    '---',
    '# Ticket',
  ].join('\n'));
  return { sessionRoot, ticketDir };
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf8'));
}

test('spawn-morty: persistent lint gate failure marks ticket Failed, emits events, and resets HEAD', () => {
  const root = makeTmpRoot();
  try {
    initRepo(root);
    const ticketId = '3646c20a';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir);
    writeNpxShim(binDir);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const result = spawnSync(process.execPath, [
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
        FAKE_TICKET_DIR: ticketDir,
        FAKE_TICKET_ID: ticketId,
      },
      timeout: WORKER_TIMEOUT_MS,
    });

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    const state = readState(sessionRoot);
    const autofixEvents = state.activity.filter((entry) => entry.event === 'worker_lint_autofix_applied');
    assert.equal(autofixEvents.length, 1);
    const failedEvent = state.activity.find((entry) => entry.event === 'worker_lint_gate_failed');
    assert.ok(failedEvent, `missing worker_lint_gate_failed in ${JSON.stringify(state.activity)}`);
    assert.equal(failedEvent.lint_errors >= 1, true);
    assert.equal(failedEvent.tsc_errors, 0);
    assert.deepEqual(failedEvent.file_list, ['extension/src/lint-fixture.ts']);

    const ticketContent = fs.readFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf8');
    assert.match(ticketContent, /status: "Failed"/);
    assert.doesNotMatch(ticketContent, /completion_commit:/);

    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
