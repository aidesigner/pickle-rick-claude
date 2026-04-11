import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

function makeConvergenceSpec(overrides = {}) {
  return {
    slug: 'iter-test',
    goal: 'test convergence',
    phases: [{ name: 'core', prompt: 'implement', allowedPaths: ['src/'] }],
    acceptanceCriteria: { done: 'converged' },
    convergence: {
      until: 'V_total == 0 && fixed_point && reproducibility',
      impl: { harness: 'claude-code', prompt: 'Implement the feature' },
      ...overrides,
    },
  };
}

describe('iterate convergence', () => {
  it('AC3: basic convergence emission', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(dot.includes('class="iterate"'), 'converge node must have class="iterate"');
    assert.ok(dot.includes('subgraph cluster_iter_body'), 'iter body subgraph must be emitted');
    assert.ok(dot.includes('iter_impl'), 'iter_impl node must be present');
    assert.ok(dot.includes('iter_review_be'), 'iter_review_be node must be present');
    assert.ok(dot.includes('iter_review_fe'), 'iter_review_fe node must be present');
    assert.ok(dot.includes('iter_review_int'), 'iter_review_int node must be present');
    assert.ok(dot.includes('iter_adversary'), 'iter_adversary node must be present');
  });

  it('AC6: all three reviewer lenses', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(dot.includes('reviewer_lens="backend"'), 'backend reviewer lens must be present');
    assert.ok(dot.includes('reviewer_lens="frontend"'), 'frontend reviewer lens must be present');
    assert.ok(dot.includes('reviewer_lens="integration"'), 'integration reviewer lens must be present');
  });

  it('AC7: adversary sealed_from_source', () => {
    const spec = makeConvergenceSpec({ sealedFromSource: '/tmp/spec.md' });
    const { dot } = DotBuilder.fromSpec(spec).build();
    assert.ok(dot.includes('sealed_from_source='), 'sealed_from_source attr must appear on adversary');
    assert.ok(dot.includes('/tmp/spec.md'), 'sealed_from_source value must be present');
  });

  it('AC5/AC11: duplicate model rejected', () => {
    const spec = {
      ...makeConvergenceSpec(),
      modelStylesheet: {
        defaultModel: 'sonnet',
        overrides: [
          { selector: '.impl', model: 'opus' },
          { selector: '.honest_review', model: 'opus' },
        ],
      },
    };
    assert.throws(
      () => DotBuilder.fromSpec(spec).build(),
      (err) => {
        assert.ok(err instanceof BuildError, 'must throw BuildError');
        assert.equal(err.code, 'DUPLICATE_MODEL');
        return true;
      },
    );
  });

  it('AC13: invalid until predicate rejected', () => {
    const spec = makeConvergenceSpec({ until: 'custom_predicate' });
    assert.throws(
      () => DotBuilder.fromSpec(spec).build(),
      (err) => {
        assert.ok(err instanceof BuildError, 'must throw BuildError');
        assert.equal(err.code, 'INVALID_CONVERGENCE_SPEC');
        return true;
      },
    );
  });

  it('AC12: traditional endgame chain suppressed', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(!dot.includes('verify_typecheck'), 'verify_typecheck must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_types'), 'fix_types must NOT appear in convergence output');
    assert.ok(!dot.includes('verify_lint'), 'verify_lint must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_lint'), 'fix_lint must NOT appear in convergence output');
    assert.ok(!dot.includes('verify_tests'), 'verify_tests must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_tests'), 'fix_tests must NOT appear in convergence output');
  });

  it('AC14: P25 (regression_check -> setup_deps) suppressed', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(!dot.includes('regression_check'), 'regression_check must NOT appear in convergence output');
    // The P25 loop-restart edge must not be emitted
    assert.ok(
      !dot.includes('loop_restart'),
      'loop_restart edge (P25) must be suppressed in convergence mode',
    );
  });

  it('AC8: P0 composition — commit_and_push injected for isolated workspace', () => {
    const spec = { ...makeConvergenceSpec(), workspace: 'isolated' };
    const { dot } = DotBuilder.fromSpec(spec).build();
    assert.ok(dot.includes('commit_and_push'), 'commit_and_push must be injected for workspace=isolated');
    // quality_review -> commit_and_push -> exit rewiring
    assert.ok(
      dot.includes('quality_review -> commit_and_push'),
      'quality_review must route to commit_and_push',
    );
    assert.ok(dot.includes('commit_and_push -> exit'), 'commit_and_push must route to exit');
  });

  it('AC15: P1 composition — setup_deps emitted before converge', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(dot.includes('setup_deps'), 'setup_deps must be present');
    const setupIdx = dot.indexOf('setup_deps');
    const convergeIdx = dot.indexOf('converge');
    assert.ok(setupIdx < convergeIdx, 'setup_deps must appear before converge in DOT output');
  });

  it('node ID stability — all body nodes use iter_ prefix', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const expectedIds = ['iter_impl', 'iter_review_be', 'iter_review_fe', 'iter_review_int', 'iter_adversary'];
    for (const id of expectedIds) {
      assert.ok(dot.includes(id), `node ${id} must be present`);
    }
    // Verify they are NOT the old non-prefixed names
    assert.ok(!dot.includes('"impl"'), 'no bare "impl" node in convergence mode');
  });

  it('P32 in patternsApplied', () => {
    const { patternsApplied } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(patternsApplied.includes('P32'), 'patternsApplied must include P32 for convergence');
  });

  it('default maxVisits and timeout applied when not specified', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(dot.includes('max_visits="20"'), 'default max_visits must be 20 on converge node');
    assert.ok(dot.includes('timeout="60m"'), 'default timeout must be 60m on converge node');
  });
});
