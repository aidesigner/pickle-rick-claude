import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { getHeadSha, isWorkingTreeDirty } from '../services/git-utils.js';
import {
    compareMetric,
    createMicroverseState,
    recordIteration,
    recordFailedApproach,
    isConverged,
    writeMicroverseState,
    readMicroverseState,
} from '../microverse-state.js';

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

// --- microverse-state tests ---

const TEST_METRIC = {
    description: 'test score',
    validation: 'echo 50',
    type: 'command',
    timeout_seconds: 30,
    tolerance: 2,
};

test('compareMetric returns "improved" when current > previous + tolerance', () => {
    assert.equal(compareMetric(50, 40, 2), 'improved');
});

test('compareMetric returns "held" when within tolerance', () => {
    assert.equal(compareMetric(41, 40, 2), 'held');
});

test('compareMetric returns "regressed" when current < previous - tolerance', () => {
    assert.equal(compareMetric(30, 40, 2), 'regressed');
});

test('createMicroverseState returns valid initial state', () => {
    const state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    assert.equal(state.status, 'gap_analysis');
    assert.equal(state.prd_path, '/tmp/prd.md');
    assert.deepEqual(state.convergence.history, []);
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(state.convergence.stall_limit, 3);
    assert.equal(state.baseline_score, 0);
    assert.deepEqual(state.failed_approaches, []);
});

test('isConverged returns true when stall_counter >= stall_limit', () => {
    const state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state.convergence.stall_counter = 3;
    assert.equal(isConverged(state), true);
});

test('isConverged returns false when stall_counter < stall_limit', () => {
    const state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state.convergence.stall_counter = 2;
    assert.equal(isConverged(state), false);
});

test('recordIteration resets stall_counter on accept with improved score', () => {
    let state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state.convergence.stall_counter = 2;
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '50',
        score: 50,
        action: 'accept',
        description: 'improved things',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(state.convergence.history.length, 1);
});

test('recordIteration increments stall_counter on held score', () => {
    let state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '41',
        score: 41,
        action: 'accept',
        description: 'minor change',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 1);
});

test('recordIteration increments stall_counter on revert', () => {
    let state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '50',
        score: 50,
        action: 'revert',
        description: 'reverted',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 1);
});

test('recordFailedApproach appends to failed_approaches', () => {
    let state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    state = recordFailedApproach(state, 'tried X, failed');
    state = recordFailedApproach(state, 'tried Y, also failed');
    assert.deepEqual(state.failed_approaches, ['tried X, failed', 'tried Y, also failed']);
});

test('writeMicroverseState and readMicroverseState round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-'));
    try {
        const state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
        writeMicroverseState(dir, state);
        const loaded = readMicroverseState(dir);
        assert.deepEqual(loaded, state);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('readMicroverseState returns null for missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-'));
    try {
        assert.equal(readMicroverseState(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
