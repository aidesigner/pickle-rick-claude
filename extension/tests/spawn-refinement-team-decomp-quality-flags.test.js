// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  detectDecompositionQualityFlags,
  buildRefinementManifest,
} from '../bin/spawn-refinement-team.js';

function ticket(overrides) {
  return {
    id: 'test-ticket',
    title: 'A simple ticket',
    source_ac_ids: [],
    complexity_tier: 'medium',
    ...overrides,
  };
}

function minimalArgs(prdPath) {
  return { prdPath, sessionDir: path.dirname(prdPath) };
}

function minimalCycleResults(refinementDir, tickets) {
  return {
    refinementDir,
    cyclesRequested: 1,
    maxTurns: 10,
    allCycleResults: [[]],
    finalResults: [],
    allSuccess: true,
  };
}

test('detectDecompositionQualityFlags: large-tier ticket is flagged with pre_split', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'big-ticket', title: 'Implement everything', complexity_tier: 'large' }),
  ]);
  assert.equal(flags.length, 1, 'expected one flag for large-tier ticket');
  assert.equal(flags[0].ticket_id, 'big-ticket');
  assert.equal(flags[0].reason, 'large_tier');
  assert.equal(flags[0].action, 'pre_split');
  assert.ok(flags[0].evidence.includes('complexity_tier=large'), 'evidence should mention complexity_tier');
  assert.ok(typeof flags[0].suggested_reframe === 'string' && flags[0].suggested_reframe.length > 0, 'should have non-empty suggested_reframe');
});

test('detectDecompositionQualityFlags: "author 120 rows" title is flagged with bounded_reframe', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'row-ticket', title: 'Author 120 rows of configuration YAML', complexity_tier: 'medium' }),
  ]);
  assert.equal(flags.length, 1, 'expected one flag for open-ended derivation title');
  assert.equal(flags[0].ticket_id, 'row-ticket');
  assert.equal(flags[0].reason, 'open_ended_derivation');
  assert.equal(flags[0].action, 'bounded_reframe');
  assert.ok(flags[0].evidence.length > 0, 'evidence should be non-empty');
});

test('detectDecompositionQualityFlags: "review the whole module" is flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'review-ticket', title: 'Review the whole module for issues', complexity_tier: 'small' }),
  ]);
  assert.equal(flags.length, 1, 'expected one flag for "review the whole" pattern');
  assert.equal(flags[0].reason, 'open_ended_derivation');
  assert.equal(flags[0].action, 'bounded_reframe');
});

test('detectDecompositionQualityFlags: "against 10 principles" is flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'principles-ticket', title: 'Audit codebase against 10 principles', complexity_tier: 'medium' }),
  ]);
  assert.equal(flags.length, 1, 'expected one flag for "against N principles" pattern');
  assert.equal(flags[0].reason, 'open_ended_derivation');
});

test('detectDecompositionQualityFlags: "all config rows" is flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'rows-ticket', title: 'Update all config rows in the settings table', complexity_tier: 'small' }),
  ]);
  assert.equal(flags.length, 1, 'expected one flag for "all X rows" pattern');
  assert.equal(flags[0].reason, 'open_ended_derivation');
});

test('detectDecompositionQualityFlags: medium-tier simple title is not flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'normal-ticket', title: 'Add unit tests for tick counter', complexity_tier: 'medium' }),
  ]);
  assert.equal(flags.length, 0, 'expected no flags for a clean medium-tier ticket');
});

test('detectDecompositionQualityFlags: trivial ticket is not flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'tiny-ticket', title: 'Fix typo in README', complexity_tier: 'trivial' }),
  ]);
  assert.equal(flags.length, 0, 'expected no flags for trivial tier');
});

test('detectDecompositionQualityFlags: small-tier with no open-ended pattern is not flagged', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'small-ticket', title: 'Add null-check to parseArgs', complexity_tier: 'small' }),
  ]);
  assert.equal(flags.length, 0, 'expected no flags for small-tier clean ticket');
});

test('detectDecompositionQualityFlags: open-ended pattern in acceptance_test is detected', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({
      id: 'ac-ticket',
      title: 'Improve parser',
      acceptance_test: 'Review the whole parsing module for edge cases',
      complexity_tier: 'medium',
    }),
  ]);
  assert.equal(flags.length, 1, 'expected flag when pattern appears in acceptance_test');
  assert.equal(flags[0].reason, 'open_ended_derivation');
});

test('detectDecompositionQualityFlags: large-tier takes precedence over open-ended pattern', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({
      id: 'large-open-ticket',
      title: 'Author 50 rows of config across 5 files',
      complexity_tier: 'large',
    }),
  ]);
  assert.equal(flags.length, 1, 'expected exactly one flag (large_tier takes precedence)');
  assert.equal(flags[0].reason, 'large_tier', 'large_tier should win over open_ended_derivation');
});

test('detectDecompositionQualityFlags: multiple tickets returns one flag per flagged ticket', () => {
  const flags = detectDecompositionQualityFlags([
    ticket({ id: 'clean', title: 'Add input validation', complexity_tier: 'small' }),
    ticket({ id: 'big', title: 'Refactor everything', complexity_tier: 'large' }),
    ticket({ id: 'open', title: 'Review the whole codebase', complexity_tier: 'medium' }),
  ]);
  assert.equal(flags.length, 2, 'expected two flags (one large_tier, one open_ended_derivation)');
  assert.ok(flags.some((f) => f.ticket_id === 'big' && f.reason === 'large_tier'));
  assert.ok(flags.some((f) => f.ticket_id === 'open' && f.reason === 'open_ended_derivation'));
});

test('buildRefinementManifest: decomposition_quality_flags field is present', () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-decomp-test-')));
  try {
    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# Test PRD\n\n## Overview\nA simple PRD for testing.\n');

    const refinementDir = path.join(tmpDir, 'refinement');
    fs.mkdirSync(refinementDir, { recursive: true });

    const args = minimalArgs(prdPath);
    const cycleResults = minimalCycleResults(refinementDir, []);

    const manifest = buildRefinementManifest(args, cycleResults);
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest, 'decomposition_quality_flags'),
      'manifest should have decomposition_quality_flags field',
    );
    assert.ok(Array.isArray(manifest.decomposition_quality_flags), 'decomposition_quality_flags should be an array');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
