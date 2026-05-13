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

function managerResultFixture(overrides = {}) {
    return {
        completion: 'error',
        timedOut: false,
        exitCode: 0,
        wallSeconds: 42,
        ...overrides,
    };
}

test('max-turns-detection: clean claude end_turn result at budget returns true', () => {
    const { dir, logFile } = writeLog([
        '{"type":"assistant","message":{"role":"assistant"}}',
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: timed out hang-guard outcome returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ timedOut: true }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: non-zero exit code returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ exitCode: 1 }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event with is_error true returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":true,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing log file returns false', () => {
    assert.equal(
        detectManagerMaxTurnsExit(managerResultFixture(), '/definitely/missing/pickle-max-turns.log', 40),
        false,
    );
});

test('max-turns-detection: non-error completion returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ completion: 'continue' }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event must match even if earlier one does not', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event stop_reason mismatch returns false', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: below-budget num_turns returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":39}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing max-turns budget returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, null), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
