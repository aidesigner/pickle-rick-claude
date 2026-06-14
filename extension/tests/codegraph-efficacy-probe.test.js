// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as probe from '../bin/codegraph-efficacy-probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extension/tests -> extension -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('consumerFileJaccard: known diff + expected labels yields correct ratio', () => {
  assert.equal(probe.consumerFileJaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5); // 2 / 4
  assert.equal(probe.consumerFileJaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(probe.consumerFileJaccard(['a'], ['b']), 0);
  assert.equal(probe.consumerFileJaccard([], []), 0); // empty union -> 0, never NaN
  assert.equal(probe.consumerFileJaccard(['a', 'a', 'b'], ['b']), 0.5); // dedupe: {a,b} vs {b} = 1/2
});

test('diffTouchedFiles: parses +++ b/ and --- a/ paths, ignores /dev/null', () => {
  const diff = [
    'diff --git a/extension/src/x.ts b/extension/src/x.ts',
    '--- a/extension/src/x.ts',
    '+++ b/extension/src/x.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(probe.diffTouchedFiles(diff), ['extension/src/x.ts', 'gone.ts']);
});

test('hallucinatedRefCount: non-resolving backtick path counted, resolving paths not', () => {
  // A real repo path resolves; a fabricated sibling does not.
  const resolving = 'touches `extension/src/bin/check-readiness.ts` only';
  assert.equal(probe.hallucinatedRefCount(resolving, REPO_ROOT), 0);

  const fabricated = 'edits `extension/src/bin/totally-not-real-xyz-9z9z.ts` heavily';
  assert.ok(
    probe.hallucinatedRefCount(fabricated, REPO_ROOT) >= 1,
    'a fabricated path must be counted as hallucinated',
  );

  // Mixed: one real, one fabricated -> at least the fabricated one is counted.
  const mixed = 'real `extension/src/bin/check-readiness.ts` and fake `extension/src/bin/nope-xyz-9z9z.ts`';
  const count = probe.hallucinatedRefCount(mixed, REPO_ROOT);
  assert.ok(count >= 1, 'fabricated ref in mixed diff is counted');
});

test('buildEfficacySample: stamps event + ts and the scored fields', () => {
  const sample = probe.buildEfficacySample({
    ticket: 'abc12345',
    withCodegraph: true,
    hallucinatedRefCount: 2,
    consumerFileJaccard: 0.5,
    gatePass: false,
  });
  assert.equal(sample.event, 'codegraph_efficacy_sample');
  assert.equal(typeof sample.ts, 'string');
  assert.ok(sample.ts.length > 0);
  assert.equal(sample.ticket, 'abc12345');
  assert.equal(sample.with_codegraph, true);
  assert.equal(sample.hallucinated_ref_count, 2);
  assert.equal(sample.consumer_file_jaccard, 0.5);
  assert.equal(sample.gate_pass, false);
});

test('parseArgs: defaults + --tickets + --reps validation', () => {
  const def = probe.parseArgs([]);
  assert.equal(def.reps, 1);
  assert.ok(def.ticketsDir.includes('codegraph-efficacy'));

  const custom = probe.parseArgs(['--tickets', '/tmp/corpus', '--reps', '3']);
  assert.equal(custom.ticketsDir, '/tmp/corpus');
  assert.equal(custom.reps, 3);

  assert.throws(() => probe.parseArgs(['--reps', '0']), /positive integer/);
  assert.throws(() => probe.parseArgs(['--tickets']), /requires a directory/);
});

test('loadCorpus: missing dir exits non-zero with a clear message', () => {
  assert.throws(
    () => probe.loadCorpus('/nonexistent/codegraph-efficacy-corpus-xyz'),
    /corpus dir not found/,
  );
});

test('CLI guard: importing the module has no auto-run side effects', () => {
  // If the module auto-ran main() on import (no CLI guard), importing it for the tests above
  // would have produced corpus-load errors / process exits. Reaching here proves the guard.
  assert.equal(typeof probe.main, 'function');
  assert.equal(typeof probe.runProbe, 'function');
  assert.equal(typeof probe.captureWorkerDiff, 'function');
});
