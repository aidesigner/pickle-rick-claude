import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

async function withDirtyGitFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dirty-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });

    const pkg = {
      name: 'dirty-tree-test',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    // Make the tree dirty: untracked file
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const x = 1;');

    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('dirty-tree skip: workerMode + dirty working tree → green + gate_skipped event', async () => {
  await withDirtyGitFixture(async dir => {
    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      workerMode: true,
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green', `Expected green, got ${result.status}`);
    assert.deepEqual(result.failures, []);

    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, `Expected gate_skipped event; got events: ${JSON.stringify(events)}`);
    assert.equal(skipped.data.reason, 'dirty_worktree_no_rescue');
  });
});

test('dirty-tree skip: clean tree in workerMode → gate runs normally (green)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-clean-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });

    const pkg = {
      name: 'clean-tree-test',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      workerMode: true,
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green');
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(!skipped, 'Should NOT emit gate_skipped for clean tree');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dirty-tree skip: dirty tree WITHOUT workerMode → gate runs normally', async () => {
  await withDirtyGitFixture(async dir => {
    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      workerMode: false,
      onEvent: (event, data) => events.push({ event, data }),
    });

    // Without workerMode, dirty tree does NOT trigger gate_skipped
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(!skipped, 'Should NOT emit gate_skipped when workerMode is false');
    // Gate should still complete (green or red depending on test command)
    assert.ok(['green', 'red'].includes(result.status));
  });
});
