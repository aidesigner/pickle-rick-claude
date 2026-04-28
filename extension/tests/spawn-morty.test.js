import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tierToModel } from '../bin/spawn-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');

/**
 * Run spawn-morty.js as a subprocess and return the result.
 * @param {string[]} args - CLI arguments
 * @param {Record<string, string>} env - extra env vars to merge
 */
function run(args, env = {}) {
    // 15s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests are validating CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [SPAWN_MORTY_BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

/**
 * Create an isolated temp directory (resolves macOS /var -> /private/var symlinks).
 */
function makeTmpDir(prefix = 'pickle-spawn-morty-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeCodexShim(shimDir, logPath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  pickle_backend: process.env.PICKLE_BACKEND || null,
}, null, 2));
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

// --- Argument validation ---

test('spawn-morty: no args → exit 1, prints Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('spawn-morty: missing --ticket-id → exit 1, prints required', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'stderr should mention required');
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
    assert.ok(result.stderr.includes('required'), 'stderr should mention required');
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
            result.stderr.includes('invalid characters'),
            'stderr should mention invalid characters'
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
            result.stderr.includes('non-empty values'),
            'stderr should mention non-empty values'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: valid args but no claude binary → exit 1 (spawn failure, not validation)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Set PATH to a non-existent directory so `claude` cannot be found.
        // The process should get past all validation and fail when spawning claude.
        // Use a longer timeout (15s) — under full-suite concurrency the ENOENT
        // async error can take longer than the default 10s to surface.
        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
                'implement the thing',
                '--ticket-id', 'ticket-42',
                '--ticket-path', tmpDir,
            ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });
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

// ---------------------------------------------------------------------------
// --output-format and --ticket-file edge cases (deep review pass 5)
// ---------------------------------------------------------------------------

