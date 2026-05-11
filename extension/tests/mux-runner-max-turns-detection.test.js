// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectManagerMaxTurnsExit } from '../bin/mux-runner.js';

function writeLog(contents) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-max-turns-')));
    const logFile = path.join(dir, 'tmux_iteration_7.log');
    fs.writeFileSync(logFile, contents);
    return { dir, logFile };
}

function outcomeFixture(overrides = {}) {
    return {
        completion: 'error',
        timedOut: false,
        exitCode: 0,
        wallSeconds: 14400,
        ...overrides,
    };
}

test('max-turns-detection: clean claude end_turn result returns true', () => {
    const { dir, logFile } = writeLog([
        '{"type":"assistant","message":{"role":"assistant"}}',
        '{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: non-zero exit code returns false even with matching result event', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture({ exitCode: 1 }), logFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: timed out outcome returns false even with matching result event', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture({ timedOut: true }), logFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: crash signature returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"error","is_error":true}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: malformed trailing JSON returns false', () => {
    const { dir, logFile } = writeLog([
        '{"type":"assistant","message":{"role":"assistant"}}',
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing log file returns false', () => {
    assert.equal(
        detectManagerMaxTurnsExit(outcomeFixture(), '/definitely/missing/pickle-max-turns.log'),
        false,
    );
});

test('max-turns-detection: last result event must match even if earlier one does', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
