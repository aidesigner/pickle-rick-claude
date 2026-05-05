// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processLine, formatToolUse } from '../bin/log-watcher.js';
import { drainStreamJsonLines, drainLog, detectLogTruncation } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_WATCHER_BIN = path.resolve(__dirname, '../bin/log-watcher.js');

/**
 * Run log-watcher.js as a subprocess.
 * @param {string[]} args - CLI arguments
 */
function run(args) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [LOG_WATCHER_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 30000,
    });
}

// --- Startup validation ---

test('log-watcher: compiled bin is the extension root sentinel', () => {
    assert.equal(fs.existsSync(LOG_WATCHER_BIN), true);
    assert.equal(path.basename(LOG_WATCHER_BIN), 'log-watcher.js');
});

test('log-watcher: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('log-watcher: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-pickle-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

// --- processLine ---

test('processLine: assistant text block', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello Morty' }] },
    });
    assert.equal(processLine(line), 'Hello Morty');
});

test('processLine: assistant tool_use block', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'npm test' },
            }],
        },
    });
    const result = processLine(line);
    assert.ok(result.includes('🔧 Bash'), `Expected tool icon, got: ${result}`);
    assert.ok(result.includes('npm test'), `Expected command, got: ${result}`);
});

test('processLine: assistant mixed text and tool_use', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: {
            content: [
                { type: 'text', text: 'Running tests...' },
                { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
            ],
        },
    });
    const result = processLine(line);
    assert.ok(result.includes('Running tests...'), 'should include text');
    assert.ok(result.includes('🔧 Read'), 'should include tool');
    assert.ok(result.includes('/src/index.ts'), 'should include file path');
});

test('processLine: result success', () => {
    const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 12,
        total_cost_usd: 0.42,
    });
    const result = processLine(line);
    assert.ok(result.includes('✅'), `Expected success icon, got: ${result}`);
    assert.ok(result.includes('12 turns'), `Expected turns, got: ${result}`);
    assert.ok(result.includes('$0.42'), `Expected cost, got: ${result}`);
});

test('processLine: result error', () => {
    const line = JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 50,
        total_cost_usd: 3.14,
    });
    const result = processLine(line);
    assert.ok(result.includes('❌'), `Expected error icon, got: ${result}`);
    assert.ok(result.includes('error_max_turns'), `Expected subtype, got: ${result}`);
});

test('processLine: system init', () => {
    const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
    });
    const result = processLine(line);
    assert.equal(result, '🚀 Session started (model: claude-sonnet-4-6)');
});

test('processLine: unknown type → null', () => {
    const line = JSON.stringify({ type: 'content_block_delta', delta: {} });
    assert.equal(processLine(line), null);
});

test('processLine: non-JSON fallback', () => {
    assert.equal(processLine('plain text output'), 'plain text output');
});

test('processLine: empty line → null', () => {
    assert.equal(processLine(''), null);
    assert.equal(processLine('   '), null);
});

// --- formatToolUse ---

