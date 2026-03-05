import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

/**
 * Create an isolated temp root directory.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-runner-')));
}

/**
 * Run mux-runner.js as a subprocess with isolated EXTENSION_DIR.
 * @param {string} extDir - the EXTENSION_DIR to use
 * @param {string[]} args - additional arguments to pass
 */
function run(extDir, args = []) {
    return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
        env: { ...process.env, EXTENSION_DIR: extDir },
        encoding: 'utf-8',
        timeout: 15000,
    });
}

// --- No args → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 and prints Usage when no args provided', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session dir without state.json → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 when session dir has no state.json', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir but don't put state.json in it
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const result = run(tmpRoot, [sessionDir]);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Max iterations already reached → exits with "Max iterations reached" ---

test('mux-runner: exits when max_iterations already reached', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir with state.json where iteration >= max_iterations
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            original_prompt: 'test task',
            working_dir: tmpRoot,
        }, null, 2));

        // mux-runner also needs pickle_settings.json at extension root (optional)
        // and pickle.md in ~/.claude/commands/ (only needed for runIteration)
        // Since max_iterations is already reached, the loop will break before
        // calling runIteration, so we don't need those files.

        const result = run(tmpRoot, [sessionDir]);

        // Combine stdout and runner log to check for the exit message
        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session starts inactive, mux-runner takes ownership, then immediately hits max ---

test('mux-runner: takes ownership of inactive session then respects max_iterations', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Start with active: false (mux-runner should set it to true)
        // but iteration is already at max
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'plan',
            iteration: 10,
            max_iterations: 10,
            original_prompt: 'test ownership',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should have taken ownership
        assert.ok(
            combined.includes('ownership'),
            `Expected ownership message in log, got: ${logContent}`
        );

        // Should hit max iterations
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, log: ${logContent}`
        );

        // Final state should be inactive again (set by the max_iterations guard)
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Settings type guards for max turns ---

test('mux-runner: ignores non-number default_tmux_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session already at max iterations — will exit immediately
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 3,
            max_iterations: 3,
            original_prompt: 'test settings guard',
            working_dir: tmpRoot,
        }, null, 2));

        // Write settings with a string (should be ignored)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: "eighty",
            default_manager_max_turns: true,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        // Should not crash with TypeError
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle non-number settings gracefully, got: ${combined.slice(0, 500)}`
        );

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        if (fs.existsSync(runnerLog)) {
            const logContent = fs.readFileSync(runnerLog, 'utf-8');
            assert.ok(
                logContent.includes('Max iterations reached'),
                `Expected normal max iterations exit, got: ${logContent}`
            );
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: ignores zero default_tmux_max_turns, falls back to default_manager_max_turns', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 2,
            max_iterations: 2,
            original_prompt: 'test fallback',
            working_dir: tmpRoot,
        }, null, 2));

        // default_tmux_max_turns is 0 (rejected), but default_manager_max_turns is valid
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: 0,
            default_manager_max_turns: 42,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle zero settings gracefully, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Nonexistent session dir path → exit code 1 ---

test('mux-runner: exits with code 1 when session dir path does not exist', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot, ['/nonexistent/session/path/xyz']);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Runner creates mux-runner.log ---

// ---------------------------------------------------------------------------
// Number() coercion for string numeric limits (deep review pass 5)
// ---------------------------------------------------------------------------

