import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SETUP_BIN = path.resolve(__dirname, '../bin/worker-setup.js');

/**
 * Create an isolated temp root directory for EXTENSION_DIR.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks,
 * ensuring path keys in the sessions map match process.cwd() in subprocesses.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-worker-setup-')));
}

/**
 * Run worker-setup.js as a subprocess with isolated EXTENSION_DIR.
 * @param {string} extDir - the EXTENSION_DIR to use
 * @param {string[]} args - additional arguments to pass
 * @param {string} [cwd] - working directory for the subprocess (defaults to extDir)
 */
function run(extDir, args = [], cwd) {
    return spawnSync(process.execPath, [WORKER_SETUP_BIN, ...args], {
        cwd: cwd || extDir,
        env: { ...process.env, EXTENSION_DIR: extDir },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

// --- No session found: no --resume, no sessions map ---

test('worker-setup: exits with code 1 when no session path found', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('No session path found'),
            `Expected "No session path found" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- --resume with valid path ---

test('worker-setup: succeeds with --resume pointing to a valid session dir', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session directory that exists
        const sessionDir = path.join(tmpRoot, 'sessions', 'test-session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const result = run(tmpRoot, ['--resume', sessionDir]);
        assert.equal(result.status, 0, `Expected exit code 0, got: ${result.status}. stderr: ${result.stderr}`);
        assert.ok(
            result.stdout.includes('Morty Worker Initialized'),
            `Expected "Morty Worker Initialized" in stdout, got: ${result.stdout}`
        );
        // Should include the session basename in the output
        assert.ok(
            result.stdout.includes('test-session'),
            `Expected session name "test-session" in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- --resume with nonexistent path and no sessions map → exit 1 ---

test('worker-setup: exits with code 1 when --resume path does not exist and no map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot, ['--resume', '/nonexistent/session/path/xyz']);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('No session path found'),
            `Expected "No session path found" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session from current_sessions.json map ---

test('worker-setup: resolves session from current_sessions.json using cwd', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session directory
        const sessionDir = path.join(tmpRoot, 'sessions', 'map-session');
        fs.mkdirSync(sessionDir, { recursive: true });

        // Create a cwd directory that will be the subprocess working directory
        const cwdDir = path.join(tmpRoot, 'repo');
        fs.mkdirSync(cwdDir, { recursive: true });
        // Resolve to real path (macOS /var -> /private/var)
        const realCwd = fs.realpathSync(cwdDir);

        // Write sessions map with the cwd -> session mapping
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ [realCwd]: sessionDir })
        );

        const result = run(tmpRoot, [], realCwd);
        assert.equal(result.status, 0, `Expected exit code 0, got: ${result.status}. stderr: ${result.stderr}`);
        assert.ok(
            result.stdout.includes('Morty Worker Initialized'),
            `Expected "Morty Worker Initialized" in stdout, got: ${result.stdout}`
        );
        assert.ok(
            result.stdout.includes('map-session'),
            `Expected session name "map-session" in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Corrupt sessions map → falls through to exit 1 ---

test('worker-setup: exits with code 1 when sessions map is corrupt JSON', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Write garbage to sessions map
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            '{{{not valid json!!!!'
        );

        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('No session path found'),
            `Expected "No session path found" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Sessions map exists but cwd not in map → exit 1 ---

test('worker-setup: exits with code 1 when cwd is not in sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Write sessions map that doesn't contain our cwd
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ '/some/other/project': '/some/other/session' })
        );

        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('No session path found'),
            `Expected "No session path found" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- --resume takes priority over sessions map ---

test('worker-setup: --resume path takes priority over sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create two session directories
        const resumeSession = path.join(tmpRoot, 'sessions', 'resume-session');
        fs.mkdirSync(resumeSession, { recursive: true });

        const mapSession = path.join(tmpRoot, 'sessions', 'map-session');
        fs.mkdirSync(mapSession, { recursive: true });

        // Create a cwd and sessions map pointing to map-session
        const realTmpRoot = fs.realpathSync(tmpRoot);
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ [realTmpRoot]: mapSession })
        );

        // Pass --resume pointing to resume-session
        const result = run(tmpRoot, ['--resume', resumeSession], realTmpRoot);
        assert.equal(result.status, 0, `Expected exit code 0, got: ${result.status}. stderr: ${result.stderr}`);
        assert.ok(
            result.stdout.includes('resume-session'),
            `Expected "resume-session" (from --resume) in stdout, got: ${result.stdout}`
        );
        assert.ok(
            !result.stdout.includes('map-session'),
            `Should NOT contain "map-session" — --resume should take priority, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- --resume value starting with -- is ignored (falls through to map) ---

test('worker-setup: --resume with flag-like value falls through to sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // --resume value starts with -- so it should be ignored
        const result = run(tmpRoot, ['--resume', '--bad-flag']);
        // With no sessions map either, should exit 1
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Sessions map session dir doesn't exist on disk → exit 1 ---

test('worker-setup: exits with code 1 when mapped session dir does not exist on disk', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const realTmpRoot = fs.realpathSync(tmpRoot);
        // Map points to a non-existent directory
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ [realTmpRoot]: '/nonexistent/session/dir/xyz' })
        );

        const result = run(tmpRoot, [], realTmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('No session path found'),
            `Expected "No session path found" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
