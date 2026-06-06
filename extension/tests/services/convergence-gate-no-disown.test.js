// @tier: fast
// R-ORSR-6 no-disown classifier unit coverage. A tsc failure the phase's OWN diff introduced
// (its file is in the diff OR its message references a changed exported symbol) can never be
// labelled "pre-existing" and is therefore never dropped by subtractBaseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChangedExportedSymbolsFromDiff,
  extractTscFailureIdentifiers,
  isSelfIntroducedFailure,
  classifyNoDisown,
  subtractBaseline,
} from '../../services/convergence-gate.js';

function makeFailure(file, ruleOrCode, message, line = 1, occurrence_index = 0) {
  return { check: 'typecheck', file, line, ruleOrCode, message, severity: 'error', occurrence_index };
}

function makeBaseline(failures) {
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: '/repo',
    project_type: 'npm',
    checks: ['typecheck'],
    failures,
  };
}

test('parseChangedExportedSymbolsFromDiff: captures exported declarations on changed lines', () => {
  const diff = [
    'diff --git a/src/audit.ts b/src/audit.ts',
    '--- a/src/audit.ts',
    '+++ b/src/audit.ts',
    '@@ -1,3 +1,3 @@',
    '-export interface AuditResult { ok: boolean }',
    '+export interface AuditResult { ok: boolean; detail: string }',
    '+export type Severity = "low" | "high";',
    '+export function runAudit() { return null; }',
    ' const unchanged = 1;',
  ].join('\n');
  const symbols = parseChangedExportedSymbolsFromDiff(diff);
  assert.ok(symbols.has('AuditResult'));
  assert.ok(symbols.has('Severity'));
  assert.ok(symbols.has('runAudit'));
  assert.ok(!symbols.has('unchanged'), 'unchanged context line is not a changed export');
});

test('parseChangedExportedSymbolsFromDiff: binds the external name of aliased named re-exports', () => {
  const diff = [
    '+++ b/src/index.ts',
    '+export { A, B as C } from "./mod";',
  ].join('\n');
  const symbols = parseChangedExportedSymbolsFromDiff(diff);
  assert.ok(symbols.has('A'));
  assert.ok(symbols.has('C'), 'aliased name C, not its source B, is the externally-visible symbol');
  assert.ok(!symbols.has('B'));
});

test('parseChangedExportedSymbolsFromDiff: ignores +++/--- file headers', () => {
  const diff = [
    '--- a/export-helper.ts',
    '+++ b/export-helper.ts',
  ].join('\n');
  assert.equal(parseChangedExportedSymbolsFromDiff(diff).size, 0);
});

test('extractTscFailureIdentifiers: pulls quoted symbols plus the file stem', () => {
  const f = makeFailure('src/consumerSpec.ts', 'TS2339', `Property 'foo' does not exist on type 'AuditResult'.`);
  const ids = extractTscFailureIdentifiers(f);
  assert.ok(ids.includes('foo'));
  assert.ok(ids.includes('AuditResult'));
  assert.ok(ids.includes('consumerSpec'), 'basename stem is an identifier-shaped candidate');
});

test('isSelfIntroducedFailure: false when no context is supplied (no-guard default)', () => {
  const f = makeFailure('src/x.ts', 'TS2339', `type 'AuditResult'`);
  assert.equal(isSelfIntroducedFailure(f, undefined), false);
});

test('isSelfIntroducedFailure: true when the failing file is in the phase diff', () => {
  const f = makeFailure('/repo/src/changed.ts', 'TS1005', 'oops');
  const ctx = {
    changedFiles: new Set(['src/changed.ts']),
    changedExportedSymbols: new Set(),
    workingDir: '/repo',
  };
  assert.equal(isSelfIntroducedFailure(f, ctx), true);
});

test('isSelfIntroducedFailure: true when the message references a changed exported symbol', () => {
  const f = makeFailure('/repo/test/out-of-scope-spec.ts', 'TS2339', `does not exist on type 'AuditResult'.`);
  const ctx = {
    changedFiles: new Set(['src/audit.ts']),
    changedExportedSymbols: new Set(['AuditResult']),
    workingDir: '/repo',
  };
  // The out-of-scope consumer spec was never touched, but it broke on the changed interface.
  assert.equal(isSelfIntroducedFailure(f, ctx), true);
});