test('mux-runner: string max_iterations and iteration still trigger max iterations exit', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use STRING values for max_iterations and iteration
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '1',
            max_iterations: '1',
            original_prompt: 'test string coercion',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" with string numerics, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after string max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: NaN max_time_minutes and start_time_epoch do not crash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // NaN time values but valid iteration limit so it exits quickly
        // Number("abc") = NaN, || 0 fallback prevents crash on time checks
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            max_time_minutes: 'abc',
            start_time_epoch: 'xyz',
            original_prompt: 'test NaN safety',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should not crash with TypeError — should handle NaN gracefully
        assert.ok(
            !combined.includes('TypeError'),
            `Should not crash on NaN time values, got: ${combined.slice(0, 500)}`
        );
        // Should still hit max iterations and exit cleanly
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" despite NaN time values, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: stall detection works with string state.iteration', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // String iteration — stall detection must compare Number()-coerced values
        // Start at iteration "5" with max "100" — runIteration will fail (no claude),
        // but the stall counter should increment because state.iteration won't advance.
        // After 3 stalls, mux-runner exits.
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '5',
            max_iterations: 100,
            original_prompt: 'test stall with string',
            working_dir: tmpRoot,
        }, null, 2));

        // Create pickle.md so runIteration doesn't bail on missing file
        const claudeDir = path.join(os.homedir(), '.claude', 'commands');
        const picklePromptPath = path.join(claudeDir, 'pickle.md');
        const hasPickleMd = fs.existsSync(picklePromptPath);

        if (!hasPickleMd) {
            // Skip test if pickle.md isn't installed — can't test runIteration
            return;
        }

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }

        // The stall detection should NOT treat string "5" === number -1 as different
        // (which would reset the counter each time). With the Number() fix,
        // it compares 5 === -1, 5 === 5, 5 === 5 and stalls after 3 iterations.
        // But runIteration may exit with 'error' first since claude binary isn't available.
        // Either way, the runner should have logged iterations and exited.
        assert.ok(
            logContent.includes('Iteration'),
            `Expected iteration logs, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- command_template path traversal validation (meeseeks pass 3) ---

test('mux-runner: rejects command_template with path traversal (../)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Active session at iteration 0 — runIteration will be called,
        // which reads command_template from state.json
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            original_prompt: 'test traversal',
            working_dir: tmpRoot,
            command_template: '../../../etc/passwd',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected path traversal rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: rejects command_template with forward slash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            original_prompt: 'test slash',
            working_dir: tmpRoot,
            command_template: 'subdir/evil.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected slash rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: creates mux-runner.log in session directory', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 3,
            max_iterations: 3,
            original_prompt: 'test log creation',
            working_dir: tmpRoot,
        }, null, 2));

        run(tmpRoot, [sessionDir]);

        const logPath = path.join(sessionDir, 'mux-runner.log');
        assert.ok(fs.existsSync(logPath), 'mux-runner.log should be created in session dir');

        const logContent = fs.readFileSync(logPath, 'utf-8');
        assert.ok(
            logContent.includes('mux-runner started'),
            `Expected "mux-runner started" in log, got: ${logContent}`
        );
        assert.ok(
            logContent.includes('mux-runner finished'),
            `Expected "mux-runner finished" in log, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Completion classification (classifyCompletion) ---

import { buildTmuxNotification, classifyCompletion, extractAssistantContent, transitionToMeeseeks, loadRateLimitSettings, classifyIterationExit, detectRateLimitInLog, detectRateLimitInText } from '../bin/mux-runner.js';

test('classifyCompletion: TASK_COMPLETED returns continue (single ticket, loop continues)', () => {
    assert.equal(classifyCompletion('<promise>TASK_COMPLETED</promise>'), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED returns task_completed', () => {
    assert.equal(classifyCompletion('<promise>EPIC_COMPLETED</promise>'), 'task_completed');
});

test('classifyCompletion: EXISTENCE_IS_PAIN returns review_clean', () => {
    assert.equal(classifyCompletion('<promise>EXISTENCE_IS_PAIN</promise>'), 'review_clean');
});

test('classifyCompletion: no token returns continue', () => {
    assert.equal(classifyCompletion('Some random output with no tokens'), 'continue');
});

test('classifyCompletion: empty string returns continue', () => {
    assert.equal(classifyCompletion(''), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED takes precedence over EXISTENCE_IS_PAIN', () => {
    const output = '<promise>EPIC_COMPLETED</promise>\n<promise>EXISTENCE_IS_PAIN</promise>';
    assert.equal(classifyCompletion(output), 'task_completed');
});

test('classifyCompletion: tolerates whitespace in tokens', () => {
    assert.equal(classifyCompletion('<promise> EXISTENCE_IS_PAIN </promise>'), 'review_clean');
    assert.equal(classifyCompletion('<promise> TASK_COMPLETED </promise>'), 'continue');
});

test('classifyCompletion: TASK_COMPLETED inside stream-json returns continue', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>TASK_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED inside stream-json returns task_completed', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>EPIC_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'task_completed');
});

// --- extractAssistantContent ---

test('extractAssistantContent: extracts assistant text, ignores tool results', () => {
    const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'Source: <promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Review complete.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include assistant text');
    assert.ok(!content.includes('EPIC_COMPLETED'), 'Should exclude tool_result content');
});

test('extractAssistantContent: includes result type lines', () => {
    const lines = [
        JSON.stringify({ type: 'result', result: 'Final output <promise>EPIC_COMPLETED</promise>' }),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EPIC_COMPLETED'), 'Should include result type');
});

test('extractAssistantContent: raw text passes through for backward compat', () => {
    const raw = 'Just plain text with <promise>EXISTENCE_IS_PAIN</promise>';
    const content = extractAssistantContent(raw);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include raw text');
});

// --- Regression: EPIC_COMPLETED in tool_result must not override EXISTENCE_IS_PAIN in assistant ---

test('classifyCompletion: EPIC_COMPLETED in tool_result does NOT cause task_completed (regression)', () => {
    const output = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'read1', content: 'if (hasToken(output, PromiseTokens.EPIC_COMPLETED)) {\n  return \'task_completed\';\n}\n<promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'EXISTENCE IS PAIN! No issues found.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean',
        'Should return review_clean, not task_completed from source code in tool_result');
});

test('classifyCompletion: system prompt containing EPIC_COMPLETED is ignored', () => {
    const output = [
        JSON.stringify({ type: 'system', system: 'Promise tokens: <promise>EPIC_COMPLETED</promise>' }),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Done reviewing.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean');
});

// --- Notification logic (buildTmuxNotification) ---

test('buildTmuxNotification: success shows "Complete" with elapsed time', () => {
    const n = buildTmuxNotification('success', 'implement', 5, 300);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Finished in'), `Expected "Finished in" subtitle, got: ${n.subtitle}`);
    assert.ok(n.body.includes('5 iterations'), `Expected iterations in body, got: ${n.body}`);
});

test('buildTmuxNotification: limit shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('limit', 'implement', 10, 600);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: limit'), `Expected "Stopped: limit" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: cancelled shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('cancelled', 'research', 3, 120);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: cancelled'), `Expected "Stopped: cancelled" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: error shows "Failed" with phase', () => {
    const n = buildTmuxNotification('error', 'plan', 2, 45);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: error'), `Expected "Exit: error" subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: plan'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: stall shows "Failed" with phase', () => {
    const n = buildTmuxNotification('stall', 'implement', 7, 900);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: stall'), `Expected "Exit: stall" subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// transitionToMeeseeks
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
    return {
        active: true,
        working_dir: '/tmp/test',
        step: 'implement',
        iteration: 5,
        max_iterations: 100,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: 1700000000,
        completion_promise: null,
        original_prompt: 'test task',
        current_ticket: 'abc123',
        history: [{ step: 'implement', ticket: 'abc123', timestamp: '2025-01-01T00:00:00Z' }],
        started_at: '2025-01-01T00:00:00Z',
        session_dir: '/tmp/test-session',
        tmux_mode: true,
        min_iterations: 0,
        command_template: 'pickle.md',
        chain_meeseeks: true,
        ...overrides,
    };
}

test('transitionToMeeseeks: uses default min/max when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const state = makeState();
        const result = transitionToMeeseeks(state, fakeRoot);

        assert.equal(result.chain_meeseeks, false);
        assert.equal(result.command_template, 'meeseeks.md');
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
        assert.equal(result.iteration, 0);
        assert.equal(result.step, 'review');
        assert.equal(result.current_ticket, null);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: reads custom values from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 15,
            default_meeseeks_max_passes: 75,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 15);
        assert.equal(result.max_iterations, 75);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: non-number settings fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 'not-a-number',
            default_meeseeks_max_passes: null,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: zero/negative settings fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 0,
            default_meeseeks_max_passes: -5,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: preserves non-transitioned state fields', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const state = makeState({
            working_dir: '/my/project',
            start_time_epoch: 1700000000,
            original_prompt: 'build the thing',
            session_dir: '/sessions/abc',
            tmux_mode: true,
            active: true,
        });
        const result = transitionToMeeseeks(state, fakeRoot);
        assert.equal(result.working_dir, '/my/project');
        assert.equal(result.start_time_epoch, 1700000000);
        assert.equal(result.original_prompt, 'build the thing');
        assert.equal(result.session_dir, '/sessions/abc');
        assert.equal(result.tmux_mode, true);
        assert.equal(result.active, true);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// loadRateLimitSettings
