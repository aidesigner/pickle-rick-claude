import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    loadSettings,
    initCircuitBreaker,
    canExecute,
    detectProgress,
    extractErrorSignature,
    normalizeErrorSignature,
    recordIterationResult,
    resetCircuitBreaker,
} from '../services/circuit-breaker.js';

import { buildTmuxNotification } from '../bin/tmux-runner.js';

function makeTmpDir(prefix = 'cb-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeSettings(overrides = {}) {
    return {
        enabled: true,
        noProgressThreshold: 5,
        sameErrorThreshold: 5,
        halfOpenAfter: 2,
        ...overrides,
    };
}

function initGitRepo(dir) {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'initial');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
}

function makeFreshState(overrides = {}) {
    return {
        state: 'CLOSED',
        last_change: new Date().toISOString(),
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        last_error_signature: null,
        last_known_head: '',
        last_known_step: null,
        last_known_ticket: null,
        last_progress_iteration: 0,
        total_opens: 0,
        reason: '',
        opened_at: null,
        history: [],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// loadSettings
// ---------------------------------------------------------------------------

test('loadSettings: reads valid config from pickle_settings.json', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_circuit_breaker_enabled: false,
            default_cb_no_progress_threshold: 10,
            default_cb_same_error_threshold: 8,
            default_cb_half_open_after: 3,
        }));
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, false);
        assert.equal(cfg.noProgressThreshold, 10);
        assert.equal(cfg.sameErrorThreshold, 8);
        assert.equal(cfg.halfOpenAfter, 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: returns defaults when file is missing', () => {
    const tmpDir = makeTmpDir();
    try {
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.noProgressThreshold, 5);
        assert.equal(cfg.sameErrorThreshold, 5);
        assert.equal(cfg.halfOpenAfter, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: enforces minimums and halfOpenAfter < noProgressThreshold', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_cb_no_progress_threshold: 1,
            default_cb_same_error_threshold: 0,
            default_cb_half_open_after: 99,
        }));
        const cfg = loadSettings(tmpDir);
        assert.ok(cfg.noProgressThreshold >= 2, `noProgressThreshold should be >= 2, got ${cfg.noProgressThreshold}`);
        assert.ok(cfg.sameErrorThreshold >= 2, `sameErrorThreshold should be >= 2, got ${cfg.sameErrorThreshold}`);
        assert.ok(cfg.halfOpenAfter < cfg.noProgressThreshold,
            `halfOpenAfter (${cfg.halfOpenAfter}) must be < noProgressThreshold (${cfg.noProgressThreshold})`);
        assert.ok(cfg.halfOpenAfter >= 1, `halfOpenAfter should be >= 1, got ${cfg.halfOpenAfter}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// initCircuitBreaker
// ---------------------------------------------------------------------------

test('initCircuitBreaker: creates fresh state when no file exists', () => {
    const tmpDir = makeTmpDir();
    try {
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.equal(state.consecutive_no_progress, 0);
        assert.equal(state.consecutive_same_error, 0);
        assert.equal(state.last_error_signature, null);
        assert.deepEqual(state.history, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: loads existing valid state', () => {
    const tmpDir = makeTmpDir();
    try {
        const existing = makeFreshState({
            state: 'HALF_OPEN',
            consecutive_no_progress: 3,
            last_error_signature: 'some-error',
            total_opens: 2,
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(existing));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'HALF_OPEN');
        assert.equal(state.consecutive_no_progress, 3);
        assert.equal(state.last_error_signature, 'some-error');
        assert.equal(state.total_opens, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: recovers from corrupted JSON', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), '{not valid json!!!');
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.equal(state.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: detects stale state and returns fresh', () => {
    const tmpDir = makeTmpDir();
    try {
        // CB says last_progress_iteration=50, but state.json says iteration=10
        const stale = makeFreshState({ state: 'HALF_OPEN', last_progress_iteration: 50 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(stale));
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 10 }));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.equal(state.last_progress_iteration, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// canExecute
// ---------------------------------------------------------------------------

test('canExecute: CLOSED returns true', () => {
    assert.equal(canExecute(makeFreshState({ state: 'CLOSED' })), true);
});

test('canExecute: HALF_OPEN returns true', () => {
    assert.equal(canExecute(makeFreshState({ state: 'HALF_OPEN' })), true);
});

test('canExecute: OPEN returns false', () => {
    assert.equal(canExecute(makeFreshState({ state: 'OPEN' })), false);
});

// ---------------------------------------------------------------------------
// detectProgress
// ---------------------------------------------------------------------------

test('detectProgress: first-iteration warm-up always returns hasProgress', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = detectProgress(tmpDir, '', null, 'implement', null, 'ticket-1');
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: non-git directory returns hasProgress=true', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = detectProgress(tmpDir, 'abc123', null, 'implement', null, null);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: step change counts as progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'research', 'plan', null, null);
        assert.equal(result.stepChanged, true);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: ticket change counts as progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'implement', 'implement', 'ticket-A', 'ticket-B');
        assert.equal(result.ticketChanged, true);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: detects uncommitted git changes', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: clean git repo with same head returns no progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, false);
        assert.equal(result.currentHead, head);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// extractErrorSignature
// ---------------------------------------------------------------------------

test('extractErrorSignature: extracts from NDJSON with error result + assistant text', () => {
    const ndjson = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it...' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Error: ENOENT /foo/bar' }] } }),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
    ].join('\n');
    const sig = extractErrorSignature(ndjson);
    assert.ok(sig !== null, 'should extract a signature');
    assert.ok(sig.includes('<PATH>'), 'should normalize paths');
});

test('extractErrorSignature: returns null for clean output (no error result)', () => {
    const ndjson = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done!' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
    ].join('\n');
    assert.equal(extractErrorSignature(ndjson), null);
});

test('extractErrorSignature: skips malformed NDJSON lines gracefully', () => {
    const ndjson = [
        '{not valid json',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed at /src/main.ts:42:10' }] } }),
        'also not json {{{',
        JSON.stringify({ type: 'result', subtype: 'error_tool' }),
    ].join('\n');
    const sig = extractErrorSignature(ndjson);
    assert.ok(sig !== null, 'should extract signature despite malformed lines');
});

test('extractErrorSignature: returns null when no assistant text before error', () => {
    const ndjson = [
        JSON.stringify({ type: 'result', subtype: 'error_timeout' }),
    ].join('\n');
    assert.equal(extractErrorSignature(ndjson), null);
});

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

test('normalizeErrorSignature: replaces Unix paths with <PATH>', () => {
    const result = normalizeErrorSignature('Error reading /usr/local/lib/node_modules/foo.js');
    assert.ok(result.includes('<PATH>'), `Expected <PATH> in "${result}"`);
    assert.ok(!result.includes('/usr/local'), 'path should be replaced');
});

test('normalizeErrorSignature: replaces line:column with <N>:<N>', () => {
    const result = normalizeErrorSignature('SyntaxError at position :42:10');
    assert.ok(result.includes(':<N>:<N>'), `Expected :<N>:<N> in "${result}"`);
    assert.ok(!result.includes(':42:10'), 'line:col should be replaced');
});

test('normalizeErrorSignature: preserves exit codes (standalone numbers)', () => {
    const result = normalizeErrorSignature('Process exited with code 1');
    assert.ok(result.includes('1'), `Exit code should be preserved in "${result}"`);
});

test('normalizeErrorSignature: replaces UUIDs with <UUID>', () => {
    const result = normalizeErrorSignature('Session a1b2c3d4-e5f6-7890-abcd-ef1234567890 failed');
    assert.ok(result.includes('<UUID>'), `Expected <UUID> in "${result}"`);
    assert.ok(!result.includes('a1b2c3d4'), 'UUID should be replaced');
});

test('normalizeErrorSignature: truncates at 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const result = normalizeErrorSignature(longMsg);
    assert.equal(result.length, 200);
});

// ---------------------------------------------------------------------------
// recordIterationResult
// ---------------------------------------------------------------------------

test('recordIterationResult: CLOSED → HALF_OPEN after halfOpenAfter no-progress iterations', () => {
    const settings = makeSettings({ halfOpenAfter: 2 });
    let state = makeFreshState({ state: 'CLOSED', consecutive_no_progress: 1 });
    state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 3, settings);
    assert.equal(state.state, 'HALF_OPEN');
    assert.equal(state.consecutive_no_progress, 2);
});

test('recordIterationResult: HALF_OPEN → CLOSED on progress', () => {
    const settings = makeSettings();
    let state = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 3 });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: null }, 5, settings);
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_no_progress, 0);
    assert.equal(state.last_progress_iteration, 5);
});

test('recordIterationResult: HALF_OPEN → OPEN after noProgressThreshold', () => {
    const settings = makeSettings({ noProgressThreshold: 5, halfOpenAfter: 2 });
    let state = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 4 });
    state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 6, settings);
    assert.equal(state.state, 'OPEN');
    assert.equal(state.consecutive_no_progress, 5);
});

test('recordIterationResult: CLOSED → OPEN on sameErrorThreshold', () => {
    const settings = makeSettings({ sameErrorThreshold: 3 });
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 2,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-A' }, 4, settings);
    assert.equal(state.state, 'OPEN');
    assert.equal(state.consecutive_same_error, 3);
});

test('recordIterationResult: error counter is independent of progress', () => {
    const settings = makeSettings({ sameErrorThreshold: 5 });
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 1,
        last_error_signature: 'err-X',
    });
    // Progress happens, but same error repeats
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-X' }, 2, settings);
    assert.equal(state.consecutive_same_error, 2);
    assert.equal(state.consecutive_no_progress, 0);
});

test('recordIterationResult: different error resets counter to 1', () => {
    const settings = makeSettings();
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 3,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-B' }, 4, settings);
    assert.equal(state.consecutive_same_error, 1);
    assert.equal(state.last_error_signature, 'err-B');
});

test('recordIterationResult: no error resets error counter to 0', () => {
    const settings = makeSettings();
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 3,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: null }, 5, settings);
    assert.equal(state.consecutive_same_error, 0);
    assert.equal(state.last_error_signature, null);
});

test('recordIterationResult: error counter persists through HALF_OPEN recovery', () => {
    const settings = makeSettings({ sameErrorThreshold: 5 });
    let state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_same_error: 2,
        last_error_signature: 'err-X',
    });
    // Progress + same error → recover to CLOSED but error counter still ticks
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-X' }, 3, settings);
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_same_error, 3);
});

// ---------------------------------------------------------------------------
// resetCircuitBreaker
// ---------------------------------------------------------------------------

test('resetCircuitBreaker: resets OPEN to CLOSED with zeroed counters', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({
            state: 'OPEN',
            consecutive_no_progress: 10,
            consecutive_same_error: 5,
            total_opens: 3,
            history: [{ timestamp: '2026-01-01T00:00:00Z', iteration: 1, from: 'CLOSED', to: 'OPEN', reason: 'test' }],
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        resetCircuitBreaker(tmpDir, 'manual test');

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
        assert.equal(after.consecutive_same_error, 0);
        assert.equal(after.opened_at, null);
        // History preserved + reset entry added
        assert.ok(after.history.length >= 2, 'should preserve history + add reset entry');
        const lastEntry = after.history[after.history.length - 1];
        assert.equal(lastEntry.from, 'OPEN');
        assert.equal(lastEntry.to, 'CLOSED');
        assert.ok(lastEntry.reason.includes('Manual reset'), `reason should include "Manual reset", got: ${lastEntry.reason}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resetCircuitBreaker: resets HALF_OPEN to CLOSED', () => {
    const tmpDir = makeTmpDir();
    try {
        const hoState = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 3 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(hoState));

        resetCircuitBreaker(tmpDir, 'half-open reset');

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resetCircuitBreaker: CLOSED is a no-op (no file rewrite)', () => {
    const tmpDir = makeTmpDir();
    try {
        const closedState = makeFreshState({ state: 'CLOSED' });
        const content = JSON.stringify(closedState);
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        fs.writeFileSync(cbPath, content);
        const mtimeBefore = fs.statSync(cbPath).mtimeMs;

        resetCircuitBreaker(tmpDir, 'noop test');

        const mtimeAfter = fs.statSync(cbPath).mtimeMs;
        assert.equal(mtimeBefore, mtimeAfter, 'file should not be rewritten for CLOSED state');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// State persistence round-trip
// ---------------------------------------------------------------------------

test('state persistence: write then read back produces equivalent state', () => {
    const tmpDir = makeTmpDir();
    try {
        const settings = makeSettings({ halfOpenAfter: 2, noProgressThreshold: 5, sameErrorThreshold: 5 });
        let state = makeFreshState();

        // Simulate some iterations
        state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 1, settings);
        state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 2, settings);
        // Should be HALF_OPEN now
        assert.equal(state.state, 'HALF_OPEN');

        // Write to disk
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        fs.writeFileSync(cbPath, JSON.stringify(state, null, 2));

        // Read back via initCircuitBreaker
        const loaded = initCircuitBreaker(tmpDir, settings);
        assert.equal(loaded.state, state.state);
        assert.equal(loaded.consecutive_no_progress, state.consecutive_no_progress);
        assert.equal(loaded.consecutive_same_error, state.consecutive_same_error);
        assert.equal(loaded.last_error_signature, state.last_error_signature);
        assert.equal(loaded.total_opens, state.total_opens);
        assert.equal(loaded.history.length, state.history.length);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Integration: circuit-reset.js CLI
// ---------------------------------------------------------------------------

const CIRCUIT_RESET_BIN = path.join(import.meta.dirname, '..', 'bin', 'circuit-reset.js');

function runResetCli(args, env = {}) {
    return spawnSync(process.execPath, [CIRCUIT_RESET_BIN, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, ...env },
    });
}

test('circuit-reset CLI: exits 1 with no args', () => {
    const result = runResetCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('circuit-reset CLI: resets OPEN session to CLOSED', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({ state: 'OPEN', total_opens: 1 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        const result = runResetCli([tmpDir, '--reason', 'CLI test reset']);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('circuit-reset CLI: CLOSED session exits 0 as no-op', () => {
    const tmpDir = makeTmpDir();
    try {
        const closedState = makeFreshState({ state: 'CLOSED' });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(closedState));

        const result = runResetCli([tmpDir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('circuit-reset CLI: writes valid JSON after reset', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({ state: 'OPEN' });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        runResetCli([tmpDir]);

        const raw = fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(typeof parsed.state, 'string');
        assert.ok(Array.isArray(parsed.history));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Integration: buildTmuxNotification — circuit_open is a failure
// ---------------------------------------------------------------------------

test('buildTmuxNotification: circuit_open shows "Failed" with isFailure semantics', () => {
    const n = buildTmuxNotification('circuit_open', 'implement', 5, 120);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: circuit_open'), `Expected "Exit: circuit_open" in subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: implement'), `Expected phase in subtitle, got: ${n.subtitle}`);
});
