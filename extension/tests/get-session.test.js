// @tier: fast
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
    const savedNodeEnv = process.env.NODE_ENV;
    const savedAllowMissingSentinel = process.env.EXTENSION_DIR_TEST;
    process.env.EXTENSION_DIR_TEST = '1';
    process.env.NODE_ENV = 'test';
    process.env.EXTENSION_DIR = tmpDir;
    try {
        return fn(tmpDir);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = savedNodeEnv;
        }
        if (savedAllowMissingSentinel === undefined) {
            delete process.env.EXTENSION_DIR_TEST;
        } else {
            process.env.EXTENSION_DIR_TEST = savedAllowMissingSentinel;
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

test('getSessionPath: promotes newer dead current_sessions tmp before map lookup', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gs-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        fs.mkdirSync(fakeCwd, { recursive: true });

        const mapPath = path.join(tmpDir, 'current_sessions.json');
        const tmpMapPath = `${mapPath}.tmp.99999999.${Date.now()}`;
        fs.writeFileSync(mapPath, JSON.stringify({ '/other/cwd': '/other/session' }));
        fs.writeFileSync(tmpMapPath, JSON.stringify({ [fakeCwd]: sessionDir }));
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: sessionDir })
        );
        const baseTime = new Date('2026-04-28T12:00:00.000Z');
        const tmpTime = new Date('2026-04-28T12:00:01.000Z');
        fs.utimesSync(mapPath, baseTime, baseTime);
        fs.utimesSync(tmpMapPath, tmpTime, tmpTime);

        try {
            const result = getSessionPath(fakeCwd);
            assert.equal(result, sessionDir);
            assert.equal(fs.existsSync(tmpMapPath), false, 'dead tmp map should be promoted');
            assert.deepEqual(JSON.parse(fs.readFileSync(mapPath, 'utf-8')), { [fakeCwd]: sessionDir });
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

test('getSessionPath: missing map prefers the newest inactive same-cwd fallback session', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const sessionsDir = path.join(tmpDir, 'sessions');
        const oldSessionDir = path.join(sessionsDir, '2026-04-01-old');
        const newSessionDir = path.join(sessionsDir, '2026-04-28-new');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(oldSessionDir, { recursive: true });
        fs.mkdirSync(newSessionDir, { recursive: true });

        const oldStatePath = path.join(oldSessionDir, 'state.json');
        const newStatePath = path.join(newSessionDir, 'state.json');
        fs.writeFileSync(
            oldStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                session_dir: oldSessionDir,
                current_ticket: 'T-OLD',
                started_at: '2026-04-01T12:00:00.000Z',
            })
        );
        fs.writeFileSync(
            newStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                session_dir: newSessionDir,
                current_ticket: 'T-NEW',
                started_at: '2026-04-28T12:00:00.000Z',
            })
        );
        fs.utimesSync(oldStatePath, new Date('2026-04-01T12:00:00.000Z'), new Date('2026-04-01T12:00:00.000Z'));
        fs.utimesSync(newStatePath, new Date('2026-04-28T12:00:00.000Z'), new Date('2026-04-28T12:00:00.000Z'));

        const result = getSessionPath(fakeCwd);
        assert.equal(result, newSessionDir);
    });
});

test('getSessionPath: future-dated started_at does not outrank a newer same-cwd fallback session', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const sessionsDir = path.join(tmpDir, 'sessions');
        const staleSessionDir = path.join(sessionsDir, 'stale-future');
        const liveSessionDir = path.join(sessionsDir, 'live-current');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });

        const staleStatePath = path.join(staleSessionDir, 'state.json');
        const liveStatePath = path.join(liveSessionDir, 'state.json');
        fs.writeFileSync(
            staleStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                session_dir: staleSessionDir,
                current_ticket: 'T-FUTURE',
                started_at: '2099-12-31T23:59:59.000Z',
            })
        );
        fs.writeFileSync(
            liveStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                session_dir: liveSessionDir,
                current_ticket: 'T-LIVE',
                started_at: '2026-04-28T12:00:00.000Z',
            })
        );
        fs.utimesSync(staleStatePath, new Date('2026-04-01T12:00:00.000Z'), new Date('2026-04-01T12:00:00.000Z'));
        fs.utimesSync(liveStatePath, new Date('2026-04-28T12:00:00.000Z'), new Date('2026-04-28T12:00:00.000Z'));

        const result = getSessionPath(fakeCwd);
        assert.equal(result, liveSessionDir);
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