test('isSelfIntroducedFailure: false for an unrelated pre-existing failure', () => {
  const f = makeFailure('/repo/src/legacy.ts', 'TS2554', `Expected 1 arguments, but got 2.`);
  const ctx = {
    changedFiles: new Set(['src/audit.ts']),
    changedExportedSymbols: new Set(['AuditResult']),
    workingDir: '/repo',
  };
  assert.equal(isSelfIntroducedFailure(f, ctx), false);
});

test('classifyNoDisown: partitions self-introduced from other', () => {
  const selfByFile = makeFailure('/repo/src/audit.ts', 'TS1005', 'syntax');
  const selfBySymbol = makeFailure('/repo/test/consumer-spec.ts', 'TS2339', `type 'AuditResult'`);
  const preExisting = makeFailure('/repo/src/legacy.ts', 'TS2554', 'unrelated');
  const ctx = {
    changedFiles: new Set(['src/audit.ts']),
    changedExportedSymbols: new Set(['AuditResult']),
    workingDir: '/repo',
  };
  const { selfIntroduced, other } = classifyNoDisown([selfByFile, selfBySymbol, preExisting], ctx);
  assert.deepEqual(selfIntroduced.map(f => f.file), ['/repo/src/audit.ts', '/repo/test/consumer-spec.ts']);
  assert.deepEqual(other.map(f => f.file), ['/repo/src/legacy.ts']);
});

test('subtractBaseline: a self-introduced failure whose symbol intersects the diff is NOT subtracted', () => {
  const consumerBreak = makeFailure('/repo/test/consumer-spec.ts', 'TS2339', `does not exist on type 'AuditResult'.`);
  const baseline = makeBaseline([consumerBreak]); // identical fingerprint exists in baseline
  const selfGuard = {
    changedFiles: new Set(['src/audit.ts']),
    changedExportedSymbols: new Set(['AuditResult']),
    workingDir: '/repo',
  };
  const kept = subtractBaseline([consumerBreak], baseline, selfGuard);
  assert.equal(kept.length, 1, 'phase cannot disown its own break as a coincidental baseline match');
  assert.equal(kept[0].file, '/repo/test/consumer-spec.ts');
});

test('subtractBaseline: without the self-guard, a baseline-matching failure IS subtracted (legacy behavior)', () => {
  const consumerBreak = makeFailure('/repo/test/consumer-spec.ts', 'TS2339', `does not exist on type 'AuditResult'.`);
  const baseline = makeBaseline([consumerBreak]);
  const subtracted = subtractBaseline([consumerBreak], baseline);
  assert.equal(subtracted.length, 0, 'undefined selfGuard preserves pre-R-ORSR-6 subtraction');
});

test('subtractBaseline: a genuinely pre-existing failure is still subtracted even with the self-guard', () => {
  const preExisting = makeFailure('/repo/src/legacy.ts', 'TS2554', 'Expected 1 arguments, but got 2.');
  const baseline = makeBaseline([preExisting]);
  const selfGuard = {
    changedFiles: new Set(['src/audit.ts']),
    changedExportedSymbols: new Set(['AuditResult']),
    workingDir: '/repo',
  };
  const kept = subtractBaseline([preExisting], baseline, selfGuard);
  assert.equal(kept.length, 0, 'an unrelated pre-existing failure is not self-introduced and is dropped');
});

test('subtractBaseline: a new (non-baseline) failure is always kept regardless of self-guard', () => {
  const fresh = makeFailure('/repo/src/legacy.ts', 'TS2554', 'unrelated');
  const baseline = makeBaseline([]); // empty baseline
  assert.equal(subtractBaseline([fresh], baseline).length, 1);
  assert.equal(subtractBaseline([fresh], baseline, {
    changedFiles: new Set(),
    changedExportedSymbols: new Set(),
  }).length, 1);
});
