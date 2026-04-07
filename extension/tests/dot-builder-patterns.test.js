import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse DOT node definitions into Map<nodeId, Map<attrKey, attrValue>>. */
function parseDotNodes(dot) {
    const nodes = new Map();
    for (const line of dot.split('\n')) {
        const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\[(.+)\]\s*$/.exec(line);
        if (!m || m[1] === 'graph') continue;
        const attrs = new Map();
        const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
        let am;
        while ((am = re.exec(m[2])) !== null) attrs.set(am[1], am[2]);
        nodes.set(m[1], attrs);
    }
    return nodes;
}

/** Parse DOT edges into array of {source, target, attrs}. */
function parseDotEdges(dot) {
    const edges = [];
    const re = /^ *([a-zA-Z_][a-zA-Z0-9_]*) *-> *([a-zA-Z_][a-zA-Z0-9_]*) *(?:\[([^\]]*)\])?/gm;
    let m;
    while ((m = re.exec(dot)) !== null) {
        const attrs = new Map();
        const ar = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
        let am;
        while ((am = ar.exec(m[3] ?? '')) !== null) attrs.set(am[1], am[2]);
        edges.push({ source: m[1], target: m[2], attrs });
    }
    return edges;
}

/** Minimal valid spec. */
function baseSpec(overrides = {}) {
    return { slug: 'snapshot-test', goal: 'Auto-pattern snapshot', phases: [], acceptanceCriteria: {}, ...overrides };
}

