// @tier: fast
/**
 * R-RHFP (Finding #64) — check-readiness false-positive surface.
 * Two fixes verified here:
 *  (a) PATH_RE no longer drops the leading `.` of a dotfile path, so
 *      `.github/workflows/x.yml` is not mis-extracted as `github/workflows/x.yml`.
 *  (b) `*(refined: ...)*` correction notes are stripped before reference
 *      extraction, so deliberately-stale OLD paths quoted inside them are
 *      not flagged as unresolved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContractReferences } from '../bin/check-readiness.js';

test('R-RHFP (a): dotfile path keeps its leading dot', () => {
  const refs = extractContractReferences('CI is configured in .github/workflows/stability-gate.yml today');
  assert.ok(
    refs.includes('.github/workflows/stability-gate.yml'),
    `dotfile path must be extracted intact; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.includes('github/workflows/stability-gate.yml'),
    'the dot-stripped variant must NOT appear (that was the phantom finding)',
  );
});

test('R-RHFP (a): a normal non-dotfile path is still extracted', () => {
  const refs = extractContractReferences('edit extension/src/bin/mux-runner.ts for this');
  assert.ok(refs.includes('extension/src/bin/mux-runner.ts'));
});

test('R-RHFP (b): paths quoted inside a *(refined: ...)* note are not extracted', () => {
  const content = [
    'Implement the fix in `extension/src/bin/setup.ts`.',
    '*(refined: the original PRD cited `extension/src/old/stale-path.ts` — wrong, use the setup path)*',
  ].join('\n');
  const refs = extractContractReferences(content);
  assert.ok(refs.includes('extension/src/bin/setup.ts'), 'the real path must still be extracted');
  assert.ok(
    !refs.includes('extension/src/old/stale-path.ts'),
    `the stale path inside the correction note must be skipped; got ${JSON.stringify(refs)}`,
  );
});

test('R-RHFP (b): symbols quoted inside a *(refined: ...)* note are not extracted', () => {
  const content = 'Call `realHelper()`. *(refined: dropped the old `staleHelper()` call)*';
  const refs = extractContractReferences(content);
  assert.ok(refs.includes('realHelper()'));
  assert.ok(!refs.includes('staleHelper()'), `stale symbol in correction note must be skipped; got ${JSON.stringify(refs)}`);
});
