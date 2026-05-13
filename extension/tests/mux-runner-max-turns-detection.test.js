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

// R-ICDM-1: detectManagerMaxTurnsExit requires `num_turns >= maxTurns` in
// addition to the success-shape checks. A clean exit alone is NOT enough —
// only a clean exit AT or PAST the manager's turn budget counts as max-turns.
test('max-turns-detection: clean claude end_turn result with num_turns at budget returns true', () => {
    const { dir, logFile } = writeLog([
        '{"type":"assistant","message":{"role":"assistant"}}',
        '{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: clean exit with num_turns BELOW budget returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":50}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing num_turns returns false (conservative)', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: null maxTurns returns false (conservative)', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, null), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: non-zero exit code returns false even with matching result event', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture({ exitCode: 1 }), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: timed out outcome returns false even with matching result event', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture({ timedOut: true }), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: crash signature returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"error","is_error":true,"num_turns":400}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), false);
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
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing log file returns false', () => {
    assert.equal(
        detectManagerMaxTurnsExit(outcomeFixture(), '/definitely/missing/pickle-max-turns.log', 400),
        false,
    );
});

test('max-turns-detection: last result event must match even if earlier one does', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false,"num_turns":400}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(outcomeFixture(), logFile, 400), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