/** Minimal valid phase. */
function phase(name, overrides = {}) {
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

// ---------------------------------------------------------------------------
// Auto-pattern snapshot tests — 18 auto-applied patterns
//
// One test per pattern. Each builds a pipeline whose spec meets the pattern's
// preconditions, calls .build(), and asserts pattern-specific DOT attributes.
// ---------------------------------------------------------------------------

describe('Auto-pattern snapshot tests (18 auto-applied patterns)', () => {

    // P0a: Dependency Setup ---------------------------------------------------
    test('P0a — setup_deps node with shape=cds and npm/pnpm/yarn fallback', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('core')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('setup_deps'), 'setup_deps node must exist');
        assert.equal(nodes.get('setup_deps').get('shape'), 'cds');
        const cmd = nodes.get('setup_deps').get('tool_command') ?? '';
        assert.ok(cmd.includes('npm install'), 'must include npm install');
        assert.ok(cmd.includes('pnpm install'), 'must include pnpm install');
        assert.ok(cmd.includes('yarn install'), 'must include yarn install');
        assert.ok(patternsApplied.includes('P0a'));
    });

    // P0b: Parallel Limit -----------------------------------------------------
    test('P0b — split_phases gets max_parallel=1 when fan-out active', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('auth'), phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('split_phases'), 'split_phases must exist');
        assert.equal(nodes.get('split_phases').get('max_parallel'), '1');
        assert.ok(patternsApplied.includes('P0b'));
    });

    // P0c: Baseline Snapshot --------------------------------------------------
    test('P0c — capture_baseline node with read_only, tsc and eslint counting', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('core')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('capture_baseline'), 'capture_baseline must exist');
        const cb = nodes.get('capture_baseline');
        assert.equal(cb.get('read_only'), 'true');
        const cmd = cb.get('tool_command') ?? '';
        assert.ok(cmd.includes('npx tsc --noEmit'), 'must count tsc errors');
        assert.ok(cmd.includes('npx eslint'), 'must count eslint errors');
        assert.ok(cmd.includes('grep -c'), 'must use grep -c for counting');
        assert.ok(patternsApplied.includes('P0c'));
    });

    // P0d: Delta-Aware Verify -------------------------------------------------
    test('P0d — verify nodes compare CURRENT against BASELINE', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        assert.match(dot, /verify_lint/, 'must have verify_lint');
        assert.match(dot, /verify_types/, 'must have verify_types');
        assert.match(dot, /BASELINE/, 'must reference BASELINE');
        assert.match(dot, /CURRENT/, 'must reference CURRENT');
        assert.ok(patternsApplied.includes('P0d'));
    });

    // P0e: Progress Gate ------------------------------------------------------
    test('P0e — check_progress with read_only, max_visits=3, git status', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('backend')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('check_progress_backend'), 'check_progress_backend must exist');
        const cp = nodes.get('check_progress_backend');
        assert.equal(cp.get('read_only'), 'true');
        assert.equal(cp.get('max_visits'), '3');
        assert.ok((cp.get('tool_command') ?? '').includes('git status --porcelain'));
        assert.ok(patternsApplied.includes('P0e'));
    });

    // P1: Test-Fix Loops ------------------------------------------------------
    test('P1 — diamond test gate with fix loop back to impl', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('service')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('test_service'), 'test_service must exist');
        assert.equal(nodes.get('test_service').get('shape'), 'diamond');
        assert.ok(nodes.has('fix_service'), 'fix_service must exist');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'test_service' && e.target === 'fix_service'), 'test fail → fix');
        assert.ok(edges.some(e => e.source === 'fix_service' && e.target === 'impl_service'), 'fix → impl loop');
        assert.ok(patternsApplied.includes('P1'));
    });

    // P3: Conditional Routing -------------------------------------------------
    test('P3 — every diamond node has ≥2 outgoing edges', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const diamonds = [...dot.matchAll(/(\w+)\s*\[.*?shape="diamond"/g)].map(m => m[1]);
        assert.ok(diamonds.length > 0, 'must have at least one diamond');
        const edges = parseDotEdges(dot);
        for (const d of diamonds) {
            const outs = edges.filter(e => e.source === d);
            assert.ok(outs.length >= 2, `diamond ${d} must have ≥2 outgoing edges, got ${outs.length}`);
        }
        assert.ok(patternsApplied.includes('P3'));
    });

    // P4: Fan-Out/Fan-In (2 independent phases, no dependsOn) -----------------
    test('P4 — 2 independent phases emit split[component] → branches → merge[tripleoctagon]', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('auth'), phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('split_phases'), 'split_phases must exist');
        assert.ok(nodes.has('merge_phases'), 'merge_phases must exist');
        assert.equal(nodes.get('split_phases').get('shape'), 'component');
        assert.equal(nodes.get('merge_phases').get('shape'), 'tripleoctagon');

        const edges = parseDotEdges(dot);
        const fromSplit = edges.filter(e => e.source === 'split_phases');
        assert.ok(fromSplit.length >= 2, 'split must fan out to ≥2 branches');
        const toMerge = edges.filter(e => e.target === 'merge_phases');
        assert.ok(toMerge.length >= 2, '≥2 branches must converge to merge');
        assert.ok(patternsApplied.includes('P4'));
    });

    // P6: Max Visits Guard ----------------------------------------------------
    test('P6 — impl nodes get max_visits=5, check_progress keeps max_visits=3', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.equal(nodes.get('impl_feature')?.get('max_visits'), '5', 'impl must have max_visits=5');
        assert.equal(nodes.get('check_progress_feature')?.get('max_visits'), '3', 'check_progress must keep max_visits=3');
        assert.ok(patternsApplied.includes('P6'));
    });

    // P6b: Read-Only + STATUS -------------------------------------------------
    test('P6b — review-class nodes have read_only=true and STATUS markers', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('code')],
        })).build();

        const reviewNodes = [...dot.matchAll(/(\w+)\s*\[.*?class="review"/g)].map(m => m[1]);
        assert.ok(reviewNodes.length > 0, 'must have review-class nodes');
        const nodes = parseDotNodes(dot);
        for (const id of reviewNodes) {
            assert.equal(nodes.get(id)?.get('read_only'), 'true', `${id} must be read_only`);
        }
        assert.match(dot, /STATUS:/, 'review prompts must include STATUS markers');
        assert.ok(patternsApplied.includes('P6b'));
    });

    // P10: Scope Creep Check --------------------------------------------------
    test('P10 — scope_check review node with read_only, shape=cds, git diff + allowed_paths', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('scope_check_api'), 'scope_check_api must exist');
        const sc = nodes.get('scope_check_api');
        assert.equal(sc.get('class'), 'review');
        assert.equal(sc.get('read_only'), 'true');
        assert.equal(sc.get('shape'), 'cds');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'impl_api' && e.target === 'scope_check_api'), 'impl → scope_check');
        assert.match(dot, /git diff.*allowed_paths|allowed_paths.*git diff/, 'prompt must reference git diff + allowed_paths');
        assert.ok(patternsApplied.includes('P10'));
    });

    // P13: Lint Gate ----------------------------------------------------------
    test('P13 — verify_lint node in verify chain after check_progress', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('module')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('verify_lint_module'), 'verify_lint_module must exist');
        assert.ok(dot.indexOf('check_progress_module') < dot.indexOf('verify_lint_module'), 'check_progress before verify_lint');
        assert.ok(patternsApplied.includes('P13'));
    });

    // P14: Type-Check Gate ----------------------------------------------------
    test('P14 — verify_types node in verify chain after verify_lint', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('module')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('verify_types_module'), 'verify_types_module must exist');
        assert.ok(dot.indexOf('verify_lint_module') < dot.indexOf('verify_types_module'), 'verify_lint before verify_types');
        assert.ok(patternsApplied.includes('P14'));
    });

    // P15: Conformance Audit --------------------------------------------------
    test('P15 — conformance review node with read_only, timeout=15m, after scope_check', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('conformance_feature'), 'conformance_feature must exist');
        const conf = nodes.get('conformance_feature');
        assert.equal(conf.get('class'), 'review');
        assert.equal(conf.get('read_only'), 'true');
        assert.equal(conf.get('timeout'), '15m');
        assert.ok(dot.indexOf('scope_check_feature') < dot.indexOf('conformance_feature'), 'scope_check before conformance');
        assert.ok(patternsApplied.includes('P15'));
    });

    // P21: Disaggregated verify/fix endgame chain ------------------------------
    test('P21 — disaggregated verify/fix chain with audit, verify_typecheck/lint/tests, fix_types/lint/tests, regression_check, quality_review', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [
                phase('auth', { allowedPaths: ['src/auth/'] }),
                phase('api', { allowedPaths: ['src/api/'], dependsOn: ['auth'] }),
            ],
        })).build();

        const nodes = parseDotNodes(dot);
        // All endgame nodes must exist
        for (const id of ['audit', 'verify_typecheck', 'verify_lint', 'verify_tests',
                          'fix_types', 'fix_lint', 'fix_tests', 'regression_check', 'quality_review']) {
            assert.ok(nodes.has(id), `${id} must exist`);
        }
        // fix_types has union of allowed_paths
        const ft = nodes.get('fix_types');
        assert.equal(ft.get('class'), 'codergen');
        assert.equal(ft.get('timeout'), '30m');
        assert.equal(ft.get('permission_mode'), 'auto');
        const ap = ft.get('allowed_paths') ?? '';
        assert.ok(ap.includes('src/auth/'), 'must include auth paths');
        assert.ok(ap.includes('src/api/'), 'must include api paths');

        // verify nodes have correct shapes and retry targets
        assert.equal(nodes.get('verify_typecheck').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_typecheck').get('retry_target'), 'fix_types');
        assert.equal(nodes.get('verify_lint').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_lint').get('retry_target'), 'fix_lint');
        assert.equal(nodes.get('verify_tests').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_tests').get('retry_target'), 'fix_tests');

        // No fix_all without broadPass
        assert.ok(!nodes.has('fix_all'), 'fix_all should NOT exist without broadPass');

        const edges = parseDotEdges(dot);
        // Chain: audit -> verify_typecheck -> verify_lint -> verify_tests -> regression_check -> quality_review
        assert.ok(edges.some(e => e.source === 'audit' && e.target === 'verify_typecheck'), 'audit -> verify_typecheck');
        assert.ok(edges.some(e => e.source === 'regression_check' && e.target === 'quality_review'), 'regression_check -> quality_review');
        assert.ok(patternsApplied.includes('P21'));
    });

    // P22: Permission Scoping -------------------------------------------------
    test('P22 — codergen impl nodes get allowed_paths, escalate_on, permission_mode=auto', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature', { allowedPaths: ['src/', 'lib/'], escalateOn: ['package.json', '*.lock'] })],
        })).build();

        const nodes = parseDotNodes(dot);
        const impl = nodes.get('impl_feature');
        assert.ok(impl, 'impl_feature must exist');
        assert.equal(impl.get('class'), 'codergen');
        assert.equal(impl.get('permission_mode'), 'auto');
        assert.ok(impl.has('allowed_paths'), 'must have allowed_paths');
        assert.ok(impl.has('escalate_on'), 'must have escalate_on');
        assert.ok(patternsApplied.includes('P22'));
    });

    // P23: Defense Matrix -----------------------------------------------------
    test('P23 — DEFENSE MATRIX comment block with all 5 fields + defenseMatrix result', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('secure')],
        })).build();

        assert.match(result.dot, /\/\* DEFENSE MATRIX/, 'must have DEFENSE MATRIX comment');
        const block = result.dot.substring(
            result.dot.indexOf('/* DEFENSE MATRIX'),
            result.dot.indexOf('*/', result.dot.indexOf('/* DEFENSE MATRIX')) + 2,
        );
        assert.ok(block.includes('competitive:'), 'must include competitive');
        assert.ok(block.includes('adversarial:'), 'must include adversarial');
        assert.ok(block.includes('specDriven:'), 'must include specDriven');
        assert.ok(block.includes('guardrails:'), 'must include guardrails');
        assert.ok(block.includes('permissions:'), 'must include permissions');

        assert.equal(typeof result.defenseMatrix, 'object');
        assert.equal(typeof result.defenseMatrix.competitive, 'boolean');
        assert.equal(typeof result.defenseMatrix.adversarial, 'boolean');
        assert.ok(Array.isArray(result.defenseMatrix.guardrails));
        assert.ok(Array.isArray(result.defenseMatrix.permissions));
        assert.ok(result.patternsApplied.includes('P23'));
    });

    // P25: Catastrophic Recovery ----------------------------------------------
    test('P25 — regression_check → setup_deps loop_restart edge on sequential pipelines', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('critical')],
        })).build();

        const edges = parseDotEdges(dot);
        const recovery = edges.find(e => e.source === 'regression_check' && e.target === 'setup_deps');
        assert.ok(recovery, 'must have regression_check → setup_deps edge');
        assert.equal(recovery.attrs.get('loop_restart'), 'true');
        assert.ok(patternsApplied.includes('P25'));
    });
});

