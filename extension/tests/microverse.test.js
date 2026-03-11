import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { getHeadSha, isWorkingTreeDirty } from '../services/git-utils.js';

function createTempGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'init');
    execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    return dir;
}

test('getHeadSha returns 40-char hex string', () => {
    const dir = createTempGitRepo();
    try {
        const sha = getHeadSha(dir);
        assert.match(sha, /^[0-9a-f]{40}$/, `expected 40-char hex, got: ${sha}`);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty returns false on clean repo', () => {
    const dir = createTempGitRepo();
    try {
        assert.equal(isWorkingTreeDirty(dir), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty returns true when untracked file exists', () => {
    const dir = createTempGitRepo();
    try {
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
        assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
