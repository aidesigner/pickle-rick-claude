// @tier: fast
//
// R-FGNC (Finding #18) — the gate output classifier must not conflate pnpm's
// `.npmrc` env-var WARN noise with real check failures.
//   R-FGNC-1: `.npmrc` WARN lines are stripped before failure-line parsing,
//             and BOTH stdout+stderr are scanned (real tsc/lint errors land on
//             stdout; the WARN lands on stderr — `stderr || stdout` dropped them).
//   R-FGNC-2: the subprocess exit code is the source of truth for pass/fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailures, stripEnvNoise } from '../../services/convergence-gate.js';

const NPMRC_WARN =
  ' WARN  Issue while reading "/home/dev/.npmrc". Failed to replace env in config: ${GITHUB_PACKAGES_TOKEN}';

test('R-FGNC-2: exit 0 with a .npmrc WARN on stderr classifies green (zero failures)', () => {
  const failures = buildFailures({ stdout: '', stderr: `${NPMRC_WARN}\n`, exitCode: 0 }, 'typecheck', '/pkg');
  assert.deepEqual(failures, [], 'exit 0 must yield no failures regardless of stderr WARN content');
});

test('R-FGNC-1: real TS errors on stdout survive a .npmrc WARN on stderr', () => {
  const stdout = [
    'src/a.ts(10,3): error TS2322: Type x not assignable',
    'src/b.ts(20,5): error TS18046: y is of type unknown',
    'src/c.ts(30,7): error TS2345: bad arg',
    'src/d.ts(40,9): error TS2532: possibly undefined',
    'src/e.ts(50,1): error TS7006: implicit any',
  ].join('\n');
  const failures = buildFailures({ stdout, stderr: `${NPMRC_WARN}\n`, exitCode: 1 }, 'typecheck', '/pkg');
  assert.equal(failures.length, 5, `expected the 5 real TS errors, got ${JSON.stringify(failures)}`);
  assert.ok(failures.every((f) => f.ruleOrCode.startsWith('TS')), 'every failure must be a real TS error');
  assert.ok(!failures.some((f) => /npmrc/.test(f.message)), 'no failure may carry .npmrc WARN noise');
});

test('R-FGNC-1: real eslint errors on stdout survive a .npmrc WARN on stderr', () => {
  const stdout = [
    '/pkg/src/foo.ts',
    '  12:3  error  Missing semicolon  semi',
    '  14:1  error  Unexpected console statement  no-console',
  ].join('\n');
  const failures = buildFailures({ stdout, stderr: `${NPMRC_WARN}\n`, exitCode: 1 }, 'lint', '/pkg');
  assert.equal(failures.length, 2, `expected 2 real lint errors, got ${JSON.stringify(failures)}`);
  assert.ok(!failures.some((f) => /npmrc/.test(f.message)), 'no failure may carry .npmrc WARN noise');
});

test('R-FGNC-1: a non-zero exit with ONLY .npmrc WARN yields a generic failure free of noise', () => {
  const failures = buildFailures({ stdout: '', stderr: `${NPMRC_WARN}\n`, exitCode: 1 }, 'typecheck', '/pkg');
  assert.equal(failures.length, 1, 'a non-zero exit still surfaces one generic failure');
  assert.ok(
    !/npmrc/.test(failures[0].message),
    `the generic failure must not echo the .npmrc WARN; got: ${failures[0].message}`,
  );
});

test('R-FGNC-1: stripEnvNoise drops WARN config-read lines, keeps real content', () => {
  const out = stripEnvNoise(
    `${NPMRC_WARN}\nsrc/a.ts(1,1): error TS2322: real error\n WARN  Issue while reading "/x/.npmrc"`,
  );
  assert.ok(out.includes('error TS2322'), 'real error lines must be kept');
  assert.ok(!out.includes('npmrc'), 'all .npmrc WARN lines must be stripped');
});
