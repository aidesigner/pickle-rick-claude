import type { CitadelFinding, CitadelSeverity } from './reporter.js';
import type { GateFailure, GateResult } from '../../types/index.js';

function mapSeverity(s: CitadelSeverity): 'error' | 'warning' {
  return s === 'Critical' || s === 'High' ? 'error' : 'warning';
}

export function citadelFindingsToGateResult(findings: CitadelFinding[]): GateResult {
  const failures: GateFailure[] = findings.map((finding, i) => ({
    check: 'lint',
    file: typeof finding.file === 'string' ? finding.file : '',
    line: typeof finding.line === 'number' ? finding.line : 0,
    ruleOrCode: finding.id,
    message: typeof finding.message === 'string' && finding.message.trim().length > 0
      ? finding.message
      : finding.id,
    severity: mapSeverity(finding.severity),
    occurrence_index: i,
  }));

  return {
    status: findings.length > 0 ? 'red' : 'green',
    failures,
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 0,
    total_raw_failure_count: findings.length,
    new_failures_vs_baseline: findings.length,
  };
}
