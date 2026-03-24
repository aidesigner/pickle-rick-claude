import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { summarizeLine, sparkline, renderMicroverseTrend } from '../bin/monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_BIN = path.resolve(__dirname, '../bin/monitor.js');

/**
 * Run monitor.js as a subprocess.
 * @param {string[]} args - CLI arguments
 */
function run(args) {
    return spawnSync(process.execPath, [MONITOR_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

// --- Startup validation ---

test('monitor: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('monitor: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-pickle-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

// --- summarizeLine ---

test('summarizeLine: assistant text → first line of text', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello Morty\nSecond line' }] },
    });
    assert.equal(summarizeLine(line), 'Hello Morty');
});

test('summarizeLine: assistant tool_use → tool icon + name', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    assert.equal(summarizeLine(line), '🔧 Bash');
});

test('summarizeLine: result success', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 5 });
    assert.equal(summarizeLine(line), '✅ success');
});

test('summarizeLine: result error', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' });
    assert.equal(summarizeLine(line), '❌ error_max_turns');
});

test('summarizeLine: system init', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' });
    assert.ok(summarizeLine(line).includes('🚀'), 'should have init icon');
    assert.ok(summarizeLine(line).includes('claude-opus-4-6'), 'should include model');
});

test('summarizeLine: non-JSON → returns stripped line', () => {
    assert.equal(summarizeLine('plain text output'), 'plain text output');
});

test('summarizeLine: empty → empty string', () => {
    assert.equal(summarizeLine(''), '');
    assert.equal(summarizeLine('   '), '');
});

test('summarizeLine: unknown JSON type → empty string', () => {
    assert.equal(summarizeLine(JSON.stringify({ type: 'content_block_delta' })), '');
});

// --- sparkline ---

test('sparkline: empty array → empty string', () => {
    assert.equal(sparkline([]), '');
});

test('sparkline: single value → single block', () => {
    const result = sparkline([5]);
    assert.equal(result.length, 1);
});

test('sparkline: ascending values → ascending blocks', () => {
    const result = sparkline([0, 5, 10]);
    assert.equal(result.length, 3);
    // First char should be lowest block, last should be highest
    assert.equal(result[0], '▁');
    assert.equal(result[2], '█');
});

test('sparkline: descending values → descending blocks', () => {
    const result = sparkline([10, 5, 0]);
    assert.equal(result.length, 3);
    assert.equal(result[0], '█');
    assert.equal(result[2], '▁');
});

test('sparkline: all same values → all same blocks', () => {
    const result = sparkline([3, 3, 3]);
    assert.ok(result[0] === result[1] && result[1] === result[2]);
});

// --- renderMicroverseTrend ---

function makeMicroverseState(overrides = {}) {
    return {
        status: 'iterating',
        prd_path: '/tmp/target',
        key_metric: {
            description: 'violations',
            validation: 'count',
            type: 'llm',
            timeout_seconds: 60,
            tolerance: 0,
            direction: 'lower',
        },
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [],
        },
        convergence_target: 0,
        gap_analysis_path: '',
        failed_approaches: [],
        baseline_score: 10,
        ...overrides,
    };
}

test('renderMicroverseTrend: empty history shows "No measurements yet"', () => {
    const mv = makeMicroverseState();
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('No measurements yet'));
});

test('renderMicroverseTrend: shows direction and target', () => {
    const mv = makeMicroverseState();
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('lower'));
    assert.ok(text.includes('0'));
});

test('renderMicroverseTrend: shows score and sparkline with history', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '8', score: 8, action: 'accept', description: 'fix1', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                { iteration: 2, metric_value: '5', score: 5, action: 'accept', description: 'fix2', pre_iteration_sha: 'b', timestamp: new Date().toISOString() },
                { iteration: 3, metric_value: '3', score: 3, action: 'accept', description: 'fix3', pre_iteration_sha: 'c', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    // Should show latest score
    assert.ok(text.includes('3'), 'should show latest score');
    // Should show iteration:score entries
    assert.ok(text.includes('1:8'), 'should show iteration 1 score');
    assert.ok(text.includes('2:5'), 'should show iteration 2 score');
    assert.ok(text.includes('3:3'), 'should show iteration 3 score');
});

test('renderMicroverseTrend: shows stall counter when > 0', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 3,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('Stall: 3/5'));
});

test('renderMicroverseTrend: hides stall counter when 0', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(!text.includes('Stall:'));
});

test('renderMicroverseTrend: shows CONVERGED badge', () => {
    const mv = makeMicroverseState({
        status: 'converged',
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '0', score: 0, action: 'accept', description: 'done', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('CONVERGED'));
});

test('renderMicroverseTrend: shows STOPPED badge with exit reason', () => {
    const mv = makeMicroverseState({
        status: 'stopped',
        exit_reason: 'stall_limit',
        convergence: {
            stall_limit: 5,
            stall_counter: 5,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('STOPPED'));
    assert.ok(text.includes('stall_limit'));
});

test('renderMicroverseTrend: reverted entries show ✗', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 1,
            history: [
                { iteration: 1, metric_value: '8', score: 8, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                { iteration: 2, metric_value: '10', score: 10, action: 'revert', description: 'regressed', pre_iteration_sha: 'b', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('✗'), 'reverted entry should show ✗');
    assert.ok(text.includes('✓'), 'accepted entry should show ✓');
});

test('renderMicroverseTrend: limits history display to last 8', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
        iteration: i + 1,
        metric_value: String(12 - i),
        score: 12 - i,
        action: 'accept',
        description: `fix${i}`,
        pre_iteration_sha: `sha${i}`,
        timestamp: new Date().toISOString(),
    }));
    const mv = makeMicroverseState({
        convergence: { stall_limit: 15, stall_counter: 0, history },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    // First 4 iterations should not appear in the compact history line
    assert.ok(!text.includes('1:12'), 'iteration 1 should be trimmed from compact display');
    assert.ok(!text.includes('4:9'), 'iteration 4 should be trimmed from compact display');
    // Last 8 should appear
    assert.ok(text.includes('5:8'), 'iteration 5 should appear');
    assert.ok(text.includes('12:1'), 'iteration 12 should appear');
});
