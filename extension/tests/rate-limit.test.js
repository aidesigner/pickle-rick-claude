import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectRateLimitInLog,
    detectRateLimitInText,
    classifyIterationExit,
} from '../bin/tmux-runner.js';

function makeTmpDir(prefix = 'rl-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
// detectRateLimitInLog
// ---------------------------------------------------------------------------

test('detectRateLimitInLog: returns true for rate_limit_event with status rejected', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } }),
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false when no rate_limit_event present', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All good' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false for rate_limit_event with non-rejected status', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', status: 'allowed' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: handles non-JSON lines gracefully', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            '{not valid json',
            'plain text line',
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false for missing file', () => {
    assert.equal(detectRateLimitInLog('/nonexistent/path/iter.log'), false);
});

test('detectRateLimitInLog: only scans last 100 lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Put rate limit event at line 1, then 150 normal lines after it
        const lines = [JSON.stringify({ type: 'rate_limit_event', status: 'rejected' })];
        for (let i = 0; i < 150; i++) {
            lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }));
        }
        fs.writeFileSync(logFile, lines.join('\n'));
        // The rate_limit_event is at index 0, tail(-100) starts at index 51 — should miss it
        assert.equal(detectRateLimitInLog(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// detectRateLimitInText
// ---------------------------------------------------------------------------

test('detectRateLimitInText: detects "5 per hour limit" pattern', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'You have exceeded your 5 requests per hour limit.' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "limit reached try back" pattern', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Limit has been reached. Please try back later.' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "usage limit reached" pattern', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Your usage limit has been reached for today.' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "rate limit" pattern', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API rate limit exceeded.' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside tool_result lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Rate limit text appears but inside a tool_result line — should be filtered out
        const lines = [
            '{"type":"tool_result","content":"Error: rate limit exceeded"}',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside user lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            '{"type":"user","content":"Please handle rate limit errors"}',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: does not detect text beyond last 100 lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Rate limit text at line 1, then 150 clean lines
        const lines = ['Rate limit exceeded'];
        for (let i = 0; i < 150; i++) {
            lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `clean line ${i}` }] } }));
        }
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for missing file', () => {
    assert.equal(detectRateLimitInText('/nonexistent/path/iter.log'), false);
});

test('detectRateLimitInText: returns false for clean log', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Everything is fine.' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// classifyIterationExit
// ---------------------------------------------------------------------------

test('classifyIterationExit: task_completed → success', () => {
    assert.equal(classifyIterationExit('task_completed', '/nonexistent/log'), 'success');
});

test('classifyIterationExit: review_clean → success', () => {
    assert.equal(classifyIterationExit('review_clean', '/nonexistent/log'), 'success');
});

test('classifyIterationExit: error → error', () => {
    assert.equal(classifyIterationExit('error', '/nonexistent/log'), 'error');
});

test('classifyIterationExit: inactive → inactive', () => {
    assert.equal(classifyIterationExit('inactive', '/nonexistent/log'), 'inactive');
});

test('classifyIterationExit: continue with rate_limit_event in log → api_limit', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile), 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate limit text in log → api_limit', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API rate limit hit' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile), 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with clean log → success', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done, nothing special.' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile), 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with missing log file → success', () => {
    assert.equal(classifyIterationExit('continue', '/nonexistent/log'), 'success');
});

test('classifyIterationExit: NDJSON detection takes priority over text detection', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Both NDJSON and text patterns present — NDJSON checked first
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
            'Rate limit exceeded in plain text too',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile), 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
