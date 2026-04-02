import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DotBuilder, BuildResult } from '../services/dot-builder.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'dot-builder-cli.js');

// ---------------------------------------------------------------------------
// Helper: minimal valid BuilderSpec
// ---------------------------------------------------------------------------

function validSpec() {
    return {
        slug: 'cli-test',
        goal: 'Validate CLI contract',
        phases: [{
            name: 'Implement',
            prompt: 'Do the thing in src/index.ts',
            allowedPaths: ['src/'],
            timeout: '30m',
        }],
        acceptanceCriteria: {},
    };
}

function runCli(input) {
    return new Promise((resolve) => {
        const child = execFile(
            process.execPath,
            [CLI_PATH],
            { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout, stderr) => {
                resolve({
                    code: err ? err.code : 0,
                    stdout,
                    stderr,
                });
            },
        );
        child.stdin.end(input);
    });
}

// ---------------------------------------------------------------------------
// CLI contract tests — RED phase
// ---------------------------------------------------------------------------

describe('dot-builder-cli', () => {
    test('(1) valid BuilderSpec JSON on stdin → exit 0, stdout is valid BuildResult JSON', async () => {
        const spec = validSpec();
        const result = await runCli(JSON.stringify(spec));

        assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);

        const parsed = JSON.parse(result.stdout);
        const vr = BuildResult.validate(parsed);
        assert.ok(vr.valid, `stdout should be valid BuildResult JSON: ${JSON.stringify(vr.diagnostics)}`);
        assert.equal(parsed.slug, spec.slug);
        assert.ok(parsed.dot.includes('digraph'));
    });

    test('(2) spec with missing AC mapping → exit 1, stderr has MISSING_AC_MAPPING', async () => {
        const spec = validSpec();
        spec.acceptanceCriteria = { unmapped_criterion: 'must pass' };

        const result = await runCli(JSON.stringify(spec));

        assert.equal(result.code, 1, `expected exit 1, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.ok(
            Array.isArray(errPayload.diagnostics),
            'stderr should contain diagnostics array',
        );
        assert.ok(
            errPayload.diagnostics.some(d => d.rule === 'MISSING_AC_MAPPING'),
            'diagnostics should include MISSING_AC_MAPPING',
        );
    });

    test('(3) invalid JSON on stdin → exit 2, stderr has UNEXPECTED_ERROR', async () => {
        const result = await runCli('this is not json{{{');

        assert.equal(result.code, 2, `expected exit 2, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.equal(errPayload.error, 'UNEXPECTED_ERROR');
    });

    test('(4) input >512KB → exit 2, stderr has INPUT_TOO_LARGE', async () => {
        const bigInput = 'x'.repeat(513 * 1024);

        const result = await runCli(bigInput);

        assert.equal(result.code, 2, `expected exit 2, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.equal(errPayload.error, 'INPUT_TOO_LARGE');
    });
});

// ---------------------------------------------------------------------------
// DotBuilder.fromSpec() contract tests — RED phase
// ---------------------------------------------------------------------------

describe('DotBuilder.fromSpec()', () => {
    test('(5) missing slug → throws BuildError with EMPTY_SLUG code', () => {
        const spec = validSpec();
        delete spec.slug;

        assert.throws(
            () => DotBuilder.fromSpec(spec),
            (err) => err.name === 'BuildError' && err.code === 'EMPTY_SLUG',
            'should throw BuildError with EMPTY_SLUG',
        );
    });

    test('(6) fromSpec().build() and constructor+phase().build() produce identical DOT', () => {
        const spec = validSpec();
        const phase = spec.phases[0];

        // Path A: fromSpec
        const resultA = DotBuilder.fromSpec(spec).build();

        // Path B: constructor + manual phase()
        const builder = new DotBuilder({ ...spec, phases: [] });
        builder.phase(phase);
        const resultB = builder.build();

        assert.equal(
            resultA.dot,
            resultB.dot,
            'fromSpec and constructor+phase must produce identical DOT output',
        );
    });

    test('(6b) phase with missing name field → throws BuildError with INVALID_SPEC code', () => {
        const spec = validSpec();
        // Simulate JSON deserialization with wrong field name (e.g. "id" instead of "name")
        spec.phases = [{ id: 'impl', prompt: 'do stuff', allowedPaths: ['src/'], timeout: '30m' }];

        assert.throws(
            () => DotBuilder.fromSpec(spec),
            (err) => err.name === 'BuildError' && err.code === 'INVALID_SPEC',
            'phase missing string "name" field must throw BuildError with INVALID_SPEC',
        );
    });

    test('(7) fromSpec().build() is deterministic — two invocations produce byte-identical DOT', () => {
        const spec = validSpec();

        const resultA = DotBuilder.fromSpec(spec).build();
        const resultB = DotBuilder.fromSpec(spec).build();

        assert.equal(
            resultA.dot,
            resultB.dot,
            'two separate fromSpec().build() calls must produce byte-identical DOT',
        );
    });
});
