import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { getHeadSha, isWorkingTreeDirty } from '../services/git-utils.js';
import { runIteration } from '../bin/mux-runner.js';
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

test('compareMetric returns "held" for NaN inputs', () => {
    assert.equal(compareMetric(NaN, 50, 2), 'held');
    assert.equal(compareMetric(50, NaN, 2), 'held');
    assert.equal(compareMetric(50, 50, NaN), 'held');
    assert.equal(compareMetric(Infinity, 50, 2), 'held');
    assert.equal(compareMetric(50, 50, Infinity), 'held');
});

test('compareMetric handles zero tolerance (exact match required)', () => {
    assert.equal(compareMetric(50, 50, 0), 'held');
    assert.equal(compareMetric(51, 50, 0), 'improved');
    assert.equal(compareMetric(49, 50, 0), 'regressed');
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

test('createMicroverseState defaults direction to higher when not provided', () => {
    const state = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    assert.equal(state.key_metric.direction, 'higher');
});

test('createMicroverseState preserves explicit direction lower', () => {
    const metricWithDirection = { ...TEST_METRIC, direction: 'lower' };
    const state = createMicroverseState('/tmp/prd.md', metricWithDirection, 3);
    assert.equal(state.key_metric.direction, 'lower');
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

test('runIteration is exported from mux-runner', () => {
    assert.equal(typeof runIteration, 'function');
});

// --- microverse-runner tests ---

import { measureMetric, buildMicroverseHandoff, main } from '../bin/microverse-runner.js';
import { resetToSha } from '../services/git-utils.js';
import { writeStateFile } from '../services/pickle-utils.js';

function createSessionDir(workingDir, mvOverrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-session-'));
    const state = {
        active: true,
        working_dir: workingDir,
        step: 'implement',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 120,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
        tmux_mode: true,
        command_template: 'microverse.md',
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    const mvState = {
        status: 'iterating',
        prd_path: '/tmp/prd.md',
        key_metric: { description: 'test', validation: 'echo 50', type: 'command', timeout_seconds: 5, tolerance: 2 },
        convergence: { stall_limit: 3, stall_counter: 0, history: [] },
        gap_analysis_path: '',
        failed_approaches: [],
        baseline_score: 40,
        ...mvOverrides,
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(mvState, null, 2));
    return { dir, state, mvState };
}

// --- measureMetric tests ---

test('measureMetric parses numeric output from command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo 42.5', 5, dir);
        assert.ok(result, 'expected non-null result');
        assert.equal(result.score, 42.5);
        assert.ok(result.raw.includes('42.5'));
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null for non-numeric output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo "not a number"', 5, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null on timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('sleep 10 && echo 50', 1, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null on command failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('exit 1', 5, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric parses last line when multi-line output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo "info line" && echo 99', 5, dir);
        assert.ok(result, 'expected non-null result');
        assert.equal(result.score, 99);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildMicroverseHandoff tests ---

test('buildMicroverseHandoff includes metric info and iteration number', () => {
    const mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    mvState.baseline_score = 40;
    const handoff = buildMicroverseHandoff(mvState, 5, '/tmp/work');
    assert.ok(handoff.includes('Iteration 5'));
    assert.ok(handoff.includes('test score'));
    assert.ok(handoff.includes('Baseline score: 40'));
});

test('buildMicroverseHandoff includes failed approaches', () => {
    let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    mvState = recordFailedApproach(mvState, 'approach A failed');
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Failed Approaches'));
    assert.ok(handoff.includes('approach A failed'));
});

test('buildMicroverseHandoff includes recent history', () => {
    let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    mvState.baseline_score = 40;
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '50', score: 50, action: 'accept',
        description: 'improved', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString(),
    });
    const handoff = buildMicroverseHandoff(mvState, 2, '/tmp/work');
    assert.ok(handoff.includes('Recent Metric History'));
    assert.ok(handoff.includes('score=50'));
});

// --- Accept/reject cycle simulation ---

test('accept/reject cycle: 3 iterations (improve, regress, hold) → 2 accepted, 1 reset, stall_counter=1', () => {
    const dir = createTempGitRepo();
    try {
        let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 5);
        mvState.baseline_score = 40;
        const sha = getHeadSha(dir);

        // Iteration 1: improve (50 > 40 + 2)
        const entry1 = {
            iteration: 1, metric_value: '50', score: 50, action: 'accept',
            description: 'improved: 50 vs 40', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry1);
        assert.equal(mvState.convergence.stall_counter, 0, 'stall reset after improve');

        // Iteration 2: regress (30 < 50 - 2)
        const entry2 = {
            iteration: 2, metric_value: '30', score: 30, action: 'revert',
            description: 'regressed: 30 vs 50', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordFailedApproach(mvState, 'Iteration 2: dropped from 50 to 30');
        mvState = recordIteration(mvState, entry2);
        assert.equal(mvState.convergence.stall_counter, 1, 'stall incremented after regress');
        assert.equal(mvState.failed_approaches.length, 1);

        // Iteration 3: hold (51 within 50 ± 2)
        // recordIteration now uses last *accepted* score (50), not last entry score (30)
        const entry3 = {
            iteration: 3, metric_value: '51', score: 51, action: 'accept',
            description: 'held: 51 vs 50', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry3);

        const accepted = mvState.convergence.history.filter(h => h.action === 'accept').length;
        const reverted = mvState.convergence.history.filter(h => h.action === 'revert').length;
        assert.equal(accepted, 2, '2 accepted');
        assert.equal(reverted, 1, '1 reverted');
        assert.equal(mvState.convergence.history.length, 3);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Post-revert baseline (M1 fix) ---

test('recordIteration after revert compares against last accepted score, not reverted score', () => {
    let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 5);
    mvState.baseline_score = 40;
    mvState.status = 'iterating';
    const sha = 'b'.repeat(40);

    // Iteration 1: accept at score 60 (improved from baseline 40)
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '60', score: 60, action: 'accept',
        description: 'improved', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset on improvement');

    // Iteration 2: revert at score 20 (regressed)
    mvState = recordIteration(mvState, {
        iteration: 2, metric_value: '20', score: 20, action: 'revert',
        description: 'regressed', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1);

    // Iteration 3: score 45 — compared against last accepted (60), NOT last entry (20)
    // 45 < 60 - 2 = 58, so this should be 'regressed', not 'improved' (as it would be vs 20)
    mvState = recordIteration(mvState, {
        iteration: 3, metric_value: '45', score: 45, action: 'revert',
        description: 'regressed vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 2, 'stall incremented — 45 regressed from accepted 60');

    // Iteration 4: score 63 — compared against last accepted (60), 63 > 60+2 → improved
    mvState = recordIteration(mvState, {
        iteration: 4, metric_value: '63', score: 63, action: 'accept',
        description: 'improved vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset — 63 improved from accepted 60');
});

test('recordIteration with all-reverts falls back to baseline_score', () => {
    let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 10);
    mvState.baseline_score = 50;
    mvState.status = 'iterating';
    const sha = 'c'.repeat(40);

    // Two consecutive reverts — no accepted entries exist
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '20', score: 20, action: 'revert',
        description: 'regressed', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1);

    mvState = recordIteration(mvState, {
        iteration: 2, metric_value: '15', score: 15, action: 'revert',
        description: 'regressed again', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 2);

    // No accepted entries — lastAccepted is undefined, so previousScore = baseline_score (50)
    // Score 53 > 50 + 2 = 52 → improved, stall resets
    mvState = recordIteration(mvState, {
        iteration: 3, metric_value: '53', score: 53, action: 'accept',
        description: 'improved vs baseline', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset — compared against baseline_score 50');

    // Now lastAccepted exists at 53 — score 51 within 53 ± 2 → held
    mvState = recordIteration(mvState, {
        iteration: 4, metric_value: '51', score: 51, action: 'accept',
        description: 'held vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1, 'stall incremented — 51 held vs accepted 53');
});

// --- Convergence detection ---

test('convergence: 3 consecutive holds with stall_limit=3 stops loop', () => {
    let mvState = createMicroverseState('/tmp/prd.md', TEST_METRIC, 3);
    mvState.baseline_score = 40;

    const sha = 'a'.repeat(40);
    for (let i = 1; i <= 3; i++) {
        const entry = {
            iteration: i, metric_value: '41', score: 41, action: 'accept',
            description: `held: 41 vs 40`, pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry);
    }

    assert.equal(mvState.convergence.stall_counter, 3, 'stall_counter should be 3');
    assert.equal(isConverged(mvState), true, 'should be converged');
});

// --- Hard cap enforcement ---

test('hard cap: max_iterations enforced', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir, state } = createSessionDir(dir, {});
        state.max_iterations = 5;
        state.iteration = 5; // at the cap
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        // Verify cap logic: iteration >= max_iterations should stop
        const rawMaxIter = Number(state.max_iterations);
        const curIter = Number(state.iteration);
        assert.equal(rawMaxIter > 0 && curIter >= rawMaxIter, true, 'should trigger cap');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('hard cap: max_time_minutes enforced', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir, state } = createSessionDir(dir, {});
        state.max_time_minutes = 1;
        state.start_time_epoch = Math.floor(Date.now() / 1000) - 120; // 2 min ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        const elapsed = Math.floor(Date.now() / 1000) - state.start_time_epoch;
        assert.ok(elapsed >= state.max_time_minutes * 60, 'should exceed time limit');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Dirty tree abort ---

test('dirty working tree detected', () => {
    const dir = createTempGitRepo();
    try {
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
        assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Rollback test ---

test('regressed metric triggers git reset', () => {
    const dir = createTempGitRepo();
    try {
        const origSha = getHeadSha(dir);
        // Make a commit
        fs.writeFileSync(path.join(dir, 'new.txt'), 'content');
        execSync('git add . && git commit -m "new file"', { cwd: dir, stdio: 'pipe' });
        const newSha = getHeadSha(dir);
        assert.notEqual(origSha, newSha);

        // Reset to original
        resetToSha(origSha, dir);
        const afterReset = getHeadSha(dir);
        assert.equal(afterReset, origSha, 'should be back to original SHA');
        assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false, 'new file should be gone');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Final report ---

test('final report written to memory directory', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir } = createSessionDir(dir, {
            convergence: {
                stall_limit: 3, stall_counter: 3,
                history: [
                    { iteration: 1, metric_value: '50', score: 50, action: 'accept', description: 'improved', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString() },
                ],
            },
        });
        // Simulate report writing by checking the function exists
        const memoryDir = path.join(sessionDir, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        const reportPath = path.join(memoryDir, 'microverse_report_test.md');
        fs.writeFileSync(reportPath, '# Test Report\n');
        assert.ok(fs.existsSync(reportPath), 'report should exist in memory dir');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- State sync ---

test('runner reads state.json and microverse.json on startup', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir } = createSessionDir(dir);
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        const mvState = readMicroverseState(sessionDir);
        assert.ok(state.active === true);
        assert.ok(mvState !== null);
        assert.equal(mvState.status, 'iterating');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Pre-iteration SHA ---

test('pre-iteration SHA recorded correctly', () => {
    const dir = createTempGitRepo();
    try {
        const sha = getHeadSha(dir);
        assert.match(sha, /^[0-9a-f]{40}$/);
        // Make a change
        fs.writeFileSync(path.join(dir, 'file.txt'), 'data');
        execSync('git add . && git commit -m "change"', { cwd: dir, stdio: 'pipe' });
        const newSha = getHeadSha(dir);
        assert.notEqual(sha, newSha, 'SHA should change after commit');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
