// @tier: fast
// AC-PGI-8-1: optional-graph-input seam (buildTierClassificationSection) produces valid tier
// output with graph input available:false — heuristics-only fallback is intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildTierClassificationSection,
  buildRefinementGraphContext,
  extractRefinementSymbols,
} = await import('../bin/spawn-refinement-team.js');

const TIER_KEYWORDS = ['trivial', 'small', 'medium', 'large'];

// AC-PGI-8-1: seam with available:false is identical to seam with no arg (heuristics-only)
test('AC-PGI-8-1: buildTierClassificationSection({available:false}) equals no-arg (heuristics-only)', () => {
  const withFalse = buildTierClassificationSection({ available: false });
  const noArg = buildTierClassificationSection();
  assert.equal(withFalse, noArg, 'available:false and no-arg must produce identical output');
});

// AC-PGI-8-1: heuristics-only fallback contains all four tier keywords
test('AC-PGI-8-1: heuristics-only fallback contains trivial/small/medium/large tiers', () => {
  const result = buildTierClassificationSection({ available: false });
  for (const tier of TIER_KEYWORDS) {
    assert.ok(result.includes(tier), `expected tier keyword "${tier}" in heuristics-only output`);
  }
});

// Core invariant: available:true still contains all tier keywords (not broken)
test('buildTierClassificationSection({available:true}) still contains all tier keywords', () => {
  const result = buildTierClassificationSection({ available: true });
  for (const tier of TIER_KEYWORDS) {
    assert.ok(result.includes(tier), `expected tier keyword "${tier}" in graph-enriched output`);
  }
});

// Core invariant: available:true output starts with the same heuristics block
test('buildTierClassificationSection({available:true}) starts with heuristics baseline', () => {
  const baseline = buildTierClassificationSection({ available: false });
  const enriched = buildTierClassificationSection({ available: true });
  assert.ok(enriched.startsWith(baseline.trimEnd()), 'graph-enriched output must start with heuristics baseline');
});

// buildRefinementGraphContext returns null when available:false
test('buildRefinementGraphContext returns null when available:false', () => {
  const prd = '## Files to modify\n- `buildWorkerPrompt`\n';
  const result = buildRefinementGraphContext(prd, process.cwd(), { available: false });
  assert.equal(result, null, 'must return null when graph is not available');
});

// buildRefinementGraphContext returns null when available:true but no .gitnexus index in tmpdir
test('buildRefinementGraphContext returns null when no .gitnexus index present', () => {
  const prd = '## Files to modify\n- `buildWorkerPrompt`\n';
  // Use a dir that definitely has no .gitnexus (system temp)
  const result = buildRefinementGraphContext(prd, '/tmp', { available: true });
  assert.equal(result, null, 'must return null when .gitnexus index absent');
});

// extractRefinementSymbols: empty PRD yields empty array
test('extractRefinementSymbols: empty PRD yields empty symbols', () => {
  assert.deepEqual(extractRefinementSymbols(''), []);
});

// extractRefinementSymbols: extracts symbols from "Files to modify" section
test('extractRefinementSymbols: extracts identifiers from Files to modify section', () => {
  const prd = '## Files to modify\n- `orchestrateCycles` — main\n- `buildWorkerPrompt` — prompt\n';
  const result = extractRefinementSymbols(prd);
  assert.ok(result.includes('orchestrateCycles'), 'must extract orchestrateCycles');
  assert.ok(result.includes('buildWorkerPrompt'), 'must extract buildWorkerPrompt');
});

// extractRefinementSymbols: skips path-like tokens (with slashes)
test('extractRefinementSymbols: skips path tokens like extension/src/foo.ts', () => {
  const prd = '## Files to modify\n- `extension/src/spawn-refinement-team.ts` — main\n- `buildWorkerPrompt`\n';
  const result = extractRefinementSymbols(prd);
  assert.ok(!result.some((s) => s.includes('/')), 'must not include path-like tokens');
  assert.ok(result.includes('buildWorkerPrompt'), 'must still extract plain identifiers');
});

// extractRefinementSymbols: deduplicates repeated symbols
test('extractRefinementSymbols: deduplicates symbols across sections', () => {
  const prd = '## Files to modify\n- `foo`\n## Files to create\n- `foo`\n- `bar`\n';
  const result = extractRefinementSymbols(prd);
  const fooCount = result.filter((s) => s === 'foo').length;
  assert.equal(fooCount, 1, 'foo must appear only once');
  assert.ok(result.includes('bar'));
});

// extractRefinementSymbols: strips trailing () from function calls
test('extractRefinementSymbols: strips trailing () from function call symbols', () => {
  const prd = '## Files to modify\n- `runCycle()` — the function\n';
  const result = extractRefinementSymbols(prd);
  assert.ok(result.includes('runCycle'), 'must strip () from symbol');
  assert.ok(!result.includes('runCycle()'), 'must not include () suffix');
});
