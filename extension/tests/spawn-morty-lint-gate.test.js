// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLintGate } from '../bin/spawn-morty.js';

function makeTmpRoot(prefix = 'pickle-spawn-morty-lint-gate-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeNpxShim(binDir, logPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'npx');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const logPath = ${JSON.stringify(logPath)};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push(process.argv.slice(2));
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
process.exit(0);
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

test('runLintGate: lints changed extension/src files and runs tsc --noEmit', () => {
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
    writeNpxShim(shimDir, logPath);

    const result = withPathPrefix(shimDir, () => runLintGate([
      'extension/src/demo/one.ts',
      'extension/src/demo/two.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead,
    }));

    assert.equal(result.ok, true);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls[0], ['eslint', 'src/demo/one.ts', 'src/demo/two.ts', '--max-warnings=-1']);
    assert.deepEqual(calls[1], ['tsc', '--noEmit']);
    assert.equal(calls.some((argv) => argv[0] === 'git' && argv[1] === 'commit'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
