import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Adversarial audit — 16 attack vectors against DotBuilder
// Each must produce a structured BuildError (not a crash/TypeError/etc.)
// ---------------------------------------------------------------------------

/** Assert fn throws BuildError with optional code check. */
function assertBuildError(fn, expectedCode, label) {
    try {
        fn();
        assert.fail(`${label}: expected BuildError but no error thrown`);
    } catch (err) {
        assert.ok(
            err instanceof BuildError,
            `${label}: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
        );
        if (expectedCode) {
            assert.equal(err.code, expectedCode, `${label}: wrong error code`);
        }
    }
}

function phase(name, overrides = {}) {
    return { name, prompt: 'do the thing', allowedPaths: ['src/'], ...overrides };
}

function spec(overrides = {}) {
    return { slug: 'test', goal: 'test goal', phases: [phase('Alpha')], ...overrides };
}

describe('Adversarial audit', () => {
    // (1) Empty phases array — builder allows it (produces minimal graph)
    test('1: empty phases array', () => {
        const result = DotBuilder.fromSpec({ slug: 'x', goal: 'y', phases: [] }).build();
        assert.ok(result.dot, 'empty phases produces DOT output (minimal graph)');
        assert.equal(result.slug, 'x');
    });

    // (2) Unicode phase names — emoji, CJK, RTL
    test('2: emoji phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('🔥🚀')] })),
            'EMPTY_SLUG',
            'emoji phase name'
        );
    });

    test('2: CJK phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('数据处理')] })),
            'EMPTY_SLUG',
            'CJK phase name'
        );
    });

    test('2: RTL phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('مرحبا')] })),
            'EMPTY_SLUG',
            'RTL phase name'
        );
    });

    // (3) >100 phases stress test
    test('3: >100 phases stress test', () => {
        const phases = Array.from({ length: 101 }, (_, i) => phase(`Phase${i}`));
        try {
            const builder = DotBuilder.fromSpec(spec({ phases }));
            const result = builder.build();
            assert.ok(result.dot, 'stress test produced DOT output');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `stress test: expected BuildError or success, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (4) Slug with slashes/hashes/spaces
    test('4: slug with slashes/hashes/spaces', () => {
        try {
            const builder = DotBuilder.fromSpec(spec({ slug: 'foo/bar#baz qux' }));
            builder.build();
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `bad slug: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (5) Prompt containing quotes and newlines
    test('5: prompt with quotes and newlines', () => {
        const evil = 'do "this"\nand \'that\'\nwith\ttabs\\backslash';
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('Quoted', { prompt: evil })]
            }));
            const result = builder.build();
            assert.ok(result.dot.includes('quoted'), 'phase with special chars emitted');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `quote prompt: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (6) allowedPaths with absolute paths — add timeout to avoid MISSING_TIMEOUT firing first
    test('6: allowedPaths with absolute paths', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Abs', { allowedPaths: ['/etc/passwd'], timeout: '30m' })]
            })).build(),
            'INVALID_ALLOWED_PATHS',
            'absolute allowedPaths'
        );
    });

    // (7) timeout='30' (missing unit)
    test('7: timeout missing unit', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('NoUnit', { timeout: '30' })]
            })).build(),
            'INVALID_TIMEOUT',
            'timeout no unit'
        );
    });

    // (8) Two phases sanitizing to same ID
    test('8: duplicate sanitized ID', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Foo Bar'), phase('foo-bar')]
            })),
            'DUPLICATE_PHASE',
            'duplicate sanitized ID'
        );
    });

    // (9) timeout='0m'
    test('9: timeout zero minutes', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('ZeroT', { timeout: '0m' })]
            })).build(),
            'INVALID_TIMEOUT',
            'zero timeout'
        );
    });

    // (10) contextOnSuccess key not in acceptanceCriteria
    test('10: contextOnSuccess unmapped AC key', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Mapped', {
                    contextOnSuccess: { phantom_key: 'test' },
                    timeout: '30m',
                })],
                acceptanceCriteria: { real_key: 'must pass' },
            })).build(),
            'MISSING_AC_MAPPING',
            'unmapped AC key'
        );
    });

    // (11) Circular dependencies A→B→C→A
    test('11: circular dependencies', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [
                    phase('Alpha', { dependsOn: ['Gamma'], timeout: '30m' }),
                    phase('Beta', { dependsOn: ['Alpha'], timeout: '30m' }),
                    phase('Gamma', { dependsOn: ['Beta'], timeout: '30m' }),
                ]
            })).build(),
            'INVALID_STRUCTURE',
            'circular deps'
        );
    });

    // (12) DOT injection in prompt
    test('12: DOT injection in prompt', () => {
        const injection = '} ; digraph evil { attacker [label="pwned"]';
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('Inject', { prompt: injection })]
            }));
            const result = builder.build();
            assert.ok(
                !result.dot.includes('digraph evil'),
                'DOT injection must be escaped'
            );
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `DOT injection: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (13) Zero-width Unicode in phase names
    test('13: ZWSP-only phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('\u200B')] })),
            'EMPTY_SLUG',
            'ZWSP phase name'
        );
    });

    test('13: BOM-only phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('\uFEFF')] })),
            'EMPTY_SLUG',
            'BOM phase name'
        );
    });

    test('13: ZWSP mixed with ASCII', () => {
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('a\u200Bb')]
            }));
            const result = builder.build();
            assert.ok(result.dot, 'ZWSP mixed with ASCII produced output');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `ZWSP mixed: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (14) Path traversal in allowedPaths — add timeout to avoid MISSING_TIMEOUT firing first
    test('14: path traversal in allowedPaths', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Traversal', { allowedPaths: ['../../etc/passwd'], timeout: '30m' })]
            })).build(),
            'INVALID_ALLOWED_PATHS',
            'path traversal'
        );
    });

    // (15) Empty string phase name
    test('15: empty string phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('')] })),
            undefined,
            'empty phase name'
        );
    });

    // (16) dependsOn nonexistent phase
    test('16: dependsOn nonexistent phase', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Lonely', { dependsOn: ['ghost_phase'], timeout: '30m' })]
            })).build(),
            'UNREACHABLE_NODE',
            'nonexistent dependency'
        );
    });
});
