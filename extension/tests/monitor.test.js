import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { summarizeLine } from '../bin/monitor.js';

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
