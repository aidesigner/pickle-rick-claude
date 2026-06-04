// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { citadelFindingsToGateResult } from '../../services/citadel/citadel-findings-to-gate-result.js';
import { isGateResult } from '../../bin/spawn-gate-remediator.js';

describe('citadelFindingsToGateResult', () => {
  test('empty input yields { status: "green", failures: [] } and satisfies isGateResult()', () => {
    const result = citadelFindingsToGateResult([]);
    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    assert.equal(result.baseline_used, false);
    assert.equal(result.allowed_paths_used, false);
    assert.equal(result.elapsed_ms, 0);
    assert.equal(result.total_raw_failure_count, 0);
    assert.equal(result.new_failures_vs_baseline, 0);
    assert.ok(isGateResult(result), 'empty result must satisfy isGateResult()');
  });

  test('representative findings map to well-formed GateResult that isGateResult() accepts', () => {
    const findings = [
      {
        id: 'trap-door-missing',
        severity: 'Critical',
        message: 'Trap door missing enforcement file',
        file: 'extension/src/bin/mux-runner.ts',
        line: 42,
      },
      {
        id: 'ac-coverage-gap',
        severity: 'High',
        message: 'Acceptance criterion has no test coverage',
        file: 'extension/src/services/citadel/ac-shape-audit.ts',
        line: 100,
      },
      {
        id: 'doc-drift',
        severity: 'Medium',
        file: 'CLAUDE.md',
        line: 7,
      },
      {
        id: 'style-nit',
        severity: 'Low',
        message: 'Minor style inconsistency',
      },
    ];

    const result = citadelFindingsToGateResult(findings);

    assert.ok(isGateResult(result), 'result must satisfy isGateResult()');
    assert.equal(result.status, 'red');
    assert.equal(result.failures.length, 4);
    assert.equal(result.total_raw_failure_count, 4);
    assert.equal(result.new_failures_vs_baseline, 4);
    assert.equal(result.baseline_used, false);
    assert.equal(result.allowed_paths_used, false);
    assert.equal(typeof result.elapsed_ms, 'number');

    // verify field mapping for Critical finding
    const f0 = result.failures[0];
    assert.equal(f0.check, 'lint');
    assert.equal(f0.file, 'extension/src/bin/mux-runner.ts');
    assert.equal(f0.line, 42);
    assert.equal(f0.ruleOrCode, 'trap-door-missing');
    assert.equal(f0.message, 'Trap door missing enforcement file');
    assert.equal(f0.severity, 'error');
    assert.equal(f0.occurrence_index, 0);

    // High → 'error'
    assert.equal(result.failures[1].severity, 'error');

    // Medium → 'warning'; message falls back to id when absent
    const f2 = result.failures[2];
    assert.equal(f2.severity, 'warning');
    assert.equal(f2.message, 'doc-drift');

    // Low → 'warning'
    assert.equal(result.failures[3].severity, 'warning');

    // finding with no file/line defaults to '' / 0
    const f3 = result.failures[3];
    assert.equal(f3.file, '');
    assert.equal(f3.line, 0);
  });

  test('occurrence_index increments per failure', () => {
    const findings = [
      { id: 'a', severity: 'High' },
      { id: 'b', severity: 'Medium' },
      { id: 'c', severity: 'Low' },
    ];
    const result = citadelFindingsToGateResult(findings);
    assert.equal(result.failures[0].occurrence_index, 0);
    assert.equal(result.failures[1].occurrence_index, 1);
    assert.equal(result.failures[2].occurrence_index, 2);
  });
});
