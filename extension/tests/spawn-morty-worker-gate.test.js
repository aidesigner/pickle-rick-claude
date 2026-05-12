// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerGate } from '../bin/spawn-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');
const WORKER_TIMEOUT_MS = 90_000;

function makeTmpRoot(prefix = 'pickle-spawn-morty-worker-gate-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeExtensionSentinel(root) {
  const sentinelDir = path.join(root, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function initWorkerFixtureRepo(root) {
  initGitRepo(root);
  writeExtensionSentinel(root);
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'extension', 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
}

function writeCommandShim(binDir, commandName, logPath, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, commandName);
  const exitCode = options.exitCode ?? 0;
  const stdout = options.stdout ?? '';
  const stderr = options.stderr ?? '';
  const sleepMs = options.sleepMs ?? 0;
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const logPath = ${JSON.stringify(logPath)};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push([${JSON.stringify(commandName)}, ...process.argv.slice(2)]);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
const finish = () => {
if (${JSON.stringify(stdout)}.length > 0) process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}.length > 0) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${JSON.stringify(exitCode)});
};
if (${JSON.stringify(sleepMs)} > 0) {
  setTimeout(finish, ${JSON.stringify(sleepMs)});
} else {
  finish();
}
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeCodexShim(binDir, fixtureName) {
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
const target = path.join(process.cwd(), 'extension', 'src', ${JSON.stringify(fixtureName)});
fs.writeFileSync(target, 'export const workerGateFixture = 2;\\n');
execFileSync('git', ['add', ${JSON.stringify(`extension/src/${fixtureName}`)}], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): worker gate fixture\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeNpxPassShim(binDir, logPath) {
  writeCommandShim(binDir, 'npx', logPath);
}

function writeNpmFailShim(binDir, logPath, stdout) {
  writeCommandShim(binDir, 'npm', logPath, { exitCode: 1, stdout });
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
    'title: Worker test gate failure',
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

function withPathPrefix(prefix, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${prefix}${path.delimiter}${prev || ''}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

test('runWorkerGate: lints changed extension/src files, runs tsc, then runs test:fast', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'two.ts'), 'export const two = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 11;\n');
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'two.ts'), 'export const two = 22;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'npx-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath);

    const result = withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
      'extension/src/demo/two.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead,
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.testFailures, []);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls[0], ['npx', 'eslint', 'src/demo/one.ts', 'src/demo/two.ts', '--max-warnings=-1']);
    assert.deepEqual(calls[1], ['npx', 'tsc', '--noEmit']);
    assert.deepEqual(calls[2], ['npm', 'run', 'test:fast']);
    assert.equal(calls.some((argv) => argv[0] === 'git' && argv[1] === 'commit'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: returns parsed testFailures when npm run test:fast fails after clean lint and tsc', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath, {
      exitCode: 1,
      stdout: `not ok 1 - fast tier fails\n  ---\n  location: '${path.join(root, 'extension', 'tests', 'demo.test.js')}:12:4'\n  error: 'boom'\n  ...\n`,
    });

    const result = withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.lintErrors, 0);
    assert.equal(result.tscErrors, 0);
    assert.equal(result.autofixApplied, false);
    assert.deepEqual(result.testFailures, [{
      name: 'fast tier fails',
      file: 'tests/demo.test.js',
      message: 'boom',
    }]);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'test:fast'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn-morty: test:fast failure marks ticket Failed, emits failure event, and resets HEAD without a completion commit', () => {
  const root = makeTmpRoot();
  try {
    initWorkerFixtureRepo(root);
    const ticketId = '3646c20a';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir, 'test-fixture.ts');
    writeNpxPassShim(binDir, path.join(root, 'npx-calls.json'));
    const npmCallsPath = path.join(sessionRoot, 'npm-calls.json');
    writeNpmFailShim(
      binDir,
      npmCallsPath,
      `not ok 1 - worker fast tier fails\n  ---\n  location: '${path.join(root, 'extension', 'tests', 'worker-fixture.test.js')}:7:3'\n  error: 'boom'\n  ...\n`,
    );
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
    const failedEvent = state.activity.find((entry) => entry.event === 'worker_lint_gate_failed');
    assert.ok(failedEvent, `missing worker_lint_gate_failed in ${JSON.stringify(state.activity)}`);
    assert.equal(failedEvent.lint_errors, 0);
    assert.equal(failedEvent.tsc_errors, 0);
    assert.deepEqual(failedEvent.file_list, ['extension/src/test-fixture.ts']);
    assert.equal(state.activity.some((entry) => entry.event === 'worker_lint_autofix_applied'), false);

    const ticketContent = fs.readFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf8');
    assert.match(ticketContent, /status: "Failed"/);
    assert.doesNotMatch(ticketContent, /completion_commit:/);
    const npmCalls = JSON.parse(fs.readFileSync(npmCallsPath, 'utf8'));
    assert.deepEqual(npmCalls, [['npm', 'run', 'test:fast']]);

    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('runWorkerGate: retries once when npm run test:fast fails and the second attempt passes', () => {
  assert.match('pending', /pending/);
});

test.skip('spawn-morty: hard-fails after one retried test:fast failure, emits worker_gate_failed, and does not commit', () => {
  assert.match('worker_gate_failed', /worker_gate_failed/);
});

test.skip('runWorkerGate: skips test:fast when SKIP_WORKER_TEST_GATE=1 and logs the skip marker', () => {
  assert.match('SKIP_WORKER_TEST_GATE', /SKIP_WORKER_TEST_GATE/);
});

test('runWorkerGate: honors worker_test_gate_timeout_ms and reports a synthetic timeout failure', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 100,
    }, null, 2));
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath, {
      sleepMs: 250,
      stdout: 'partial output should not matter\n',
    });

    const result = withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.testFailures, [{
      name: '__timeout__',
      file: 'npm run test:fast',
      message: 'killed after 100ms',
    }]);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
