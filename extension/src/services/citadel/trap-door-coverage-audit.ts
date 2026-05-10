import { DiffSummary } from './diff-walker.js';
import { CitadelFinding } from './reporter.js';

export interface TrapDoorCoverageResult {
  findings: CitadelFinding[];
}

export function auditTrapDoorCoverage(_diff: DiffSummary): TrapDoorCoverageResult {
  return { findings: [] };
}