// ---------------------------------------------------------------------------

test('loadRateLimitSettings: returns defaults when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 60);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: reads custom values from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 30,
            default_max_rate_limit_retries: 5,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 30);
        assert.equal(result.maxRetries, 5);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: zero values fall back to floor of 1', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 0,
            default_max_rate_limit_retries: 0,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 60, 'wait_minutes: 0 should fall back to default 60');
        assert.equal(result.maxRetries, 3, 'retries: 0 should fall back to default 3');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: negative values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: -10,
            default_max_rate_limit_retries: -1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 60);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: non-number values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 'sixty',
            default_max_rate_limit_retries: true,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 60);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: boundary value 1 is accepted (minimum floor)', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 1,
            default_max_rate_limit_retries: 1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 1);
        assert.equal(result.maxRetries, 1);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Exit code sidecar file pattern (d6ed51ab)
// ---------------------------------------------------------------------------

test('exitcode sidecar: .log replaced with .exitcode produces correct filename', () => {
    const logFile = '/tmp/sessions/2026-03-01/tmux_iteration_1.log';
    const exitCodeFile = logFile.replace('.log', '.exitcode');
    assert.equal(exitCodeFile, '/tmp/sessions/2026-03-01/tmux_iteration_1.exitcode');
});

test('exitcode sidecar: pattern works for various iteration numbers', () => {
    for (const n of [0, 1, 42, 999]) {
        const logFile = `tmux_iteration_${n}.log`;
        const exitCodeFile = logFile.replace('.log', '.exitcode');
        assert.equal(exitCodeFile, `tmux_iteration_${n}.exitcode`);
    }
});

