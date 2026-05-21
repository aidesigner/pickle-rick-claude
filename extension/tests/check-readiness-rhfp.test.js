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

/**
 * R-CCR-13: inline code-snippet suppression (AC-CCR-13-1, AC-CCR-13-2, AC-CCR-13-3)
 */
test('R-CCR-13 (AC-CCR-13-1): test-runner and workflow-input dotted tokens are not extracted', () => {
  const content = [
    'Use `t.skip()` to skip a test.',
    'Enable fake timers with `t.mock.timers.enable()`.',
    'The run count is available as `inputs.run_count`.',
  ].join('\n');
  const refs = extractContractReferences(content);
  assert.ok(
    !refs.includes('t.skip()'),
    `t.skip() must be suppressed (inline snippet); got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.some((r) => r.startsWith('t.')),
    `no t.* ref must appear; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.some((r) => r.startsWith('inputs.')),
    `no inputs.* ref must appear; got ${JSON.stringify(refs)}`,
  );
});

test('R-CCR-13 (AC-CCR-13-2): genuine unresolved dotted symbol is still extracted', () => {
  // MyService is not a known snippet head, so this ref must pass through extraction
  // and appear in the returned set (the caller can then check resolution).
  const refs = extractContractReferences('Call `MyService.doWork` to process the job.');
  assert.ok(
    refs.includes('MyService.doWork'),
    `genuine in-repo dotted symbol must still be extracted; got ${JSON.stringify(refs)}`,
  );
});

// R-CCR-9: PATH_RE lookbehind (?<![\w./@-]) blocks @-scoped refs; ./ is in [\w.-] so ./-prefixed paths ARE extracted.
test('R-CCR-9 extractContractReferences: @-scoped package path is excluded from extraction', () => {
  const refs = extractContractReferences(
    'See `@scope/pkg/helper.ts` for the interface, also check `extension/src/bin/foo.ts`.',
  );
  assert.ok(
    !refs.some((r) => r.includes('@scope') || r === 'pkg/helper.ts'),
    `@-scoped package path must be excluded from extraction; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    refs.includes('extension/src/bin/foo.ts'),
    `plain in-repo path must still be extracted; got ${JSON.stringify(refs)}`,
  );
});

test('R-CCR-9 extractContractReferences: ./-prefixed relative path is included in extraction', () => {
  const refs = extractContractReferences('Edit `./src/helper.ts` to add the new function.');
  assert.ok(
    refs.includes('./src/helper.ts'),
    `./-prefixed path must be extracted as a contract ref; got ${JSON.stringify(refs)}`,
  );
});
