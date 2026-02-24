import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANCEL_BIN = path.resolve(__dirname, '../bin/cancel.js');

/**
 * Create an isolated temp root directory for EXTENSION_DIR.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks,
 * ensuring path keys in the sessions map match process.cwd() in subprocesses.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cancel-')));
}

/**
 * Write a current_sessions.json into the given extension root.
 */
function writeSessionsMap(extRoot, map) {
    fs.writeFileSync(path.join(extRoot, 'current_sessions.json'), JSON.stringify(map, null, 2));
}

/**
 * Read and parse the current_sessions.json from the given extension root.
 */
function readSessionsMap(extRoot) {
    return JSON.parse(fs.readFileSync(path.join(extRoot, 'current_sessions.json'), 'utf-8'));
}

/**
 * Create a session directory with a state.json inside it.
 */
function makeSessionDir(parentDir, active = true) {
    const sessionDir = path.join(parentDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = { active, step: 'research', iteration: 1, original_prompt: 'test' };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
    return sessionDir;
}

/**
 * Read and parse state.json from a session directory.
 */
function readState(sessionDir) {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
}

/**
 * Run cancel.js as a subprocess with isolated EXTENSION_DIR.
 * @param {string} extRoot - the EXTENSION_DIR to use
 * @param {string} cwd - the working directory (used as the sessions map key)
 */
function runCancelSubprocess(extRoot, cwd) {
    return execFileSync(process.execPath, [CANCEL_BIN], {
        cwd,
        env: { ...process.env, EXTENSION_DIR: extRoot },
        encoding: 'utf-8',
    });
}

// --- No sessions map ---

test('cancelSession: returns early when no sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // No current_sessions.json written — should not throw
        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active sessions map found'), 'should report missing sessions map');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- No session for cwd ---

test('cancelSession: returns early when cwd not in sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Sessions map exists but doesn't contain our cwd
        writeSessionsMap(tmpRoot, { '/some/other/path': '/some/other/session' });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active session found'), 'should report no session for cwd');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing state.json ---

test('cancelSession: returns early when state.json missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Session dir exists but has no state.json
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        // Map points tmpRoot -> sessionDir (subprocess cwd will be tmpRoot)
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('State file not found'), 'should report missing state file');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Happy path: sets active=false ---

test('cancelSession: sets active=false in state.json', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should be false after cancel');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Sessions map cleanup ---

test('cancelSession: removes cwd entry from sessions map after cancel', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        writeSessionsMap(tmpRoot, {
            [tmpRoot]: sessionDir,
            '/other/dir': '/other/session',
        });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const map = readSessionsMap(tmpRoot);
        assert.equal(map[tmpRoot], undefined, 'cancelled cwd must be removed from sessions map');
        assert.equal(map['/other/dir'], '/other/session', 'other sessions must not be affected');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Already inactive: still writes false ---

test('cancelSession: idempotent — already-inactive session stays inactive', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, false);
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should remain false');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Preserves other state fields ---

test('cancelSession: preserves other state fields when setting active=false', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const state = { active: true, step: 'implement', iteration: 3, original_prompt: 'build the thing' };
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should be false');
        assert.equal(updated.step, 'implement', 'step should be preserved');
        assert.equal(updated.iteration, 3, 'iteration should be preserved');
        assert.equal(updated.original_prompt, 'build the thing', 'original_prompt should be preserved');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Unreadable sessions map ---

test('cancelSession: returns early when sessions map is unreadable JSON', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Write garbage to sessions map
        fs.writeFileSync(path.join(tmpRoot, 'current_sessions.json'), '{{{{not json}}}}');

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('Sessions map is unreadable'), 'should report unreadable sessions map');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Unreadable state.json should NOT print "Loop Cancelled" (deep review pass 5)
// ---------------------------------------------------------------------------

test('cancelSession: unreadable state.json does NOT print Loop Cancelled', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Write corrupt state.json
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{{{corrupt json');

        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        // Must NOT claim the loop was cancelled when state was unreadable
        assert.ok(
            !output.includes('Loop Cancelled'),
            `Should not print "Loop Cancelled" for unreadable state, got: ${output}`
        );
        // Should print an appropriate error message
        assert.ok(
            output.includes('unreadable') || output.includes('Failed'),
            `Should report unreadable state or failure, got: ${output}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
