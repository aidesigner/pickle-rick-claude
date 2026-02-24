import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');

/**
 * Run spawn-morty.js as a subprocess and return the result.
 * @param {string[]} args - CLI arguments
 * @param {Record<string, string>} env - extra env vars to merge
 */
function run(args, env = {}) {
    return spawnSync(process.execPath, [SPAWN_MORTY_BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

/**
 * Create an isolated temp directory (resolves macOS /var -> /private/var symlinks).
 */
function makeTmpDir(prefix = 'pickle-spawn-morty-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// --- Argument validation ---

test('spawn-morty: no args → exit 1, prints Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stdout.includes('Usage'), 'stdout should include Usage');
});

test('spawn-morty: missing --ticket-id → exit 1, prints required', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stdout.includes('required'), 'stdout should mention required');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: missing --ticket-path → exit 1, prints required', () => {
    const result = run([
        'some-task',
        '--ticket-id', 'ticket-001',
    ]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stdout.includes('required'), 'stdout should mention required');
});

test('spawn-morty: invalid ticket-id characters → exit 1, prints invalid characters', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '../etc/passwd',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stdout.includes('invalid characters'),
            'stdout should mention invalid characters'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id without value (last arg) → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        // --ticket-id is the last arg so args[ticketIdIndex + 1] is undefined
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
            '--ticket-id',
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id value starts with -- → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '--oops',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stdout.includes('non-empty values'),
            'stdout should mention non-empty values'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: valid args but no claude binary → exit 1 (spawn failure, not validation)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Set PATH to only /usr/bin so `claude` cannot be found.
        // The process should get past all validation and fail when spawning claude.
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-42',
                '--ticket-path', tmpDir,
            ],
            { PATH: '/usr/bin' }
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        // It should NOT be a validation error — it got past validation
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error (got past validation)'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" validation error'
        );
        assert.ok(
            !result.stdout.includes('invalid characters'),
            'should not be an "invalid characters" validation error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --timeout with custom value is accepted (no validation error)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Same as the "no claude" test, but with --timeout to verify it parses without error.
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-99',
                '--ticket-path', tmpDir,
                '--timeout', '30',
            ],
            { PATH: '/usr/bin' }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // No validation errors — it accepted the timeout and moved on
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
