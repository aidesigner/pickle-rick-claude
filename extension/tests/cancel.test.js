import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cancelSession } from '../bin/cancel.js';

const extensionRoot = path.join(os.homedir(), '.claude/pickle-rick');
const sessionsMapPath = path.join(extensionRoot, 'current_sessions.json');

// Helper: build a minimal session + state, register it, return cleanup fn
function makeSession(active = true) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cancel-'));
    const state = { active, step: 'research', iteration: 1, original_prompt: 'test' };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
    return sessionDir;
}

function withSessionMap(map, fn) {
    const originalExists = fs.existsSync(sessionsMapPath);
    const original = originalExists ? fs.readFileSync(sessionsMapPath, 'utf-8') : null;
    fs.mkdirSync(path.dirname(sessionsMapPath), { recursive: true });
    fs.writeFileSync(sessionsMapPath, JSON.stringify(map));
    try {
        fn();
    } finally {
        if (original !== null) {
            fs.writeFileSync(sessionsMapPath, original);
        } else if (fs.existsSync(sessionsMapPath)) {
            fs.unlinkSync(sessionsMapPath);
        }
    }
}

// --- No sessions map ---

test('cancelSession: returns early when no sessions map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cancel-'));
    try {
        // If sessions map exists, skip — we can't safely remove it
        if (!fs.existsSync(sessionsMapPath)) {
            // Should not throw
            assert.doesNotThrow(() => cancelSession(dir));
        }
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- No session for cwd ---

test('cancelSession: returns early when cwd not in sessions map', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const fakeCwd = '/nonexistent/path/that/will/never/be/in/the/map';
    // Should not throw
    assert.doesNotThrow(() => cancelSession(fakeCwd));
});

// --- Missing state.json ---

test('cancelSession: returns early when state.json missing', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cancel-'));
    const fakeCwd = sessionDir + '-cwd';
    fs.mkdirSync(fakeCwd, { recursive: true });

    // No state.json written — just the dir
    withSessionMap({ [fakeCwd]: sessionDir }, () => {
        assert.doesNotThrow(() => cancelSession(fakeCwd));
    });

    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(fakeCwd, { recursive: true });
});

// --- Happy path: sets active=false ---

test('cancelSession: sets active=false in state.json', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const sessionDir = makeSession(true);
    const fakeCwd = sessionDir + '-cwd';
    fs.mkdirSync(fakeCwd, { recursive: true });

    withSessionMap({ [fakeCwd]: sessionDir }, () => {
        cancelSession(fakeCwd);
    });

    const updated = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(updated.active, false, 'active should be false after cancel');

    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(fakeCwd, { recursive: true });
});

// --- Already inactive: still writes false ---

test('cancelSession: idempotent — already-inactive session stays inactive', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const sessionDir = makeSession(false);
    const fakeCwd = sessionDir + '-cwd';
    fs.mkdirSync(fakeCwd, { recursive: true });

    withSessionMap({ [fakeCwd]: sessionDir }, () => {
        cancelSession(fakeCwd);
    });

    const updated = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(updated.active, false);

    fs.rmSync(sessionDir, { recursive: true });
    fs.rmSync(fakeCwd, { recursive: true });
});
