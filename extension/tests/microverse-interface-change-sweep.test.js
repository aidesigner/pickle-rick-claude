// @tier: fast
// R-ORSR-6 interface-change sweep coverage (AC: "Whole-repo `tsc` runs (not scope-fenced) when
// an exported symbol changes" + "INV-NO-SELF-DISOWN: a phase cannot converge while a gate it
// turned red is open"). The per-iteration gate is scope-fenced, so an out-of-scope consumer
// that still uses the OLD shape of a changed exported interface is never type-checked there
// (Finding #103). `runInterfaceChangeSweep` re-runs tsc whole-repo and keeps only the failures
// the phase's own diff introduced — the phase cannot disown its own break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInterfaceChangeSweep } from '../bin/microverse-runner.js';

function makeFailure(file, message, ruleOrCode = 'TS2339', line = 1, occurrence_index = 0) {
  return { check: 'typecheck', file, line, ruleOrCode, message, severity: 'error', occurrence_index };
}

const noopLog = () => {};

test('runInterfaceChangeSweep: no exported-symbol change → sweep does NOT run (no whole-repo tsc)', async () => {
  let gateCalls = 0;
  const result = await runInterfaceChangeSweep({
    workingDir: '/repo',
    sessionDir: '/sessions/s1',
    startCommit: 'base000',
    runGateFn: async () => {
      gateCalls++;
      return { failures: [] };
    },
    logActivityFn: noopLog,
    getChangedExportedSymbolsFn: () => new Set(), // nothing exported changed
    getChangedFilesSinceFn: () => ['src/audit.ts'],
  });
  assert.equal(result.ran, false, 'sweep must not run when no exported symbol changed');
  assert.equal(result.selfIntroduced.length, 0);
  assert.equal(gateCalls, 0, 'whole-repo tsc must not be spawned when no interface changed');
});

test('runInterfaceChangeSweep: changed exported symbol → runs WHOLE-REPO tsc (scope=full)', async () => {
  let gateOpts = null;
  const result = await runInterfaceChangeSweep({
    workingDir: '/repo',
    sessionDir: '/sessions/s2',
    startCommit: 'base000',
    runGateFn: async (opts) => {
      gateOpts = opts;
      return { failures: [] };
    },
    logActivityFn: noopLog,
    getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    getChangedFilesSinceFn: () => ['src/audit.ts'],
  });
  assert.equal(result.ran, true);
  assert.ok(gateOpts, 'gate must be invoked');
  assert.equal(gateOpts.scope, 'full', 'sweep MUST run whole-repo (scope=full), not scope-fenced');
  assert.equal(gateOpts.mode, 'strict');
  assert.deepEqual(gateOpts.checks, ['typecheck']);
});

test('INV-NO-SELF-DISOWN: a break in the phase OWN diff is kept as self-introduced (blocks convergence)', async () => {
  // The whole-repo tsc fails in src/audit.ts — a file the phase itself changed.
  const result = await runInterfaceChangeSweep({
    workingDir: '/repo',
    sessionDir: '/sessions/s3',
    startCommit: 'base000',
    runGateFn: async () => ({
      failures: [makeFailure('src/audit.ts', `Property 'detail' does not exist on type 'AuditResult'.`)],
    }),
    logActivityFn: noopLog,
    getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    getChangedFilesSinceFn: () => ['src/audit.ts'],
  });
  assert.equal(result.ran, true);
  assert.equal(result.selfIntroduced.length, 1, 'a failure in the phase own diff must be kept (not disowned)');
  assert.equal(result.selfIntroduced[0].file, 'src/audit.ts');
});

test('INV-NO-SELF-DISOWN: out-of-scope consumer break referencing a changed exported symbol is self-introduced', async () => {
  // The consumer (src/consumer.ts) is NOT in the phase diff, but its tsc error references the
  // changed exported symbol AuditResult — the #103 root cause. It MUST count as self-introduced.
  const result = await runInterfaceChangeSweep({
    workingDir: '/repo',
    sessionDir: '/sessions/s4',
    startCommit: 'base000',
    runGateFn: async () => ({
      failures: [makeFailure('src/consumer.ts', `Type 'AuditResult' is missing property 'detail'.`)],
    }),
    logActivityFn: noopLog,
    getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    getChangedFilesSinceFn: () => ['src/audit.ts'], // consumer.ts NOT changed
  });
  assert.equal(result.selfIntroduced.length, 1, 'consumer break referencing a changed symbol is self-introduced');
  assert.equal(result.selfIntroduced[0].file, 'src/consumer.ts');
});

test('runInterfaceChangeSweep: an unrelated pre-existing break (no symbol/file overlap) is NOT self-introduced', async () => {
  const result = await runInterfaceChangeSweep({
    workingDir: '/repo',
    sessionDir: '/sessions/s5',
    startCommit: 'base000',
    runGateFn: async () => ({
      failures: [makeFailure('src/unrelated.ts', `Type 'Foo' is not assignable to type 'Bar'.`)],
    }),
    logActivityFn: noopLog,
    getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    getChangedFilesSinceFn: () => ['src/audit.ts'],
  });
  assert.equal(result.ran, true);
  assert.equal(result.selfIntroduced.length, 0, 'a break with no file/symbol overlap is not the phase own');
});
