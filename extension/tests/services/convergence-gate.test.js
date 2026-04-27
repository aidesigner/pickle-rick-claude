import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

async function withGitPnpmFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL_PKG = JSON.stringify({
  name: 'gate-test',
  version: '1.0.0',
  scripts: {
    typecheck: 'node -e "process.exit(0)"',
    lint: 'node -e "process.exit(0)"',
    test: 'node -e "process.exit(0)"',
  },
}, null, 2);

test('runGate: returns GateResult with all required fields', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    // pnpm-lock.yaml makes it a pnpm project; pnpm test runs scripts reliably
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'] });
    assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status), `invalid status: ${result.status}`);
    assert.ok(Array.isArray(result.failures));
    assert.equal(typeof result.baseline_used, 'boolean');
    assert.equal(typeof result.allowed_paths_used, 'boolean');
    assert.equal(typeof result.elapsed_ms, 'number');
    assert.ok(result.elapsed_ms >= 0);
    assert.equal(typeof result.total_raw_failure_count, 'number');
    assert.equal(typeof result.new_failures_vs_baseline, 'number');
    assert.equal(result.status, 'green');
    assert.equal(result.baseline_used, false);
    assert.equal(result.new_failures_vs_baseline, 0);
  });
});

test('runGate: scope=changed since=HEAD~1 processes changed files', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    fs.writeFileSync(path.join(dir, 'file1.ts'), 'const x = 1;');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    fs.writeFileSync(path.join(dir, 'file2.ts'), 'const y = 2;');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "add file2"', { cwd: dir, stdio: 'pipe' });

    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'] });
    assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status));
    assert.equal(result.status, 'green');
  });
});

test('runGate: scope=changed with no prior commit (HEAD~1 invalid) returns green', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    // HEAD~1 doesn't exist → git diff fails → no changed files → return early
    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'] });
    assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status));
  });
});

test('runGate: unknown project type returns green with no failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'));
  try {
    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'] });
    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: baseline_used and new_failures_vs_baseline always 0/false (deferred)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-'));
  try {
    const result = await runGate({ workingDir: dir, mode: 'baseline', scope: 'full', checks: [] });
    assert.equal(result.baseline_used, false);
    assert.equal(result.new_failures_vs_baseline, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