test('getSessionPath: mapped session missing active does not outrank a live session for the same cwd', () => {
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
            JSON.stringify({ working_dir: fakeCwd, session_dir: staleSessionDir })
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

test('getSessionPath: mapped dead-pid active session does not outrank a live same-cwd session', () => {
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
            JSON.stringify({ active: true, pid: 99999999, working_dir: fakeCwd, session_dir: staleSessionDir })
        );
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: liveSessionDir })
        );

        const result = getSessionPath(fakeCwd);
        assert.equal(result, liveSessionDir);
    });
});

// --- AC-A3: deterministic, stable recency tie-break (no lexical localeCompare) ---

/**
 * Two same-cwd active no-pid sessions with EQUAL state_mtime_ms and no
 * started_at. The scan iterates fs.readdirSync(sessionsDir) order, so the
 * first-seen session wins (stable, incumbent-keeps). The OLD localeCompare
 * tie-break would instead pick the lexically LARGER path. We assert the
 * winner is the FIRST entry in readdir order and that swapping which physical
 * directory holds the (identical) live state does NOT flip the winner away
 * from "first-iterated".
 */
function runEqualMtimeTieScenario(tmpDir, dirAName, dirBName) {
    const fakeCwd = path.join(tmpDir, 'repo');
    const dirA = path.join(tmpDir, 'sessions', dirAName);
    const dirB = path.join(tmpDir, 'sessions', dirBName);
    fs.mkdirSync(fakeCwd, { recursive: true });
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    // Active, no pid, no started_at — recency is state_mtime_ms only.
    const stateFor = (dir) =>
        JSON.stringify({ active: true, working_dir: fakeCwd, session_dir: dir });
    fs.writeFileSync(path.join(dirA, 'state.json'), stateFor(dirA));
    fs.writeFileSync(path.join(dirB, 'state.json'), stateFor(dirB));

    // Force EQUAL mtimes on both state.json files (Linux coarse-mtime tie).
    const t = new Date('2026-06-16T00:00:00.000Z');
    fs.utimesSync(path.join(dirA, 'state.json'), t, t);
    fs.utimesSync(path.join(dirB, 'state.json'), t, t);

    const order = fs.readdirSync(path.join(tmpDir, 'sessions'));
    const firstSeenDir = path.join(tmpDir, 'sessions', order[0]);
    const result = getSessionPath(fakeCwd);
    return { result, firstSeenDir };
}

test('getSessionPath: equal-mtime no-pid tie returns the first-seen session (stable, no localeCompare)', () => {
    withExtensionDir((tmpDir) => {
        const { result, firstSeenDir } = runEqualMtimeTieScenario(tmpDir, 'aaa-session', 'zzz-session');
        // Stable, recency-meaningful rule: incumbent (first-iterated) wins.
        assert.equal(result, firstSeenDir);
    });
});

test('getSessionPath: equal-mtime tie winner does not flip when session-dir basenames are lexically swapped', () => {
    let firstRun;
    withExtensionDir((tmpDir) => {
        firstRun = runEqualMtimeTieScenario(tmpDir, 'aaa-session', 'zzz-session');
    });
    let swapped;
    withExtensionDir((tmpDir) => {
        // Same two basenames, identical live content. The winner must remain the
        // first-iterated dir, NOT the lexically larger one (old localeCompare).
        swapped = runEqualMtimeTieScenario(tmpDir, 'zzz-session', 'aaa-session');
    });
    // In both arrangements the winner is the first entry in readdir order.
    assert.equal(firstRun.result, firstRun.firstSeenDir);
    assert.equal(swapped.result, swapped.firstSeenDir);
    // Both winners share the same basename (readdir is order-stable for the
    // same set of names) — proving the result is determined by iteration
    // order, not by lexical comparison of full paths.
    assert.equal(path.basename(firstRun.result), path.basename(swapped.result));
});
