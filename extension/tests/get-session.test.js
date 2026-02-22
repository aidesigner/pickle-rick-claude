import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSessionPath } from '../bin/get-session.js';

const extensionRoot = path.join(os.homedir(), '.claude/pickle-rick');
const sessionsMapPath = path.join(extensionRoot, 'current_sessions.json');

function withSessionMap(map, fn) {
    const originalExists = fs.existsSync(sessionsMapPath);
    const original = originalExists ? fs.readFileSync(sessionsMapPath, 'utf-8') : null;
    fs.mkdirSync(path.dirname(sessionsMapPath), { recursive: true });
    fs.writeFileSync(sessionsMapPath, JSON.stringify(map));
    try {
        return fn();
    } finally {
        if (original !== null) {
            fs.writeFileSync(sessionsMapPath, original);
        } else if (fs.existsSync(sessionsMapPath)) {
            fs.unlinkSync(sessionsMapPath);
        }
    }
}

// --- No sessions map ---

test('getSessionPath: returns null when no sessions map exists', () => {
    if (fs.existsSync(sessionsMapPath)) return; // can't safely test without map
    const result = getSessionPath('/some/cwd');
    assert.equal(result, null);
});

// --- cwd not in map ---

test('getSessionPath: returns null when cwd is not in map', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const result = getSessionPath('/definitely/not/a/real/cwd/xyzzy');
    assert.equal(result, null);
});

// --- session path does not exist on disk ---

test('getSessionPath: returns null when mapped session dir does not exist', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const fakeCwd = '/tmp/pickle-gs-fake-cwd';
    const missingSession = '/tmp/nonexistent-session-dir-xyz-abc';

    const result = withSessionMap({ [fakeCwd]: missingSession }, () => {
        return getSessionPath(fakeCwd);
    });
    assert.equal(result, null);
});

// --- Happy path ---

test('getSessionPath: returns session path when map entry and dir both exist', () => {
    if (!fs.existsSync(sessionsMapPath)) return;

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gs-'));
    const fakeCwd = sessionDir + '-cwd';
    fs.mkdirSync(fakeCwd, { recursive: true });

    try {
        const result = withSessionMap({ [fakeCwd]: sessionDir }, () => {
            return getSessionPath(fakeCwd);
        });
        assert.equal(result, sessionDir);
    } finally {
        fs.rmSync(sessionDir, { recursive: true });
        fs.rmSync(fakeCwd, { recursive: true });
    }
});