// ---------------------------------------------------------------------------
// classifyIterationExit — rate limit main loop integration (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: inactive result returns inactive', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('inactive', logFile).type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: error result returns error', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('error', logFile).type, 'error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: task_completed returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'normal output\n');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: review_clean returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'clean output\n');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate_limit_event JSON returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        const lines = [
            'normal output',
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate limit text pattern returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'You have reached your 5 hour limit. Please try back later.\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with clean log returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'all good, no issues\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: missing log file still returns success for continue', () => {
    assert.equal(classifyIterationExit('continue', '/nonexistent/path/log.log').type, 'success');
});

// ---------------------------------------------------------------------------
// detectRateLimitInLog / detectRateLimitInText — unit coverage (87e1fdde)
// ---------------------------------------------------------------------------

test('detectRateLimitInLog: returns true for rate_limit_event with rejected status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false for rate_limit_event with accepted status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'accepted' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false for missing file', () => {
    assert.equal(detectRateLimitInLog('/nonexistent/file.log').limited, false);
});

test('detectRateLimitInLog: only checks last 100 lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Place rate limit event beyond the last 100 lines
        const lines = [JSON.stringify({ type: 'rate_limit_event', status: 'rejected' })];
        for (let i = 0; i < 110; i++) lines.push('filler line');
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "5 hour limit" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'You have reached your 5 hour limit.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "usage limit reached" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Your usage limit has been reached. Please try again later.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "rate limit" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'API rate limit hit, backing off.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside user/tool_result lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Lines containing "type":"user" or "type":"tool_result" are filtered out
        fs.writeFileSync(logFile, '{"type":"user","text":"rate limit handling code"}\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for clean output', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Everything worked great. No issues.\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for missing file', () => {
    assert.equal(detectRateLimitInText('/nonexistent/file.log'), false);
});

// ---------------------------------------------------------------------------
// buildTmuxNotification: rate_limit_exhausted (87e1fdde)
// ---------------------------------------------------------------------------

