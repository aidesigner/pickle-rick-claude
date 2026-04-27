import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGateMain } from '../../bin/check-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeResult(overrides = {}) {
    return {
        status: 'green',
        failures: [],
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 12,
        total_raw_failure_count: 0,
        new_failures_vs_baseline: 0,
        ...overrides,
    };
}

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-gate-test-')));
}

const BASE_ARGV = ['--mode', 'strict', '--scope', 'full', '--checks', 'typecheck,lint', '--working-dir', '/tmp'];

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('exit codes', () => {
    test('green → 0', async () => {
        const code = await checkGateMain({
            argv: BASE_ARGV,
            runGateFn: async () => makeResult({ status: 'green' }),
            stdout: () => {},
            stderr: () => {},
        });
        assert.equal(code, 0);
    });

    test('red → 2', async () => {
        const code = await checkGateMain({
            argv: BASE_ARGV,
            runGateFn: async () => makeResult({
                status: 'red',
                failures: [{ check: 'lint', file: 'src/foo.ts', line: 1, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0 }],
                total_raw_failure_count: 1,
            }),
            stdout: () => {},
            stderr: () => {},
        });
        assert.equal(code, 2);
    });

    test('green-with-known-flake-warnings → 3', async () => {
        const code = await checkGateMain({
            argv: BASE_ARGV,
            runGateFn: async () => makeResult({ status: 'green-with-known-flake-warnings' }),
            stdout: () => {},
            stderr: () => {},
        });
        assert.equal(code, 3);
    });

    test('runGateFn throws → 1', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: BASE_ARGV,
            runGateFn: async () => { throw new Error('boom'); },
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('boom')));
    });
});

// ---------------------------------------------------------------------------
// --json output
// ---------------------------------------------------------------------------

describe('--json output', () => {
    test('emits valid GateResult JSON to stdout', async () => {
        const result = makeResult({ status: 'green', elapsed_ms: 42 });
        const stdoutLines = [];
        const code = await checkGateMain({
            argv: [...BASE_ARGV, '--json'],
            runGateFn: async () => result,
            stdout: (msg) => stdoutLines.push(msg),
            stderr: () => {},
        });
        assert.equal(code, 0);
        assert.equal(stdoutLines.length, 1);
        const parsed = JSON.parse(stdoutLines[0]);
        assert.equal(parsed.status, 'green');
        assert.equal(parsed.elapsed_ms, 42);
        assert.ok(Array.isArray(parsed.failures));
        assert.equal(typeof parsed.baseline_used, 'boolean');
        assert.equal(typeof parsed.allowed_paths_used, 'boolean');
        assert.equal(typeof parsed.total_raw_failure_count, 'number');
        assert.equal(typeof parsed.new_failures_vs_baseline, 'number');
    });

    test('errors go to stderr only (no stdout pollution)', async () => {
        const stdoutLines = [];
        const stderrLines = [];
        const code = await checkGateMain({
            argv: [...BASE_ARGV, '--json'],
            runGateFn: async () => { throw new Error('gate exploded'); },
            stdout: (msg) => stdoutLines.push(msg),
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.equal(stdoutLines.length, 0);
        assert.ok(stderrLines.some(l => l.includes('gate exploded')));
    });
});

// ---------------------------------------------------------------------------
// --allowed-paths-file
// ---------------------------------------------------------------------------

describe('--allowed-paths-file', () => {
    test('reads allowed_paths from scope.json fixture', async () => {
        const tmpDir = makeTmpDir();
        try {
            const scopePath = path.join(tmpDir, 'scope.json');
            fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['src/**', 'tests/**'] }));

            let capturedOpts;
            const code = await checkGateMain({
                argv: [...BASE_ARGV, '--allowed-paths-file', scopePath],
                runGateFn: async (opts) => { capturedOpts = opts; return makeResult(); },
                stdout: () => {},
                stderr: () => {},
            });
            assert.equal(code, 0);
            assert.deepEqual(capturedOpts.allowedPaths, ['src/**', 'tests/**']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('exits 1 when file is missing', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: [...BASE_ARGV, '--allowed-paths-file', '/nonexistent/scope.json'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('--allowed-paths-file')));
    });

    test('exits 1 when allowed_paths is not an array', async () => {
        const tmpDir = makeTmpDir();
        try {
            const scopePath = path.join(tmpDir, 'scope.json');
            fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: 'not-an-array' }));
            const stderrLines = [];
            const code = await checkGateMain({
                argv: [...BASE_ARGV, '--allowed-paths-file', scopePath],
                runGateFn: async () => makeResult(),
                stdout: () => {},
                stderr: (msg) => stderrLines.push(msg),
            });
            assert.equal(code, 1);
            assert.ok(stderrLines.some(l => l.includes("'allowed_paths'")));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

describe('flag parsing', () => {
    test('unknown flag exits 1 with usage to stderr', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: [...BASE_ARGV, '--unknown-flag', 'x'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('Unknown flag')));
        assert.ok(stderrLines.some(l => l.includes('Usage:')));
    });

    test('missing --working-dir exits 1', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: ['--mode', 'strict', '--scope', 'full', '--checks', 'typecheck'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('--working-dir')));
    });

    test('missing --mode exits 1', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: ['--scope', 'full', '--checks', 'typecheck', '--working-dir', '/tmp'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('--mode')));
    });

    test('invalid --mode value exits 1', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: ['--mode', 'bogus', '--scope', 'full', '--checks', 'typecheck', '--working-dir', '/tmp'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('baseline|strict')));
    });

    test('invalid check name exits 1', async () => {
        const stderrLines = [];
        const code = await checkGateMain({
            argv: ['--mode', 'strict', '--scope', 'full', '--checks', 'typecheck,badcheck', '--working-dir', '/tmp'],
            runGateFn: async () => makeResult(),
            stdout: () => {},
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 1);
        assert.ok(stderrLines.some(l => l.includes('badcheck')));
    });

    test('--json with red result: stdout is valid JSON, stderr is empty', async () => {
        const stdoutLines = [];
        const stderrLines = [];
        const code = await checkGateMain({
            argv: [...BASE_ARGV, '--json'],
            runGateFn: async () => makeResult({ status: 'red', total_raw_failure_count: 1 }),
            stdout: (msg) => stdoutLines.push(msg),
            stderr: (msg) => stderrLines.push(msg),
        });
        assert.equal(code, 2);
        assert.equal(stderrLines.length, 0);
        const parsed = JSON.parse(stdoutLines[0]);
        assert.equal(parsed.status, 'red');
    });
});
