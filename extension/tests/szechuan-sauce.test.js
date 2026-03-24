import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    createMicroverseState,
    writeMicroverseState,
    readMicroverseState,
    isConverged,
} from '../services/microverse-state.js';

// ---------------------------------------------------------------------------
// Szechuan Sauce command prompt validation
// ---------------------------------------------------------------------------

const COMMAND_PATH = path.resolve(import.meta.dirname, '../../.claude/commands/szechuan-sauce.md');

function readCommand() {
    return fs.readFileSync(COMMAND_PATH, 'utf-8');
}

test('szechuan-sauce.md exists and is readable', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), `missing: ${COMMAND_PATH}`);
    const content = readCommand();
    assert.ok(content.length > 100, 'command file appears empty');
});

test('szechuan-sauce.md has no --interactive flag references', () => {
    const content = readCommand();
    assert.ok(!content.includes('--interactive'), 'interactive mode should be removed');
    assert.ok(!content.includes('INTERACTIVE'), 'INTERACTIVE variable should be removed');
});

test('szechuan-sauce.md has Setup and Worker modes', () => {
    const content = readCommand();
    assert.ok(content.includes('## SETUP MODE'), 'missing Setup Mode section');
    assert.ok(content.includes('## WORKER MODE'), 'missing Worker Mode section');
});

test('szechuan-sauce.md Worker Mode references microverse protocol', () => {
    const content = readCommand();
    // Worker mode should delegate to the shared microverse worker protocol
    assert.ok(
        content.includes('Microverse Worker protocol') || content.includes('microverse.md'),
        'Worker Mode should reference the shared microverse protocol'
    );
});

test('szechuan-sauce.md Worker Mode defines szechuan-specific overrides', () => {
    const content = readCommand();
    assert.ok(content.includes('szechuan-sauce-principles.md'), 'should reference principles file');
    assert.ok(content.includes('szechuan-sauce:'), 'should define commit message format');
});

test('szechuan-sauce.md Setup Mode steps are sequentially numbered', () => {
    const content = readCommand();
    // Extract setup section
    const setupStart = content.indexOf('## SETUP MODE');
    const workerStart = content.indexOf('## WORKER MODE');
    const setup = content.slice(setupStart, workerStart);
    // Steps should be numbered 1 through N without gaps
    const stepNumbers = [...setup.matchAll(/### Step (\d+)/g)].map(m => Number(m[1]));
    assert.ok(stepNumbers.length >= 5, `expected at least 5 steps, found ${stepNumbers.length}`);
    for (let i = 0; i < stepNumbers.length; i++) {
        assert.equal(stepNumbers[i], i + 1, `step ${i + 1} should be numbered ${i + 1}, got ${stepNumbers[i]}`);
    }
});

test('szechuan-sauce.md has no step numbering overlap between modes', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    // Worker mode should use Override numbering, not Step numbering that could clash
    const workerSteps = [...workerSection.matchAll(/### Step (\d+)/g)];
    assert.equal(workerSteps.length, 0, 'Worker Mode should not use "Step N" numbering (uses Override numbering instead)');
});

// ---------------------------------------------------------------------------
// Principles file validation
// ---------------------------------------------------------------------------

const PRINCIPLES_PATH = path.resolve(import.meta.dirname, '../szechuan-sauce-principles.md');

test('szechuan-sauce-principles.md exists', () => {
    assert.ok(fs.existsSync(PRINCIPLES_PATH), `missing: ${PRINCIPLES_PATH}`);
});

test('principles file has priority matrix', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Priority Matrix'), 'missing Priority Matrix section');
    assert.ok(content.includes('P0'), 'missing P0 priority');
    assert.ok(content.includes('P4'), 'missing P4 priority');
});

test('principles file has diagnostic guide', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Quick Diagnostic Guide'), 'missing Quick Diagnostic Guide');
});

// ---------------------------------------------------------------------------
// init-microverse: gap_analysis_path populated
// ---------------------------------------------------------------------------

test('init-microverse sets gap_analysis_path when run via CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-init-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        const targetPath = '/tmp/fake-target';
        execSync(
            `node ${initScript} ${dir} ${targetPath} --stall-limit 3 --convergence-target 0`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.gap_analysis_path, path.join(dir, 'gap_analysis.md'),
            'gap_analysis_path should be set to session_dir/gap_analysis.md');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse sets convergence_target when provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-conv-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target --convergence-target 0`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.convergence_target, 0, 'convergence_target should be 0');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse uses LLM type and lower direction by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-metric-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.key_metric.type, 'llm', 'default metric type should be llm');
        assert.equal(state.key_metric.direction, 'lower', 'default direction should be lower');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// init-microverse: judge_context_path
// ---------------------------------------------------------------------------

test('init-microverse sets judge_context_path when --judge-context provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-judge-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target --judge-context /tmp/principles.md`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.judge_context_path, '/tmp/principles.md',
            'judge_context_path should match --judge-context value');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse omits judge_context_path when --judge-context not provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-nojudge-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.judge_context_path, undefined,
            'judge_context_path should not be set when flag is absent');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// szechuan-sauce.md: no Override 4 (state update race)