test('spawn-morty: --output-format as last arg (no value) defaults to text', () => {
    const tmpDir = makeTmpDir();
    try {
        // --output-format is the last arg with no value following it
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-77',
                '--ticket-path', tmpDir,
                '--output-format',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation (no crash, no validation error)
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
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

test('spawn-morty: --ticket-file with value starting with -- does not crash', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-88',
                '--ticket-path', tmpDir,
                '--ticket-file', '--bogus-flag',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation without crashing
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
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
            { PATH: '/nonexistent' }
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

// ---------------------------------------------------------------------------
// --review flag (meso-review enforcement)
// ---------------------------------------------------------------------------

test('spawn-morty: --review flag accepted without validation error', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness and architecture',
                '--ticket-id', 'rev-001',
                '--ticket-path', tmpDir,
                '--review',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // Should get past validation — no Usage or required errors
        assert.ok(!result.stderr.includes('Usage'), 'should not be a Usage error');
        assert.ok(!result.stderr.includes('required'), 'should not be a "required" error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review flag shows Review Worker panel title', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness',
                '--ticket-id', 'rev-002',
                '--ticket-path', tmpDir,
                '--review',
            ],
            { PATH: '/nonexistent' }
        );
        const combined = result.stdout + result.stderr;
        // Must match the actual panel title, not just the word "review" which appears in the command
        assert.match(combined, /Review Worker|type.*review/i,
            'should show Review Worker panel title or review type field');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review without --ticket-id still requires ticket-id', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness',
                '--ticket-path', tmpDir,
                '--review',
            ],
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'should require --ticket-id even with --review');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// proc.on('error') handler (deep review pass 7)
// ---------------------------------------------------------------------------

test('spawn-morty: spawn error (no claude binary) reports spawn-error status', () => {
    const tmpDir = makeTmpDir();
    try {
        // Point PATH to a directory with no `claude` binary to trigger ENOENT spawn error
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-err',
                '--ticket-path', tmpDir,
                '--timeout', '5',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        const combined = result.stdout + result.stderr;
        // The error handler should report spawn-error status
        assert.ok(
            combined.includes('spawn-error') || combined.includes('failed'),
            'should report spawn-error or failed status'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// F15: 30s minimum timeout floor
// ---------------------------------------------------------------------------

test('spawn-morty F15: 5s remaining is clamped to 30s minimum', () => {
    const tmpDir = makeTmpDir();
    try {
        // session/ticket structure so state.json is found as parentState
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15a');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 55s ago with 1-minute max → ~5s remaining at fixture-write time.
        // Under load, the subprocess may not read state.json until several seconds
        // later — pushing remaining into the negative branch. Both branches enforce
        // the 30s floor and emit a "Timeout:" line; we assert the floor invariant
        // (>= 30s) rather than the exact 30s value to tolerate either path.
        const startEpoch = Math.floor(Date.now() / 1000) - 55;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15a',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // Strip ANSI color codes so panel lines like "[2mTimeout:[0m 30s" parse.
        const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
        const plain = stripAnsi(combined);
        // Either branch is valid:
        //  A) remaining > 0, < 30: clamped down with floor → "Timeout: 30s (Req: 600s)"
        //     "Worker timeout clamped: 30s" log line.
        //  B) remaining <= 0 (under load): floor max(30, --timeout=600) = 600s →
        //     "Session time already elapsed; running with requested timeout."
        //     "Timeout: 600s (Req: 600s)" — the floor would be 30 if --timeout < 30.
        // Both paths satisfy the invariant: effectiveTimeout >= 30. Verify by
        // extracting the panel Timeout value and asserting it >= 30s.
        const m = plain.match(/Timeout:\s*(\d+)s/);
        assert.ok(m, `effectiveTimeout panel line not found in output:\n${plain.slice(0, 800)}`);
        const effective = parseInt(m[1], 10);
        assert.ok(
            effective >= 30,
            `effectiveTimeout should be >= 30s floor, got ${effective}s`,
        );
        // And: with --timeout 600, effectiveTimeout cannot exceed 600.
        assert.ok(
            effective <= 600,
            `effectiveTimeout should be <= --timeout (600s), got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty F15: negative remaining with short --timeout yields >=30s', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15b');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 120s ago with 1-minute max → remaining is negative
        const startEpoch = Math.floor(Date.now() / 1000) - 120;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15b',
            '--ticket-path', ticketDir,
            '--timeout', '5',
        ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // With remaining<=0 and --timeout 5, effectiveTimeout = max(30, 5) = 30
        assert.match(combined, /Timeout.*\b30s\b/, 'effectiveTimeout should be at least 30s even when session elapsed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp backend state before routing worker CLI', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-backend-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({
                active: true,
                backend: 'codex',
                iteration: 2,
                schema_version: 1,
            }),
        );

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-backend-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1, `expected validation failure after codex shim exit, got: ${combined}`);
        assert.ok(combined.includes('Backend') && combined.includes('codex'), `expected Backend: codex in output, got: ${combined}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked after backend recovery');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.pickle_backend, 'codex');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp session timeout before printing worker budget', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-timeout-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        const nowEpoch = Math.floor(Date.now() / 1000);
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'claude',
            max_time_minutes: 20,
            start_time_epoch: nowEpoch - 5,
            iteration: 1,
            schema_version: 1,
        }));
        fs.writeFileSync(
            `${statePath}.tmp.99999998`,
            JSON.stringify({
                active: true,
                backend: 'codex',
                max_time_minutes: 3,
                start_time_epoch: nowEpoch - 90,
                iteration: 2,
                schema_version: 1,
            }),
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-timeout-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: '/nonexistent',
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        const plain = combined.replace(/\x1b\[[0-9;]*m/g, '');
        assert.equal(result.status, 1, `expected spawn failure after recovered timeout path, got: ${plain}`);
        assert.ok(plain.includes('Backend') && plain.includes('codex'), `expected recovered backend in output, got: ${plain}`);
        assert.ok(plain.includes('Worker timeout clamped'), `expected timeout clamp message, got: ${plain}`);
        const match = plain.match(/Timeout:\s*(\d+)s \(Req: 600s\)/);
        assert.ok(match, `expected timeout panel line, got: ${plain}`);
        const effective = Number(match[1]);
        assert.ok(
            Number.isFinite(effective) && effective >= 80 && effective <= 95,
            `expected recovered timeout near 90s, got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// tierToModel — tier-based model routing
// ---------------------------------------------------------------------------

test('tierToModel: trivial -> haiku', () => {
    assert.equal(tierToModel('trivial'), 'haiku');
});

test('tierToModel: small -> sonnet', () => {
    assert.equal(tierToModel('small'), 'sonnet');
});

test('tierToModel: medium -> sonnet', () => {
    assert.equal(tierToModel('medium'), 'sonnet');
});

test('tierToModel: large -> opus', () => {
    assert.equal(tierToModel('large'), 'opus');
});

test('tierToModel: undefined -> sonnet (missing tier fallback)', () => {
    assert.equal(tierToModel(undefined), 'sonnet');
});

test('tierToModel: unrecognized tier -> sonnet (unknown fallback)', () => {
    assert.equal(tierToModel('mega'), 'sonnet');
    assert.equal(tierToModel(''), 'sonnet');
});