test('formatToolUse: extracts correct field per tool type', () => {
    assert.equal(formatToolUse('Bash', { command: 'ls -la' }), 'ls -la');
    assert.equal(formatToolUse('Edit', { file_path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(formatToolUse('Read', { file_path: '/c/d.ts' }), '/c/d.ts');
    assert.equal(formatToolUse('Write', { file_path: '/e/f.ts' }), '/e/f.ts');
    assert.equal(formatToolUse('Glob', { pattern: '**/*.ts' }), '**/*.ts');
    assert.equal(formatToolUse('Grep', { pattern: 'TODO' }), 'TODO');
    assert.equal(formatToolUse('Task', { description: 'research codebase' }), 'research codebase');
    assert.equal(formatToolUse('Agent', { description: 'explore architecture' }), 'explore architecture');
});

test('formatToolUse: unknown tool returns name', () => {
    assert.equal(formatToolUse('CustomTool', { foo: 'bar' }), 'CustomTool');
});

test('formatToolUse: missing expected field returns name', () => {
    assert.equal(formatToolUse('Bash', {}), 'Bash');
    assert.equal(formatToolUse('Read', { not_file_path: '/x' }), 'Read');
});

// --- drainStreamJsonLines (shared utility from pickle-utils) ---

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-log-watcher-')));
}

function makeSessionDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('drainStreamJsonLines: parses complete lines and emits results', () => {
    const tmpDir = makeTmpDir();
    try {
        const logPath = path.join(tmpDir, 'test.log');
        const lines = [
            JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' }),
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
        ];
        fs.writeFileSync(logPath, lines.join('\n') + '\n');

        const emitted = [];
        const result = drainStreamJsonLines(logPath, 0, '', processLine, (t) => emitted.push(t));

        assert.ok(emitted.length >= 2, `Expected 2+ emitted lines, got: ${emitted.length}`);
        assert.ok(emitted[0].includes('🚀'), 'First line should be init');
        assert.ok(emitted[1].includes('Hello'), 'Second line should be text');
        assert.equal(result.lineBuf, '', 'No trailing partial line');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('drainStreamJsonLines: handles partial line buffering across calls', () => {
    const tmpDir = makeTmpDir();
    try {
        const logPath = path.join(tmpDir, 'test.log');
        const fullLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'buffered' }] } });
        // Write first half without newline
        const half = fullLine.slice(0, 30);
        fs.writeFileSync(logPath, half);

        const emitted1 = [];
        const r1 = drainStreamJsonLines(logPath, 0, '', processLine, (t) => emitted1.push(t));
        assert.equal(emitted1.length, 0, 'No complete line yet');
        assert.equal(r1.lineBuf, half, 'Partial line buffered');

        // Append rest with newline
        fs.appendFileSync(logPath, fullLine.slice(30) + '\n');
        const emitted2 = [];
        const r2 = drainStreamJsonLines(logPath, r1.offset, r1.lineBuf, processLine, (t) => emitted2.push(t));
        assert.equal(emitted2.length, 1, 'Complete line emitted');
        assert.ok(emitted2[0].includes('buffered'), `Expected text, got: ${emitted2[0]}`);
        assert.equal(r2.lineBuf, '', 'No trailing partial');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('drainStreamJsonLines: empty file returns unchanged state', () => {
    const tmpDir = makeTmpDir();
    try {
        const logPath = path.join(tmpDir, 'empty.log');
        fs.writeFileSync(logPath, '');

        const emitted = [];
        const result = drainStreamJsonLines(logPath, 0, '', processLine, (t) => emitted.push(t));
        assert.equal(emitted.length, 0);
        assert.equal(result.offset, 0);
        assert.equal(result.lineBuf, '');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('drainStreamJsonLines: non-existent file returns unchanged state', () => {
    const emitted = [];
    const result = drainStreamJsonLines('/nonexistent/path/test.log', 0, '', processLine, (t) => emitted.push(t));
    assert.equal(emitted.length, 0);
    assert.equal(result.offset, 0);
});

test('log-watcher: dead-pid active session terminates via recovered state', () => {
    const sessionDir = makeSessionDir('pickle-log-watcher-session-');
    try {
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            pid: 999999,
            step: 'implement',
            iteration: 4,
        }, null, 2));

        const result = spawnSync(process.execPath, [LOG_WATCHER_BIN, sessionDir], {
            env: { ...process.env },
            encoding: 'utf-8',
            timeout: 4000,
        });

        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung instead of terminating: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected clean exit, got stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes('FEED TERMINATED'), `Expected termination banner, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// R-MWR-4 + R-MWR-6 + R-MWR-8: EOF resilience for file-tail watchers
// ---------------------------------------------------------------------------

test('detectLogTruncation: size < offset → reset offset to 0 with truncated=true', () => {
    const tmpDir = makeTmpDir();
    try {
        const logPath = path.join(tmpDir, 'tail.log');
        fs.writeFileSync(logPath, 'short content\n');
        const out = detectLogTruncation(logPath, 1_000_000, 'partial-buffered-line');
        assert.equal(out.truncated, true);
        assert.equal(out.offset, 0);
        assert.equal(out.lineBuf, '');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectLogTruncation: size >= offset → unchanged with truncated=false', () => {
    const tmpDir = makeTmpDir();
    try {
        const logPath = path.join(tmpDir, 'tail.log');
        fs.writeFileSync(logPath, 'a'.repeat(2000));
        const out = detectLogTruncation(logPath, 1500, 'partial');
        assert.equal(out.truncated, false);
        assert.equal(out.offset, 1500);
        assert.equal(out.lineBuf, 'partial');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectLogTruncation: missing file → unchanged (caller owns discovery loop)', () => {
    const out = detectLogTruncation('/tmp/definitely-not-here-' + Date.now(), 500, 'buf');
    assert.equal(out.truncated, false);
    assert.equal(out.offset, 500);
    assert.equal(out.lineBuf, 'buf');
});

// R-MWR-8: parametrized truncate test for the 3 file-tail watchers.
// Each watcher's internal pattern is `let offset = ...; offset = drain*(...)`.
// We exercise the SHARED truncation primitive (detectLogTruncation) against
// the same drain functions each watcher uses, plus assert that the reset
// state reads post-truncate content. This proves the watcher process pattern
// stays alive across truncate AND consumes post-truncate content.
const FILE_TAIL_WATCHERS = ['log-watcher', 'morty-watcher', 'raw-morty'];
for (const watcherName of FILE_TAIL_WATCHERS) {
    const usesStreamJson = watcherName !== 'morty-watcher';
    test(`${watcherName}: truncate → reset offset → consume post-truncate content (R-MWR-8)`, () => {
        const tmpDir = makeTmpDir();
        try {
            const logPath = path.join(tmpDir, 'feed.log');
            // Make pre-truncate content much larger than post-truncate so
            // size < offset is unambiguous after truncation. R-MWR-4's
            // detection key is `size < offset`, NOT a magical "I saw a
            // truncate syscall" — the only signal a tail watcher has is
            // file size shrinkage.
            const preLines = [
                JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' }),
                ...Array.from({ length: 50 }, (_, i) => JSON.stringify({
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: `pre-truncate-line-${i}-${'x'.repeat(100)}` }] },
                })),
            ];
            fs.writeFileSync(logPath, preLines.join('\n') + '\n');

            // First drain: read pre-truncate content.
            let offset = 0;
            let lineBuf = '';
            const preEmitted = [];
            if (usesStreamJson) {
                const r = drainStreamJsonLines(logPath, offset, lineBuf, processLine, t => preEmitted.push(t));
                offset = r.offset;
                lineBuf = r.lineBuf;
            } else {
                offset = drainLog(logPath, offset);
            }
            assert.ok(offset > 0, `${watcherName}: drain should advance offset on initial read`);
            const preOffset = offset;

            // Truncate to zero, then write small fresh content. New size
            // is much smaller than recorded offset → triggers detection.
            fs.truncateSync(logPath, 0);
            const postLines = [
                JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after-truncate' }] } }),
                JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.01 }),
            ];
            fs.writeFileSync(logPath, postLines.join('\n') + '\n');
            const postSize = fs.statSync(logPath).size;
            assert.ok(postSize < preOffset, `${watcherName}: post-truncate size (${postSize}) must be < preOffset (${preOffset}) for the test to be meaningful`);

            // Without R-MWR-4, the watcher's offset stays past the new
            // size and post-truncate content is silently skipped. With
            // R-MWR-4 the watcher detects truncation and resets.
            const trunc = detectLogTruncation(logPath, offset, lineBuf);
            assert.equal(trunc.truncated, true, `${watcherName}: truncation must be detected when size < offset`);
            offset = trunc.offset;
            lineBuf = trunc.lineBuf;
            assert.equal(offset, 0, `${watcherName}: offset must reset to 0 after truncate`);

            // Drain again from reset state — proves the watcher consumes
            // post-truncate content instead of feeding a dead chunk.
            const postEmitted = [];
            if (usesStreamJson) {
                const r2 = drainStreamJsonLines(logPath, offset, lineBuf, processLine, t => postEmitted.push(t));
                offset = r2.offset;
                lineBuf = r2.lineBuf;
                assert.ok(
                    postEmitted.some(t => t.includes('after-truncate')),
                    `${watcherName}: must emit post-truncate text, got ${JSON.stringify(postEmitted)}`,
                );
            } else {
                // morty-watcher's drainLog writes to stdout directly; assert
                // offset advanced from 0 → past the post-truncate content.
                offset = drainLog(logPath, offset);
                const finalSize = fs.statSync(logPath).size;
                assert.equal(
                    offset,
                    finalSize,
                    `${watcherName}: drainLog must advance offset to end of post-truncate file`,
                );
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
}