// ---------------------------------------------------------------------------

test('szechuan-sauce.md Worker Mode does not instruct workers to call update-state.js', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(!workerSection.includes('update-state.js iteration'),
        'Worker should not call update-state.js — runner manages state');
});

// ---------------------------------------------------------------------------
// isConverged: convergence_target == 0 triggers exit
// ---------------------------------------------------------------------------

test('isConverged returns true when last accepted score equals convergence_target 0', () => {
    const state = createMicroverseState('/tmp/target', {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, 5, 0);
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '0', score: 0, action: 'accept', description: 'fixed all', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), true, 'should converge when score equals convergence_target');
});

test('isConverged returns false when last accepted score does not equal convergence_target', () => {
    const state = createMicroverseState('/tmp/target', {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, 5, 0);
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '3', score: 3, action: 'accept', description: 'some fixes', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), false, 'should not converge when score > convergence_target');
});

// ---------------------------------------------------------------------------
// isConverged: direction-aware convergence_target (not just strict equality)
// ---------------------------------------------------------------------------

test('isConverged returns true when score overshoots convergence_target (lower direction)', () => {
    // If target is 0 and score is -1 (overshot), should still converge
    const state = createMicroverseState('/tmp/target', {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, 5, 0);
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '-1', score: -1, action: 'accept', description: 'overshot', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), true, 'should converge when score undershoots target in lower direction');
});

test('isConverged returns true when score overshoots convergence_target (higher direction)', () => {
    const state = createMicroverseState('/tmp/target', {
        description: 'coverage',
        validation: 'test coverage',
        type: 'command',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'higher',
    }, 5, 90);
    state.baseline_score = 50;
    state.convergence.history = [
        { iteration: 1, metric_value: '95', score: 95, action: 'accept', description: 'exceeded target', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), true, 'should converge when score exceeds target in higher direction');
});

test('isConverged returns false when score has not reached target (higher direction)', () => {
    const state = createMicroverseState('/tmp/target', {
        description: 'coverage',
        validation: 'test coverage',
        type: 'command',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'higher',
    }, 5, 90);
    state.baseline_score = 50;
    state.convergence.history = [
        { iteration: 1, metric_value: '70', score: 70, action: 'accept', description: 'partial', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), false, 'should not converge when score < target in higher direction');
});

// ---------------------------------------------------------------------------
// Financial domain principles file
// ---------------------------------------------------------------------------

const FINANCIAL_PRINCIPLES_PATH = path.resolve(import.meta.dirname, '../szechuan-sauce-financial-principles.md');

test('szechuan-sauce-financial-principles.md exists', () => {
    assert.ok(fs.existsSync(FINANCIAL_PRINCIPLES_PATH), `missing: ${FINANCIAL_PRINCIPLES_PATH}`);
});

test('financial principles file has priority matrix', () => {
    const content = fs.readFileSync(FINANCIAL_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Priority Matrix'), 'missing Priority Matrix section');
    assert.ok(content.includes('P0'), 'missing P0 priority');
});

test('financial principles file has diagnostic guide', () => {
    const content = fs.readFileSync(FINANCIAL_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Quick Diagnostic Guide'), 'missing Quick Diagnostic Guide');
});

// ---------------------------------------------------------------------------
// Dry-run format validation
// ---------------------------------------------------------------------------

test('szechuan-sauce.md dry-run section includes priority buckets', () => {
    const content = readCommand();
    assert.ok(content.includes('### P0: Critical'), 'missing P0 bucket in dry-run format');
    assert.ok(content.includes('### P1: High'), 'missing P1 bucket in dry-run format');
    assert.ok(content.includes('### P2: Medium'), 'missing P2 bucket in dry-run format');
    assert.ok(content.includes('### P3: Low'), 'missing P3 bucket in dry-run format');
    assert.ok(content.includes('### P4: Optional'), 'missing P4 bucket in dry-run format');
});

test('szechuan-sauce.md has dry-run mode in Setup', () => {
    const content = readCommand();
    assert.ok(content.includes('--dry-run'), 'missing --dry-run flag');
    assert.ok(content.includes('DRY_RUN'), 'missing DRY_RUN variable');
});

// ---------------------------------------------------------------------------
// init-microverse: --metric-json accepts custom metric
// ---------------------------------------------------------------------------

test('init-microverse accepts --metric-json for custom metrics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-custom-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        const customMetric = JSON.stringify({
            description: 'test coverage',
            validation: 'npm test -- --coverage',
            type: 'command',
            timeout_seconds: 120,
            tolerance: 1,
            direction: 'higher',
        });
        execSync(
            `node ${initScript} ${dir} /tmp/target --stall-limit 3 --metric-json '${customMetric}'`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.key_metric.type, 'command', 'should use custom metric type');
        assert.equal(state.key_metric.direction, 'higher', 'should use custom direction');
        assert.equal(state.key_metric.tolerance, 1, 'should use custom tolerance');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
