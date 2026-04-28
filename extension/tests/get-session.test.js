import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSessionPath } from '../bin/get-session.js';

/**
 * All tests use EXTENSION_DIR to isolate from the real ~/.claude/pickle-rick/.
 * A temp dir stands in as the extension root; current_sessions.json is
 * created (or not) inside that temp dir as each test requires.
 */

function withExtensionDir(fn) {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gs-')));
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpDir;
    try {
        return fn(tmpDir);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// --- No sessions map ---

test('getSessionPath: returns null when no sessions map exists', () => {
    withExtensionDir(() => {
        // No current_sessions.json created — dir is empty
        const result = getSessionPath('/some/cwd');
        assert.equal(result, null);
    });
});

// --- cwd not in map ---

test('getSessionPath: returns null when cwd is not in map', () => {
    withExtensionDir((tmpDir) => {
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ '/other/cwd': '/some/session' })
        );
        const result = getSessionPath('/definitely/not/a/real/cwd/xyzzy');
        assert.equal(result, null);
    });
});

// --- session path does not exist on disk ---

test('getSessionPath: returns null when mapped session dir does not exist', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = '/tmp/pickle-gs-fake-cwd';
        const missingSession = '/tmp/nonexistent-session-dir-xyz-abc';
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: missingSession })
        );
        const result = getSessionPath(fakeCwd);
        assert.equal(result, null);
    });
});

// --- Happy path ---

test('getSessionPath: returns session path when map entry and dir both exist', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gs-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        fs.mkdirSync(fakeCwd, { recursive: true });

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: sessionDir })
        );

        try {
            const result = getSessionPath(fakeCwd);
            assert.equal(result, sessionDir);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            fs.rmSync(fakeCwd, { recursive: true, force: true });
        }
    });
});

test('getSessionPath: falls back to active session state when the sessions map is missing', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const sessionDir = path.join(tmpDir, 'sessions', 'fallback-session');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: sessionDir })
        );

        const result = getSessionPath(fakeCwd);
        assert.equal(result, sessionDir);
    });
});

test('getSessionPath: stale mapped inactive session does not outrank a live session for the same cwd', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const staleSessionDir = path.join(tmpDir, 'sessions', 'stale-session');
        const liveSessionDir = path.join(tmpDir, 'sessions', 'live-session');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: staleSessionDir })
        );
        fs.writeFileSync(
            path.join(staleSessionDir, 'state.json'),
            JSON.stringify({ active: false, working_dir: fakeCwd, session_dir: staleSessionDir })
        );
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: liveSessionDir })
        );

        const result = getSessionPath(fakeCwd);
        assert.equal(result, liveSessionDir);
    });
});

test('getSessionPath: unreadable mapped state does not outrank a live session for the same cwd', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const staleSessionDir = path.join(tmpDir, 'sessions', 'stale-session');
        const liveSessionDir = path.join(tmpDir, 'sessions', 'live-session');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: staleSessionDir })
        );
        fs.writeFileSync(path.join(staleSessionDir, 'state.json'), '{{{corrupt json');
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: liveSessionDir })
        );

        const result = getSessionPath(fakeCwd);
        assert.equal(result, liveSessionDir);
    });
});
