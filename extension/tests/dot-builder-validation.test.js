import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid spec — override fields to inject specific defects. */
function baseSpec(overrides = {}) {
    return {
        slug: 'val-test',
        goal: 'Validate structural rules',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

/** Minimal valid phase — override to inject defects. */
function phase(name, overrides = {}) {
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], ...overrides };
}

// ---------------------------------------------------------------------------
// 15 Structural Validation Rules (BDD Scenarios)
//
// Each test constructs a DotBuilder with a specific defect, calls .build(),
// and asserts BuildError with the correct code and diagnostic.
// ---------------------------------------------------------------------------

describe('Structural validation — 15 rules', () => {

    // Rule 1: single start/exit -----------------------------------------------
    test('Rule 1 INVALID_STRUCTURE — phase named "start" collides with reserved start node', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('start')],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError, 'must throw BuildError');
                assert.equal(err.code, 'INVALID_STRUCTURE');
                assert.ok(err.diagnostics.length > 0, 'must include diagnostics');
                assert.ok(
                    err.diagnostics.some(d => d.severity === 'error'),
                    'must have error-severity diagnostic',
                );
                return true;
            },
        );
    });

    // Rule 2: no incoming edges to start --------------------------------------
    test('Rule 2 START_HAS_INCOMING — retryTarget pointing to start creates incoming edge', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('fix', { retryTarget: 'start' })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'START_HAS_INCOMING');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'START_HAS_INCOMING' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 3: reachability ----------------------------------------------------
    test('Rule 3 UNREACHABLE_NODE — phase with unresolvable dependsOn creates orphan', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('alpha'),
                phase('beta', { dependsOn: ['nonexistent'] }),
            ],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'UNREACHABLE_NODE');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'UNREACHABLE_NODE' && d.severity === 'error' && d.nodeId,
                ));
                return true;
            },
        );
    });

    // Rule 4: diamond branching -----------------------------------------------
    test('Rule 4 DIAMOND_MISSING_EDGES — goalGate diamond without retryTarget has <2 outgoing edges', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('check', { goalGate: true })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'DIAMOND_MISSING_EDGES');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'DIAMOND_MISSING_EDGES' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 5: goal_gate → max_visits ------------------------------------------
    test('Rule 5 GOAL_GATE_NO_MAX_VISITS — goalGate node lacks max_visits constraint', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('gate', { goalGate: true, retryTarget: 'fix_gate' })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'GOAL_GATE_NO_MAX_VISITS');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'GOAL_GATE_NO_MAX_VISITS' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 6: AC mapping ------------------------------------------------------
    test('Rule 6 MISSING_AC_MAPPING — AC key with no contextOnSuccess source', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            acceptanceCriteria: { custom_metric: 'must reach 100%' },
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'MISSING_AC_MAPPING');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'MISSING_AC_MAPPING' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 7: timeout presence ------------------------------------------------
    test('Rule 7 MISSING_TIMEOUT — codergen impl node lacks timeout attribute', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'MISSING_TIMEOUT');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'MISSING_TIMEOUT' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 8: prompt ↔ allowed_paths ------------------------------------------
    test('Rule 8 PROMPT_PATH_MISMATCH — prompt references paths outside allowed_paths', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', {
                prompt: 'Edit src/auth/login.ts to add OAuth support',
                allowedPaths: ['docs/'],
            })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'PROMPT_PATH_MISMATCH');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'PROMPT_PATH_MISMATCH' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 9: read_only + STATUS on review nodes ------------------------------
    test('Rule 9 REVIEW_MISSING_READONLY — review node lacks read_only or STATUS marker', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('audit', { securityScan: true })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'REVIEW_MISSING_READONLY');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'REVIEW_MISSING_READONLY' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 10: component ↔ tripleoctagon merge --------------------------------
    test('Rule 10 COMPONENT_NO_MERGE — builder auto-emits tripleoctagon merge for fan-out', () => {
        // Two independent phases trigger fan-out (Pattern 4). The builder always
        // auto-emits a tripleoctagon merge_phases node, so Rule 10 finds both
        // component and tripleoctagon present — no warning needed. This test
        // verifies the auto-emission invariant rather than the warning path.
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('alpha'),
                phase('beta'),  // no dependsOn → independent → fan-out
            ],
        })).build();

        // DOT must contain the auto-emitted tripleoctagon merge node
        assert.match(result.dot, /merge_phases\s*\[.*shape="tripleoctagon"/, 'merge_phases must be tripleoctagon');

        // Rule 10 does NOT warn because builder guarantees the merge node exists
        const warn = result.diagnostics.find(d => d.rule === 'COMPONENT_NO_MERGE');
        assert.equal(warn, undefined, 'no COMPONENT_NO_MERGE warning when merge node is auto-emitted');
    });

    // Rule 11: fan_out_scope --------------------------------------------------
    test('Rule 11 FAN_OUT_SCOPE_LEAK — retryTarget escapes fan-out component scope', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('alpha', { retryTarget: 'impl_beta' }),
                phase('beta'),
            ],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'FAN_OUT_SCOPE_LEAK');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'FAN_OUT_SCOPE_LEAK' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 12: workspace_config — HTTPS required for isolated workspace -------
    test('Rule 12 WORKSPACE_NO_HTTPS — isolated workspace with SSH repoUrl', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            workspace: 'isolated',
            workspaceOpts: { repoUrl: 'git@github.com:org/repo.git' },
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'WORKSPACE_NO_HTTPS');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'WORKSPACE_NO_HTTPS' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 13: workspace_push — isolated workspace needs commit_and_push ------
    test('Rule 13 WORKSPACE_NO_PUSH — isolated workspace without commit_and_push node', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            workspace: 'isolated',
            workspaceOpts: { repoUrl: 'https://github.com/org/repo.git' },
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'WORKSPACE_NO_PUSH');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'WORKSPACE_NO_PUSH' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 14: permission_mode_plan -------------------------------------------
    test('Rule 14 PLAN_MODE_DEADLOCK — plan permission mode in headless pipeline', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', { specFirst: true, goalGate: true })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'PLAN_MODE_DEADLOCK');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'PLAN_MODE_DEADLOCK' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 15: allowed_paths_required -----------------------------------------
    test('Rule 15 MISSING_ALLOWED_PATHS — per-phase impl node with empty allowed_paths', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', { allowedPaths: [] })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'MISSING_ALLOWED_PATHS');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'MISSING_ALLOWED_PATHS' && d.severity === 'error',
                ));
                return true;
            },
        );
    });
});