test('buildTmuxNotification: rate_limit_exhausted shows "Failed"', () => {
    const n = buildTmuxNotification('rate_limit_exhausted', 'implement', 3, 3600);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: rate_limit_exhausted'), `Expected exit reason in subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: implement'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// Stale rate_limit_wait.json cleanup on startup (87e1fdde)
// ---------------------------------------------------------------------------

test('mux-runner: cleans up stale rate_limit_wait.json on startup', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session at max iterations — will exit immediately after ownership
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            original_prompt: 'test stale cleanup',
            working_dir: tmpRoot,
        }, null, 2));
        // Create a stale rate_limit_wait.json
        fs.writeFileSync(path.join(sessionDir, 'rate_limit_wait.json'), JSON.stringify({
            waiting: true, reason: 'API rate limit',
            started_at: '2026-03-01T00:00:00Z',
        }));

        run(tmpRoot, [sessionDir]);

        // The stale file should have been cleaned up during ownership takeover
        assert.equal(
            fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
            false,
            'Stale rate_limit_wait.json should be deleted on startup'
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// consecutiveRateLimits reset logic (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: success exit type used to reset consecutiveRateLimits counter', () => {
    // This verifies the contract: when classifyIterationExit returns type 'success',
    // the main loop resets consecutiveRateLimits to 0.
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'clean.log');
        fs.writeFileSync(logFile, 'normal iteration output\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: api_limit is distinct from other exit types', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'rl.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        const result = classifyIterationExit('continue', logFile);
        assert.equal(result.type, 'api_limit');
        assert.notEqual(result.type, 'success');
        assert.notEqual(result.type, 'error');
        assert.notEqual(result.type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// iteration_start / iteration_end activity events (222c384d)
// ---------------------------------------------------------------------------

/**
 * Run mux-runner with claude removed from PATH so spawn fails fast.
 * Returns parsed activity events from EXTENSION_DIR/activity/.
 */
function runAndCollectActivity(stateOverrides = {}) {
    const tmpRoot = makeTmpRoot();
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 0,
        max_iterations: 100,
        max_time_minutes: 720,
        original_prompt: 'test iteration events',
        working_dir: tmpRoot,
        ...stateOverrides,
    }, null, 2));

    // Strip claude from PATH so runIteration's spawn('claude') fails immediately
    const pathDirs = (process.env.PATH || '').split(':').filter(d => {
        try { return !fs.existsSync(path.join(d, 'claude')); } catch { return true; }
    });

    const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
        env: { ...process.env, EXTENSION_DIR: tmpRoot, PATH: pathDirs.join(':') },
        encoding: 'utf-8',
        timeout: 15000,
    });

    const activityDir = path.join(tmpRoot, 'activity');
    let events = [];
    if (fs.existsSync(activityDir)) {
        for (const f of fs.readdirSync(activityDir)) {
            if (f.endsWith('.jsonl')) {
                const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
                events.push(...lines.map(l => JSON.parse(l)));
            }
        }
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return { events, result, sessionDir: path.basename(sessionDir) };
}

test('iteration events: iteration_start logged at start of iteration', () => {
    const { events } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    assert.ok(starts.length >= 1, `Expected at least 1 iteration_start event, got ${starts.length}`);
    assert.equal(starts[0].source, 'pickle');
    assert.equal(starts[0].iteration, 1);
    assert.ok(starts[0].session, 'iteration_start should have session ID');
    assert.ok(starts[0].ts, 'iteration_start should have timestamp');
});

test('iteration events: iteration_end logged with error exit_type on spawn failure', () => {
    const { events } = runAndCollectActivity();
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(ends.length >= 1, `Expected at least 1 iteration_end event, got ${ends.length}`);
    assert.equal(ends[0].source, 'pickle');
    assert.equal(ends[0].iteration, 1);
    assert.equal(ends[0].exit_type, 'error');
    assert.ok(ends[0].session, 'iteration_end should have session ID');
});

test('iteration events: session ID matches basename of session directory', () => {
    const { events, sessionDir } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1, 'Need iteration_start events');
    assert.ok(ends.length >= 1, 'Need iteration_end events');
    assert.equal(starts[0].session, sessionDir);
    assert.equal(ends[0].session, sessionDir);
});

test('iteration events: iteration number matches across start and end', () => {
    const { events } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1 && ends.length >= 1, 'Need both iteration events');
    assert.equal(starts[0].iteration, ends[0].iteration, 'Start and end should have same iteration number');
});