// ---------------------------------------------------------------------------
// Remaining pattern snapshot tests
// ---------------------------------------------------------------------------

describe('Remaining pattern snapshot tests', () => {

    // P0: Workspace isolation + commit_and_push --------------------------------
    test('P0 — workspace=isolated emits graph-level workspace attr and commit_and_push node', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('commit_and_push', { prompt: 'commit and push changes', allowedPaths: ['src/'] })],
        }));
        builder.workspace({ repoUrl: 'https://github.com/test/repo.git', cleanup: 'delete' });
        const { dot, patternsApplied } = builder.build();

        assert.match(dot, /workspace="isolated"/, 'graph must have workspace=isolated');
        assert.ok(patternsApplied.includes('P0'), 'P0 must be applied');

        const nodes = parseDotNodes(dot);
        const impl = nodes.get('impl_commit_and_push');
        assert.ok(impl, 'impl_commit_and_push must exist');
        assert.equal(impl.get('repo_url'), 'https://github.com/test/repo.git');
        assert.equal(impl.get('cleanup'), 'delete');
    });

    // P2: Goal gates with retry_target + max_visits ----------------------------
    test('P2 — goalGate phase emits conformance with goal_gate=true and max_visits from defaultMaxRetry', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('gate', { goalGate: true, retryTarget: 'impl_gate', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(patternsApplied.includes('P2'), 'P2 must be applied');

        const nodes = parseDotNodes(dot);
        const conf = nodes.get('conformance_gate');
        assert.ok(conf, 'conformance_gate node must exist');
        assert.equal(conf.get('goal_gate'), 'true');
        assert.equal(conf.get('max_visits'), '3');

        const testNode = nodes.get('test_gate');
        assert.ok(testNode, 'test_gate must exist');
        assert.equal(testNode.get('retry_target'), 'impl_gate');
        assert.equal(testNode.get('max_visits'), '3');
    });

    // P8: Security scan after check_progress -----------------------------------
    test('P8 — securityScan phase emits review node with read_only after check_progress', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [
                phase('impl', { allowedPaths: ['src/'] }),
                { name: 'sec_scan', prompt: 'Run security audit. STATUS: report findings.', allowedPaths: ['src/'], securityScan: true },
            ],
        })).build();

        assert.ok(patternsApplied.includes('P8'), 'P8 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('sec_scan'), 'sec_scan node must exist');
        assert.equal(nodes.get('sec_scan').get('class'), 'review');
        assert.equal(nodes.get('sec_scan').get('read_only'), 'true');
    });

    // P9: Coverage gate after test success -------------------------------------
    test('P9 — coverageTarget emits test_run → coverage_gate diamond between verify_types and conformance', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('tested', { coverageTarget: 80, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P9'), 'P9 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('test_run_tested'), 'test_run_tested must exist');
        assert.ok(nodes.has('coverage_gate_tested'), 'coverage_gate_tested must exist');
        assert.equal(nodes.get('coverage_gate_tested').get('shape'), 'diamond');
        assert.equal(nodes.get('coverage_gate_tested').get('coverage_target'), '80');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'verify_types_tested' && e.target === 'test_run_tested'), 'verify_types → test_run');
        assert.ok(edges.some(e => e.source === 'test_run_tested' && e.target === 'coverage_gate_tested'), 'test_run → coverage_gate');
        assert.ok(edges.some(e => e.source === 'coverage_gate_tested' && e.target === 'conformance_tested'), 'coverage_gate → conformance');
    });

    // P16: Spec-first default-on with goalGate + opt-out via specFirst:false ----
    test('P16 — goalGate phase gets spec_file by default; specFirst:false suppresses it', () => {
        // goalGate without specFirst:false → spec_file emitted
        const withSpec = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(withSpec.patternsApplied.includes('P16'), 'P16 must be applied when goalGate default-on');
        const nodesWith = parseDotNodes(withSpec.dot);
        assert.ok(nodesWith.has('spec_file_gated'), 'spec_file_gated must exist for goalGate without opt-out');

        const edgesWith = parseDotEdges(withSpec.dot);
        assert.ok(edgesWith.some(e => e.source === 'spec_file_gated' && e.target === 'impl_gated'), 'spec_file → impl');

        // goalGate with specFirst:false → spec_file suppressed
        const withoutSpec = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', specFirst: false, allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(!withoutSpec.patternsApplied.includes('P16'), 'P16 must NOT be applied when specFirst:false');
        const nodesWithout = parseDotNodes(withoutSpec.dot);
        assert.ok(!nodesWithout.has('spec_file_gated'), 'spec_file_gated must NOT exist when specFirst:false');
    });

    // P16b: BDD scenarios opt-in only when bddScenarios:true -------------------
    test('P16b — bddScenarios:true emits bdd_scenarios node before spec_file; absent by default', () => {
        // With bddScenarios:true on a goalGate phase (spec_file also emitted)
        const withBDD = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', bddScenarios: true, allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(withBDD.patternsApplied.includes('P16b'), 'P16b must be applied');
        const nodesBDD = parseDotNodes(withBDD.dot);
        assert.ok(nodesBDD.has('bdd_scenarios_gated'), 'bdd_scenarios_gated must exist');
        assert.ok(nodesBDD.has('spec_file_gated'), 'spec_file_gated must also exist');

        const edgesBDD = parseDotEdges(withBDD.dot);
        assert.ok(edgesBDD.some(e => e.source === 'bdd_scenarios_gated' && e.target === 'spec_file_gated'), 'bdd_scenarios → spec_file');
        assert.ok(edgesBDD.some(e => e.source === 'spec_file_gated' && e.target === 'impl_gated'), 'spec_file → impl');

        // Without bddScenarios → no bdd_scenarios node
        const withoutBDD = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(!withoutBDD.patternsApplied.includes('P16b'), 'P16b must NOT be applied without bddScenarios');
        const nodesNoBDD = parseDotNodes(withoutBDD.dot);
        assert.ok(!nodesNoBDD.has('bdd_scenarios_gated'), 'bdd_scenarios_gated must NOT exist without opt-in');
    });

    // P17: Red team after conformance ------------------------------------------
    test('P17 — redTeam:true emits red_team node after test pass edge', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('hardened', { redTeam: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P17'), 'P17 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('red_team_hardened'), 'red_team_hardened must exist');
        assert.equal(nodes.get('red_team_hardened').get('read_only'), 'true');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'test_hardened' && e.target === 'red_team_hardened' && e.attrs.get('label') === 'pass'),
            'test → red_team on pass edge');
    });

    // P18: Competing implementations — component + tripleoctagon ---------------
    test('P18 — competing:true emits A/B component branches and tripleoctagon merge', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('solver', { competing: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P18'), 'P18 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('solver_a'), 'solver_a must exist');
        assert.ok(nodes.has('solver_b'), 'solver_b must exist');
        assert.ok(nodes.has('competing_merge'), 'competing_merge must exist');
        assert.equal(nodes.get('solver_a').get('shape'), 'component');
        assert.equal(nodes.get('solver_b').get('shape'), 'component');
        assert.equal(nodes.get('competing_merge').get('shape'), 'tripleoctagon');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'capture_baseline' && e.target === 'solver_a'), 'baseline → A');
        assert.ok(edges.some(e => e.source === 'capture_baseline' && e.target === 'solver_b'), 'baseline → B');
        assert.ok(edges.some(e => e.source === 'solver_a' && e.target === 'competing_merge'), 'A → merge');
        assert.ok(edges.some(e => e.source === 'solver_b' && e.target === 'competing_merge'), 'B → merge');
        assert.ok(edges.some(e => e.source === 'competing_merge' && e.target === 'exit'), 'merge → exit');
    });

    // P19: Review ratchet N-pass topology --------------------------------------
    test('P19 — reviewRatchet emits N review_pass components chained to tripleoctagon merge with fix loop', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('reviewed')],
        }));
        builder.reviewRatchet(3);
        const { dot, patternsApplied } = builder.build();

        assert.ok(patternsApplied.includes('P19'), 'P19 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('review_pass_1'), 'review_pass_1 must exist');
        assert.ok(nodes.has('review_pass_2'), 'review_pass_2 must exist');
        assert.ok(nodes.has('review_pass_3'), 'review_pass_3 must exist');
        assert.ok(nodes.has('review_merge'), 'review_merge must exist');
        assert.ok(nodes.has('fix_review'), 'fix_review must exist');

        for (let i = 1; i <= 3; i++) {
            assert.equal(nodes.get(`review_pass_${i}`).get('shape'), 'component', `review_pass_${i} shape=component`);
        }
        assert.equal(nodes.get('review_merge').get('shape'), 'tripleoctagon');
        assert.equal(nodes.get('review_merge').get('ratchet_count'), '3');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'review_pass_1' && e.target === 'review_pass_2'), 'pass_1 → pass_2');
        assert.ok(edges.some(e => e.source === 'review_pass_2' && e.target === 'review_pass_3'), 'pass_2 → pass_3');
        assert.ok(edges.some(e => e.source === 'review_pass_3' && e.target === 'review_merge'), 'pass_3 → merge');
        assert.ok(edges.some(e => e.source === 'review_merge' && e.target === 'exit' && e.attrs.get('label') === 'pass'), 'merge → exit on pass');
        assert.ok(edges.some(e => e.source === 'review_merge' && e.target === 'fix_review' && e.attrs.get('label') === 'fail'), 'merge → fix on fail');
        assert.ok(edges.some(e => e.source === 'fix_review' && e.target === 'review_pass_1'), 'fix → pass_1 loop');
    });

    // P20: Microverse optimize-measure-compare-check loop ----------------------
    test('P20 — microverse emits optimize→measure→compare→check loop with direction and target', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('perf')],
        }));
        builder.microverse('latency', {
            prompt: 'reduce p99 latency',
            measureCommand: 'npm run bench',
            target: 50,
            direction: 'reduce',
            allowedPaths: ['src/'],
            maxVisits: 8,
        });
        const { dot, patternsApplied } = builder.build();

        assert.ok(patternsApplied.includes('P20'), 'P20 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('commit_baseline'), 'commit_baseline must exist');
        assert.ok(nodes.has('baseline'), 'baseline must exist');
        assert.ok(nodes.has('optimize'), 'optimize must exist');
        assert.ok(nodes.has('measure'), 'measure must exist');
        assert.ok(nodes.has('compare'), 'compare must exist');
        assert.ok(nodes.has('check'), 'check must exist');

        assert.equal(nodes.get('compare').get('shape'), 'diamond');
        assert.equal(nodes.get('compare').get('direction'), 'reduce');
        assert.equal(nodes.get('compare').get('target'), '50');
        assert.equal(nodes.get('compare').get('max_visits'), '8');
        assert.equal(nodes.get('check').get('shape'), 'diamond');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'commit_baseline' && e.target === 'baseline'), 'commit_baseline → baseline');
        assert.ok(edges.some(e => e.source === 'baseline' && e.target === 'optimize'), 'baseline → optimize');
        assert.ok(edges.some(e => e.source === 'optimize' && e.target === 'measure'), 'optimize → measure');
        assert.ok(edges.some(e => e.source === 'measure' && e.target === 'compare'), 'measure → compare');
        assert.ok(edges.some(e => e.source === 'compare' && e.target === 'optimize' && e.attrs.get('label') === 'miss'), 'compare → optimize on miss');
        assert.ok(edges.some(e => e.source === 'compare' && e.target === 'check' && e.attrs.get('label') === 'hit'), 'compare → check on hit');
        assert.ok(edges.some(e => e.source === 'check' && e.target === 'exit' && e.attrs.get('label') === 'accept'), 'check → exit on accept');
        assert.ok(edges.some(e => e.source === 'check' && e.target === 'optimize' && e.attrs.get('label') === 'reject'), 'check → optimize on reject');
    });

    // specFirst:true on non-goal-gated phase -----------------------------------
    test('specFirst:true on non-goal-gated phase enables spec_file', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('plain', { specFirst: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P16'), 'P16 must be applied for explicit specFirst:true');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('spec_file_plain'), 'spec_file_plain must exist');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'spec_file_plain' && e.target === 'impl_plain'), 'spec_file → impl_plain');
    });

    // .modelStylesheet() generates valid stylesheet output ---------------------
    test('.modelStylesheet() generates valid stylesheet in selector { property: value; } format', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('styled')],
        }));
        builder.modelStylesheet({
            defaultModel: 'claude-sonnet-4-5-20250514',
            defaultEffort: 'high',
            overrides: [
                { selector: '.critical', model: 'claude-opus-4-5-20250514', effort: 'max' },
                { selector: '.review', model: 'claude-sonnet-4-5-20250514' },
            ],
        });
        const { dot } = builder.build();

        // Extract stylesheet value from graph attrs
        const ssMatch = /model_stylesheet="([^"]*)"/.exec(dot);
        assert.ok(ssMatch, 'must have model_stylesheet graph attribute');
        const ss = ssMatch[1];

        // Validate universal selector
        assert.match(ss, /\*\s*\{[^}]*llm_model:\s*claude-sonnet-4-5-20250514;/, '* selector must set llm_model');
        assert.match(ss, /\*\s*\{[^}]*reasoning_effort:\s*high;/, '* selector must set reasoning_effort');

        // Validate class selectors
        assert.match(ss, /\.critical\s*\{[^}]*llm_model:\s*claude-opus-4-5-20250514;/, '.critical must set llm_model');
        assert.match(ss, /\.critical\s*\{[^}]*reasoning_effort:\s*max;/, '.critical must set reasoning_effort');
        assert.match(ss, /\.review\s*\{[^}]*llm_model:\s*claude-sonnet-4-5-20250514;/, '.review must set llm_model');

        // Validate format: only valid selectors (* and .className) and valid properties (llm_model, reasoning_effort)
        const selectors = [...ss.matchAll(/([^\s{]+)\s*\{/g)].map(m => m[1]);
        for (const sel of selectors) {
            assert.ok(sel === '*' || /^\.[a-zA-Z][a-zA-Z0-9_]*$/.test(sel),
                `selector "${sel}" must be * or .className`);
        }
        const properties = [...ss.matchAll(/(\w+):/g)].map(m => m[1]);
        const validProps = new Set(['llm_model', 'reasoning_effort']);
        for (const prop of properties) {
            assert.ok(validProps.has(prop), `property "${prop}" must be llm_model or reasoning_effort`);
        }
    });
});
