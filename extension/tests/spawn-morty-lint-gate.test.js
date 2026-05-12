// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWorkerGate } from '../bin/spawn-morty.js';

function makeTmpRoot(prefix = 'pickle-spawn-morty-lint-gate-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeCommandShim(binDir, commandName, logPath, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, commandName);
  const exitCode = options.exitCode ?? 0;
  const stdout = options.stdout ?? '';
  const stderr = options.stderr ?? '';
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const logPath = ${JSON.stringify(logPath)};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push([${JSON.stringify(commandName)}, ...process.argv.slice(2)]);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
if (${JSON.stringify(stdout)}.length > 0) process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}.length > 0) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${JSON.stringify(exitCode)});
`);
  fs.chmodSync(shimPath, 0o755);
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
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

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
      preWorkerHead,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.lintErrors, 0);
    assert.equal(result.tscErrors, 0);
    assert.deepEqual(result.testFailures, [{
      name: 'fast tier fails',
      file: 'tests/demo.test.js',
      message: 'boom',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
