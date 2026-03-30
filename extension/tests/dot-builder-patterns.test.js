import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid spec — override fields to trigger specific patterns. */
function baseSpec(overrides = {}) {
    return {
        slug: 'pattern-test',
        goal: 'Test auto-pattern emission',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

/** Minimal valid phase — override to set pattern preconditions. */
function phase(name, overrides = {}) {
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

// ---------------------------------------------------------------------------
// Auto-pattern snapshot tests — 28 auto-applied patterns from BDD scenarios
//
// Each test builds a pipeline whose spec meets the preconditions for a single
// auto pattern, calls .build(), and asserts the pattern-specific DOT
// attributes / nodes / edges exist in the output.
// ---------------------------------------------------------------------------

describe('Auto-pattern snapshot tests — 28 BDD scenarios', () => {

    // Pattern 0a: Dependency Setup -----------------------------------------------
    test('P0a — setup_deps node with install command always emitted', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('coding')],
        })).build();

        assert.ok(result.dot.includes('setup_deps'), 'setup_deps node must exist');
        assert.match(result.dot, /npm install.*pnpm install.*yarn install/, 'setup_deps must have fallback install chain');
        assert.ok(result.patternsApplied.includes('P0a'), 'patternsApplied must include P0a');
    });

    // Pattern 0b: Parallel Limit ------------------------------------------------
    test('P0b — fan-out nodes get max_parallel=1 on split_phases', () => {
        // 2 independent phases (no dependsOn) → fan-out active → P0b fires
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('implement auth'),
                phase('implement api'),
            ],
        })).build();

        assert.match(result.dot, /split_phases/, 'must have split_phases node');
        assert.match(result.dot, /max_parallel="1"/, 'split_phases must have max_parallel=1');
        assert.ok(result.patternsApplied.includes('P0b'), 'patternsApplied must include P0b');
    });

    // Pattern 0c: Baseline Snapshot ---------------------------------------------
    test('P0c — capture_baseline node snapshots lint and typecheck counts', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('coding')],
        })).build();

        assert.ok(result.dot.includes('capture_baseline'), 'capture_baseline must exist');
        assert.match(result.dot, /baseline_ts_errors/, 'capture_baseline must snapshot TS error count');
        assert.match(result.dot, /baseline_lint_errors/, 'capture_baseline must snapshot lint error count');
        assert.ok(result.patternsApplied.includes('P0c'), 'patternsApplied must include P0c');
    });

    // Pattern 0d: Delta-Aware Verify --------------------------------------------
    test('P0d — verify nodes compare against baseline for regression detection', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        // verify_lint and verify_types must reference the baseline
        assert.match(result.dot, /verify_lint/, 'must have verify_lint node');
        assert.match(result.dot, /verify_types/, 'must have verify_types node');
        assert.match(result.dot, /BASELINE.*cat.*baseline/, 'verify commands must prepend BASELINE comparison');
        assert.match(result.dot, /CURRENT.*-le.*BASELINE/, 'verify commands must assert CURRENT <= BASELINE');
        assert.ok(result.patternsApplied.includes('P0d'), 'patternsApplied must include P0d');
    });

    // Pattern 0e: Progress Gate -------------------------------------------------
    test('P0e — check_progress node after impl with read_only and max_visits=3', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement auth')],
        })).build();

        assert.match(result.dot, /check_progress/, 'must have check_progress node');
        assert.match(result.dot, /check_progress\s*\[.*read_only="true"/, 'check_progress must be read_only');
        assert.match(result.dot, /check_progress\s*\[.*max_visits="3"/, 'check_progress must have max_visits=3');
        assert.match(result.dot, /git status --porcelain/, 'check_progress must use git status to detect changes');
        assert.ok(result.patternsApplied.includes('P0e'), 'patternsApplied must include P0e');
    });

    // Pattern 1: Test-Fix Loops -------------------------------------------------
    test('P1 — diamond test gate with success/fail edges and fix loop', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement service')],
        })).build();

        // test node must be diamond with 2 outgoing edges
        assert.match(result.dot, /test_implement_service\s*\[.*shape="diamond"/, 'test node must be diamond');
        // Success edge → next step, fail edge → fix node
        assert.match(result.dot, /fix_implement_service/, 'must have fix node for retry');
        // fix loops back to impl
        assert.match(result.dot, /fix_implement_service\s*->\s*impl_implement_service/, 'fix must loop back to impl');
        assert.ok(result.patternsApplied.includes('P1'), 'patternsApplied must include P1');
    });

    // Pattern 3: Conditional Routing (validation) -------------------------------
    test('P3 — diamond nodes validated to have ≥2 outgoing edges', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        // All diamond nodes must have ≥2 outgoing edges (validation, not patternsApplied)
        assert.match(result.dot, /shape="diamond"/, 'must have diamond decision node');
        // Extract diamond node names and count their outgoing edges
        const diamonds = [...result.dot.matchAll(/(\w+)\s*\[.*shape="diamond"/g)].map(m => m[1]);
        for (const d of diamonds) {
            const outEdges = result.dot.match(new RegExp(`${d}\\s*->`, 'g')) || [];
            assert.ok(outEdges.length >= 2, `diamond ${d} must have ≥2 outgoing edges, got ${outEdges.length}`);
        }
    });

    // Pattern 4: Fan-Out/Fan-In -------------------------------------------------
    test('P4 — 2 independent phases emit split/merge fan-out topology', () => {
        // 2-phase spec with NO dependsOn → independent → fan-out
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('implement auth'),
                phase('implement api'),
            ],
        })).build();

        assert.match(result.dot, /split_phases\s*\[.*shape="component"/, 'split_phases must be component shape');
        assert.match(result.dot, /merge_phases\s*\[.*shape="tripleoctagon"/, 'merge_phases must be tripleoctagon');
        assert.ok(result.patternsApplied.includes('P4'), 'patternsApplied must include P4');
    });

    // Pattern 6: Max Visits -----------------------------------------------------
    test('P6 — retry-target nodes get max_visits=5 default', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        // Nodes with incoming retry edges (from diamond fail paths) must get max_visits
        assert.match(result.dot, /max_visits="5"/, 'retry-target nodes must have max_visits=5 default');
        assert.ok(result.patternsApplied.includes('P6'), 'patternsApplied must include P6');
    });

    // Pattern 6b: Read-Only + STATUS --------------------------------------------
    test('P6b — review-class nodes get read_only=true and STATUS prompt suffix', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        // Review nodes (scope_check, conformance) must have read_only and STATUS markers
        const reviewNodes = [...result.dot.matchAll(/(\w+)\s*\[.*class="review"/g)].map(m => m[1]);
        assert.ok(reviewNodes.length > 0, 'must have at least one review-class node');
        for (const node of reviewNodes) {
            const nodeBlock = result.dot.match(new RegExp(`${node}\\s*\\[([^\\]]+)\\]`));
            assert.ok(nodeBlock, `${node} must have attributes`);
            assert.ok(nodeBlock[1].includes('read_only="true"'), `${node} must have read_only=true`);
        }
        assert.match(result.dot, /STATUS: SUCCESS.*STATUS: FAIL|STATUS: FAIL.*STATUS: SUCCESS/, 'review prompts must include STATUS markers');
        assert.ok(result.patternsApplied.includes('P6b'), 'patternsApplied must include P6b');
    });

    // Pattern 10: Scope Creep ---------------------------------------------------
    test('P10 — scope_check review node after impl verifies in-scope changes', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        assert.match(result.dot, /scope_check/, 'must have scope_check node');
        assert.match(result.dot, /scope_check\s*\[.*class="review"/, 'scope_check must be class=review');
        assert.match(result.dot, /scope_check\s*\[.*read_only="true"/, 'scope_check must be read_only');
        assert.match(result.dot, /git diff.*allowed_paths|allowed_paths.*git diff/, 'scope_check prompt must reference git diff and allowed_paths');
        assert.ok(result.patternsApplied.includes('P10'), 'patternsApplied must include P10');
    });

    // Pattern 13: Lint Gate -----------------------------------------------------
    test('P13 — verify_lint node in verify chain after check_progress', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        assert.match(result.dot, /verify_lint/, 'must have verify_lint node');
        // verify_lint must come after check_progress in edge chain
        const cpIdx = result.dot.indexOf('check_progress');
        const lintIdx = result.dot.indexOf('verify_lint');
        assert.ok(cpIdx > -1 && lintIdx > -1, 'both check_progress and verify_lint must exist');
        assert.ok(cpIdx < lintIdx, 'check_progress must precede verify_lint');
        assert.ok(result.patternsApplied.includes('P13'), 'patternsApplied must include P13');
    });

    // Pattern 14: Type-Check Gate -----------------------------------------------
    test('P14 — verify_types node in verify chain after verify_lint', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        assert.match(result.dot, /verify_types/, 'must have verify_types node');
        // verify_types must come after verify_lint
        const lintIdx = result.dot.indexOf('verify_lint');
        const typesIdx = result.dot.indexOf('verify_types');
        assert.ok(lintIdx > -1 && typesIdx > -1, 'both verify_lint and verify_types must exist');
        assert.ok(lintIdx < typesIdx, 'verify_lint must precede verify_types');
        assert.ok(result.patternsApplied.includes('P14'), 'patternsApplied must include P14');
    });

    // Pattern 15: Conformance Audit ---------------------------------------------
    test('P15 — conformance review node after scope_check with timeout', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        assert.match(result.dot, /conformance/, 'must have conformance node');
        assert.match(result.dot, /conformance\s*\[.*class="review"/, 'conformance must be class=review');
        assert.match(result.dot, /conformance\s*\[.*read_only="true"/, 'conformance must be read_only');
        assert.match(result.dot, /conformance\s*\[.*timeout="15m"/, 'conformance must have timeout=15m');
        // conformance must come after scope_check
        const scIdx = result.dot.indexOf('scope_check');
        const confIdx = result.dot.indexOf('conformance');
        assert.ok(scIdx < confIdx, 'scope_check must precede conformance');
        assert.ok(result.patternsApplied.includes('P15'), 'patternsApplied must include P15');
    });

    // Pattern 21: Fix All -------------------------------------------------------
    test('P21 — fix_all node before verify_final with cross-phase paths', () => {
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('implement auth', { allowedPaths: ['src/auth/'] }),
                phase('implement api', { allowedPaths: ['src/api/'], dependsOn: ['implement auth'] }),
            ],
        })).build();

        assert.match(result.dot, /fix_all/, 'must have fix_all node');
        assert.match(result.dot, /fix_all\s*\[.*class="codergen"/, 'fix_all must be class=codergen');
        assert.match(result.dot, /fix_all\s*\[.*timeout="30m"/, 'fix_all must have timeout=30m');
        assert.match(result.dot, /fix_all\s*\[.*permission_mode="auto"/, 'fix_all must have permission_mode=auto');
        // fix_all allowed_paths = union of all phase paths
        assert.match(result.dot, /fix_all\s*\[.*allowed_paths="src\/auth\/,src\/api\/"/, 'fix_all must have union of allowed_paths');
        // fix_all must precede verify_final
        const fixIdx = result.dot.indexOf('fix_all');
        const verifyIdx = result.dot.indexOf('verify_final');
        assert.ok(fixIdx < verifyIdx, 'fix_all must precede verify_final');
        assert.ok(result.patternsApplied.includes('P21'), 'patternsApplied must include P21');
    });

    // Pattern 22: Permission Scoping --------------------------------------------
    test('P22 — codergen nodes get allowed_paths, escalate_on, permission_mode=auto', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature', { allowedPaths: ['src/', 'lib/'], escalateOn: ['package.json', '*.lock'] })],
        })).build();

        // Per-phase codergen impl node gets phase-specific paths
        assert.match(result.dot, /impl_implement_feature\s*\[.*allowed_paths/, 'impl node must have allowed_paths');
        assert.match(result.dot, /impl_implement_feature\s*\[.*permission_mode="auto"/, 'impl node must have permission_mode=auto');
        assert.match(result.dot, /impl_implement_feature\s*\[.*escalate_on/, 'impl node must have escalate_on');
        assert.ok(result.patternsApplied.includes('P22'), 'patternsApplied must include P22');
    });

    // Pattern 23: Defense Matrix ------------------------------------------------
    test('P23 — DEFENSE MATRIX comment block with competitive, guardrails, specDriven, permissions, adversarial', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        assert.match(result.dot, /\/\* DEFENSE MATRIX/, 'must have DEFENSE MATRIX comment block');
        assert.match(result.dot, /competitive:\s*(true|false)/, 'DEFENSE MATRIX must include competitive');
        assert.match(result.dot, /guardrails:/, 'DEFENSE MATRIX must include guardrails');
        assert.match(result.dot, /specDriven:/, 'DEFENSE MATRIX must include specDriven');
        assert.match(result.dot, /permissions:/, 'DEFENSE MATRIX must include permissions');
        assert.match(result.dot, /adversarial:\s*(true|false)/, 'DEFENSE MATRIX must include adversarial');
        assert.ok(result.patternsApplied.includes('P23'), 'patternsApplied must include P23');
    });

    // Pattern 25: Catastrophic Recovery -----------------------------------------
    test('P25 — verify_final -> setup_deps loop_restart edge for retry cascades', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        })).build();

        // Non-zero-phase pipeline with retry loops → catastrophic recovery edge
        assert.match(result.dot, /verify_final\s*->\s*setup_deps\s*\[.*loop_restart="true"/, 'must have loop_restart edge from verify_final to setup_deps');
        assert.ok(result.patternsApplied.includes('P25'), 'patternsApplied must include P25');
    });

    // Pattern 0: Workspace Isolation + commit_and_push --------------------------
    test('P0 — workspace=isolated decorates graph + commit_and_push node', () => {
        const result = new DotBuilder(baseSpec({
            workspace: 'isolated',
            workspaceOpts: { repoUrl: 'https://github.com/org/repo.git', cleanup: 'delete' },
            phases: [
                phase('implement feature'),
                phase('commit and push', { allowedPaths: ['src/'] }),
            ],
        })).build();

        assert.match(result.dot, /workspace="isolated"/, 'graph must have workspace=isolated attr');
        assert.match(result.dot, /impl_commit_and_push/, 'must have commit_and_push impl node');
        assert.match(result.dot, /repo_url="https:\/\/github\.com\/org\/repo\.git"/, 'commit_and_push must have repo_url');
        assert.match(result.dot, /cleanup="delete"/, 'commit_and_push must have cleanup attr');
        assert.ok(result.patternsApplied.includes('P0'), 'patternsApplied must include P0');
    });

    // Pattern 2: Goal Gates with retry_target + max_visits ----------------------
    test('P2 — goalGate phase emits goal_gate=true on conformance with max_visits', () => {
        const result = new DotBuilder(baseSpec({
            defaultMaxRetry: 3,
            phases: [
                phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' }),
            ],
        })).build();

        assert.match(result.dot, /conformance\s*\[.*goal_gate="true"/, 'conformance must have goal_gate=true');
        assert.match(result.dot, /conformance\s*\[.*max_visits="3"/, 'conformance must have max_visits from defaultMaxRetry');
        assert.ok(result.patternsApplied.includes('P2'), 'patternsApplied must include P2');
    });

    // Pattern 8: Security Scan after check_progress -----------------------------
    test('P8 — securityScan phase emits review node after preceding check_progress', () => {
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('implement feature'),
                phase('security audit', { securityScan: true, prompt: 'Scan for OWASP Top 10. STATUS: SUCCESS | FAIL' }),
            ],
        })).build();

        assert.match(result.dot, /security_audit\s*\[.*class="review"/, 'security scan must be class=review');
        assert.match(result.dot, /security_audit\s*\[.*read_only="true"/, 'security scan must be read_only');
        // security scan must appear after check_progress in DOT output
        const cpIdx = result.dot.indexOf('check_progress');
        const ssIdx = result.dot.indexOf('security_audit');
        assert.ok(cpIdx > -1 && ssIdx > -1, 'both check_progress and security_audit must exist');
        assert.ok(cpIdx < ssIdx, 'security_audit must appear after check_progress');
        assert.ok(result.patternsApplied.includes('P8'), 'patternsApplied must include P8');
    });

    // Pattern 9: Coverage Gate after test success -------------------------------
    test('P9 — coverageTarget emits test_run → coverage_gate diamond between verify_types and conformance', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature', { coverageTarget: 80 })],
        })).build();

        assert.match(result.dot, /test_run\s*\[/, 'must have test_run node');
        assert.match(result.dot, /coverage_gate\s*\[.*shape="diamond"/, 'coverage_gate must be diamond');
        assert.match(result.dot, /coverage_gate\s*\[.*coverage_target="80"/, 'coverage_gate must have coverage_target=80');
        // verify_types → test_run → coverage_gate → conformance
        const vtIdx = result.dot.indexOf('verify_types');
        const trIdx = result.dot.indexOf('test_run');
        const cgIdx = result.dot.indexOf('coverage_gate');
        const confIdx = result.dot.indexOf('conformance');
        assert.ok(vtIdx < trIdx, 'test_run must come after verify_types');
        assert.ok(trIdx < cgIdx, 'coverage_gate must come after test_run');
        assert.ok(cgIdx < confIdx, 'conformance must come after coverage_gate');
        assert.ok(result.patternsApplied.includes('P9'), 'patternsApplied must include P9');
    });

    // Pattern 16: Spec-First default-on for goalGate + opt-out via specFirst:false
    test('P16 — goalGate phase defaults to spec-first; specFirst:false opts out', () => {
        // goalGate WITHOUT specFirst:false → spec_tests node emitted
        const withSpec = new DotBuilder(baseSpec({
            defaultMaxRetry: 3,
            phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' })],
        })).build();

        assert.match(withSpec.dot, /spec_tests\s*\[/, 'goalGate phase must emit spec_tests by default');
        assert.ok(withSpec.patternsApplied.includes('P16'), 'patternsApplied must include P16');

        // goalGate WITH specFirst:false → NO spec_tests node
        const withoutSpec = new DotBuilder(baseSpec({
            defaultMaxRetry: 3,
            phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api', specFirst: false })],
        })).build();

        assert.ok(!withoutSpec.dot.includes('spec_tests'), 'specFirst:false must suppress spec_tests node');
        assert.ok(!withoutSpec.patternsApplied.includes('P16'), 'patternsApplied must NOT include P16 when opted out');
    });

    // Pattern 16b: BDD Scenarios opt-in only when bddScenarios:true -------------
    test('P16b — bdd_scenarios node only when bddScenarios:true, never by default', () => {
        // Without bddScenarios → no bdd_scenarios node
        const noBDD = new DotBuilder(baseSpec({
            defaultMaxRetry: 3,
            phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' })],
        })).build();

        assert.ok(!noBDD.dot.includes('bdd_scenarios'), 'bdd_scenarios must NOT appear without bddScenarios:true');

        // With bddScenarios:true → bdd_scenarios node before spec_tests
        const withBDD = new DotBuilder(baseSpec({
            defaultMaxRetry: 3,
            phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api', bddScenarios: true })],
        })).build();

        assert.match(withBDD.dot, /bdd_scenarios\s*\[/, 'must have bdd_scenarios node');
        // bdd_scenarios must precede spec_tests
        const bddIdx = withBDD.dot.indexOf('bdd_scenarios');
        const specIdx = withBDD.dot.indexOf('spec_tests');
        assert.ok(bddIdx < specIdx, 'bdd_scenarios must precede spec_tests');
        assert.ok(withBDD.patternsApplied.includes('P16b'), 'patternsApplied must include P16b');
    });

    // Pattern 17: Red Team after conformance ------------------------------------
    test('P17 — redTeam:true emits red_team node linked from test pass edge', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature', { redTeam: true })],
        })).build();

        assert.match(result.dot, /red_team\s*\[.*read_only="true"/, 'red_team must be read_only');
        // test pass → red_team (not directly to next phase)
        assert.match(result.dot, /test_implement_feature\s*->\s*red_team\s*\[.*label="pass"/, 'test pass edge must go to red_team');
        assert.ok(result.patternsApplied.includes('P17'), 'patternsApplied must include P17');
    });

    // Pattern 18: Competing Implementations component+tripleoctagon -------------
    test('P18 — competing:true emits A/B component nodes + tripleoctagon merge', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement parser', { competing: true })],
        })).build();

        assert.match(result.dot, /implement_parser_a\s*\[.*shape="component"/, 'must have _a component');
        assert.match(result.dot, /implement_parser_b\s*\[.*shape="component"/, 'must have _b component');
        assert.match(result.dot, /competing_merge\s*\[.*shape="tripleoctagon"/, 'must have competing_merge tripleoctagon');
        // Both A and B link to merge
        assert.match(result.dot, /implement_parser_a\s*->\s*competing_merge/, 'A must link to merge');
        assert.match(result.dot, /implement_parser_b\s*->\s*competing_merge/, 'B must link to merge');
        assert.ok(result.patternsApplied.includes('P18'), 'patternsApplied must include P18');
    });

    // Pattern 19: Review Ratchet N-pass topology --------------------------------
    test('P19 — reviewRatchet(3) emits 3 review_pass nodes + tripleoctagon merge + fix_review loop', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
            reviewRatchet: 3,
        })).build();

        assert.match(result.dot, /review_pass_1\s*\[.*shape="component"/, 'must have review_pass_1');
        assert.match(result.dot, /review_pass_2\s*\[.*shape="component"/, 'must have review_pass_2');
        assert.match(result.dot, /review_pass_3\s*\[.*shape="component"/, 'must have review_pass_3');
        assert.match(result.dot, /review_merge\s*\[.*shape="tripleoctagon"/, 'must have review_merge tripleoctagon');
        assert.match(result.dot, /review_merge\s*\[.*ratchet_count="3"/, 'review_merge must have ratchet_count=3');
        // Chain: pass_1 → pass_2 → pass_3 → merge
        assert.match(result.dot, /review_pass_1\s*->\s*review_pass_2/, 'pass_1 must chain to pass_2');
        assert.match(result.dot, /review_pass_2\s*->\s*review_pass_3/, 'pass_2 must chain to pass_3');
        assert.match(result.dot, /review_pass_3\s*->\s*review_merge/, 'pass_3 must chain to merge');
        // fix_review loop
        assert.match(result.dot, /fix_review\s*\[/, 'must have fix_review node');
        assert.match(result.dot, /review_merge\s*->\s*fix_review\s*\[.*label="fail"/, 'merge fail → fix_review');
        assert.match(result.dot, /fix_review\s*->\s*review_pass_1/, 'fix_review loops back to pass_1');
        assert.ok(result.patternsApplied.includes('P19'), 'patternsApplied must include P19');
    });

    // Pattern 20: Microverse optimize-measure-compare-check loop ----------------
    test('P20 — microverse emits optimize→measure→compare→check diamond loop', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        }))
            .microverse('bundle_size', {
                prompt: 'Reduce bundle size',
                measureCommand: 'du -sb dist/ | cut -f1',
                target: 500000,
                direction: 'reduce',
                allowedPaths: ['src/'],
                maxVisits: 8,
            })
            .build();

        assert.match(result.dot, /commit_baseline\s*\[.*shape="cds"/, 'must have commit_baseline');
        assert.match(result.dot, /baseline\s*\[.*label="baseline bundle_size"/, 'must have baseline node');
        assert.match(result.dot, /optimize\s*\[.*label="optimize bundle_size"/, 'must have optimize node');
        assert.match(result.dot, /measure\s*\[.*label="measure bundle_size"/, 'must have measure node');
        assert.match(result.dot, /compare\s*\[.*shape="diamond"/, 'compare must be diamond');
        assert.match(result.dot, /compare\s*\[.*target="500000"/, 'compare must have target');
        assert.match(result.dot, /compare\s*\[.*direction="reduce"/, 'compare must have direction');
        assert.match(result.dot, /compare\s*\[.*max_visits="8"/, 'compare must have max_visits=8');
        assert.match(result.dot, /check\s*\[.*shape="diamond"/, 'check must be diamond');
        // Loop edges
        assert.match(result.dot, /compare\s*->\s*optimize\s*\[.*label="miss"/, 'compare miss → optimize');
        assert.match(result.dot, /compare\s*->\s*check\s*\[.*label="hit"/, 'compare hit → check');
        assert.match(result.dot, /check\s*->\s*done\s*\[.*label="accept"/, 'check accept → done');
        assert.match(result.dot, /check\s*->\s*optimize\s*\[.*label="reject"/, 'check reject → optimize');
        assert.ok(result.patternsApplied.includes('P20'), 'patternsApplied must include P20');
    });

    // Extra: specFirst:true on non-goal-gated phase enables spec_tests ----------
    test('specFirst:true on non-goalGate phase still emits spec_tests node', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature', { specFirst: true })],
        })).build();

        assert.match(result.dot, /spec_tests\s*\[/, 'specFirst:true must emit spec_tests even without goalGate');
        assert.ok(result.patternsApplied.includes('P16'), 'patternsApplied must include P16');
    });

    // Extra: modelStylesheet generates valid CSS-like stylesheet -----------------
    test('.modelStylesheet() generates valid selector { property: value; } output', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('implement feature')],
        }))
            .modelStylesheet({
                defaultModel: 'claude-sonnet-4-6',
                defaultEffort: 'high',
                overrides: [
                    { selector: 'critical', model: 'claude-opus-4-6', effort: 'max' },
                    { selector: '.review', model: 'claude-sonnet-4-6' },
                ],
            })
            .build();

        // Stylesheet must appear in graph attributes
        assert.match(result.dot, /stylesheet="/, 'must have stylesheet graph attr');

        // Extract stylesheet value
        const ssMatch = result.dot.match(/stylesheet="([^"]+)"/);
        assert.ok(ssMatch, 'stylesheet attr must have a value');
        const ss = ssMatch[1];

        // Universal selector: * { llm_model: ...; reasoning_effort: ...; }
        assert.match(ss, /\* \{ llm_model: claude-sonnet-4-6; reasoning_effort: high; \}/, 'must have * universal selector with llm_model and reasoning_effort');

        // Class selectors: .critical and .review
        assert.match(ss, /\.critical \{ llm_model: claude-opus-4-6; reasoning_effort: max; \}/, 'must have .critical override');
        assert.match(ss, /\.review \{ llm_model: claude-sonnet-4-6; \}/, 'must have .review override');

        // Validate all selectors are * or .className
        const selectors = [...ss.matchAll(/([.*\w]+)\s*\{/g)].map(m => m[1]);
        for (const sel of selectors) {
            assert.ok(sel === '*' || sel.startsWith('.'), `selector "${sel}" must be * or .className`);
        }

        // Validate all properties are llm_model or reasoning_effort
        const props = [...ss.matchAll(/(\w+):/g)].map(m => m[1]);
        const validProps = new Set(['llm_model', 'reasoning_effort']);
        for (const prop of props) {
            assert.ok(validProps.has(prop), `property "${prop}" must be llm_model or reasoning_effort`);
        }
    });
});
