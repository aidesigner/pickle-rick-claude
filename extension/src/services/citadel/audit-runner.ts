import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../../lib/is-record.js';
import { withLock } from '../state-manager.js';
import { auditAcShape, AcShapeAuditReport } from './ac-shape-audit.js';
import { auditSiblingAuthPreconditions } from './sibling-auth-audit.js';
import { auditFrontendPropDrift } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';
import { auditRuleSetInvariants } from './rule-set-invariant-audit.js';
import { auditDiffHygiene } from './diff-hygiene.js';
import { reconcileDivergences, DivergenceDecisionRequired } from './divergence-reconciliation.js';
import { CitadelFinding, CitadelJsonReport, CitadelReportHeader, CitadelRunResult, CitadelSeverity, Reporter } from './reporter.js';
import { parseWithComposes } from './prd-parser.js';
import { detectProjectShapes, ProjectShape } from './project-shape.js';
import { buildAcCoverageScorecard } from './ac-coverage-scorecard.js';
import { detectAllowlistDeadEntries } from './allowlist-dead-entry-detector.js';
import { auditStateTransitions } from './state-transition-audit.js';
import { auditTrapDoorCoverage } from './trap-door-coverage-audit.js';
import { checkEndpointContractConformance } from './endpoint-contract-conformance.js';
import { readRecoverableJsonObject } from '../recoverable-json.js';

interface FindingLike extends CitadelFinding {
  id: string;
  severity: CitadelSeverity;
  message?: string;
  [key: string]: unknown;
}

type DecisionRequired = AcShapeAuditReport['decisionsRequired'][number] | DivergenceDecisionRequired;

export interface CrossPhaseFinding extends FindingLike {
  source: 'anatomy-park' | 'szechuan-sauce';
  source_file: 'anatomy-park.json' | 'szechuan-sauce.json';
  original_id: string;
}

export interface CrossPhaseFindingsReport {
  findings: CrossPhaseFinding[];
  summary: {
    anatomy_park: number;
    szechuan_sauce: number;
    duplicate_ids_deduped: number;
    duplicate_ids_renamed: number;
    anatomy_park_missing: boolean;
  };
}

interface CrossPhaseReadResult extends CrossPhaseFindingsReport {
  szechuan_findings: CrossPhaseFinding[];
}

export interface CitadelAuditOptions {
  prdPath: string;
  diffRange: string;
  repoRoot?: string;
  sessionDir?: string;
  reportPath?: string;
  strict?: boolean;
}

export type CitadelAuditReport = CitadelRunResult;

export async function runCitadelAudit(options: CitadelAuditOptions): Promise<CitadelRunResult> {
  const report = buildCitadelAuditReport(options);
  if (!options.sessionDir && !options.reportPath) return report;

  const reportPath = options.reportPath ?? path.join(options.sessionDir ?? '', 'citadel_report.json');
  const lockKey = `citadel:${path.resolve(options.sessionDir ?? path.dirname(reportPath))}`;
  await withLock(lockKey, {}, async () => {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${stableJson(report.json)}\n`, 'utf-8');
  });
  return report;
}

export function buildCitadelAuditReport(options: CitadelAuditOptions): CitadelAuditReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const prdPath = path.resolve(repoRoot, options.prdPath);
  const prdMarkdown = readFileSync(prdPath, 'utf-8');
  // ticket 98dc9bed F3.1: parseWithComposes already handles PRDs without a
  // composes: front-matter block. Swallowing ComposesError here masks malformed
  // compose graphs and audits the wrong PRD scope.
  const parsedPrd = parseWithComposes(prdPath, { repoRoot });
  const diff = walkDiff(options.diffRange, { repoRoot });
  const projectShapes = detectProjectShapes(repoRoot);
  const siblingAuth = auditSiblingAuthPreconditions(diff);
  const frontendPropDrift = safeRunAnalyzer(
    'citadel-frontend-prop-drift',
    () => auditFrontendPropDrift(diff),
    { analyzerCompatibility: ['react-frontend'], projectShapes },
  );
  const acShape = auditAcShape({
    prdPath,
    sessionDir: options.sessionDir,
  });
  const ruleSetInvariants = auditRuleSetInvariants(diff, { repoRoot, prdMarkdown });
  const crossPhase = readCrossPhaseFindings(options.sessionDir);
  const crossPhaseReport: CrossPhaseFindingsReport = {
    findings: crossPhase.findings,
    summary: crossPhase.summary,
  };
  const diffHygiene = auditDiffHygiene(diff, { szechuanFindings: crossPhase.szechuan_findings });
  const divergenceReconciliation = reconcileDivergences(diff);
  const acCoverage = safeRunAnalyzer('citadel-ac-coverage', () =>
    buildAcCoverageScorecard(parsedPrd.acceptanceCriteria, diff, { repoRoot }));
  const allowlistDead = safeRunAnalyzer('citadel-allowlist-dead', () =>
    detectAllowlistDeadEntries(diff, { repoRoot }));
  const stateTransitions = safeRunAnalyzer('citadel-state-transitions', () =>
    auditStateTransitions(parsedPrd.transitionAuditRows, diff, { repoRoot }));
  const trapDoorCoverage = safeRunAnalyzer('citadel-trap-door', () =>
    auditTrapDoorCoverage(diff));
  const endpointContractConformance = safeRunAnalyzer(
    'citadel-endpoint-contract',
    () => checkEndpointContractConformance(parsedPrd.endpoints, parsedPrd.statusCodeRows, { repoRoot }),
    { analyzerCompatibility: ['nestjs-api'], projectShapes },
  );
  const decisionRequired: DecisionRequired[] = [
    ...acShape.decisionsRequired,
    ...divergenceReconciliation.decisionsRequired,
  ];
  const findings = uniqueFindings([
    ...siblingAuth.findings.map((finding) => withFindingSource(finding, 'sibling_auth_preconditions')),
    ...frontendPropDrift.findings.map((finding) => withFindingSource(finding, 'frontend_prop_drift')),
    ...acShape.findings.map((finding) => withFindingSource(finding, 'ac_shape')),
    ...ruleSetInvariants.findings.map((finding) => withFindingSource(finding, 'rule_set_invariants')),
    ...diffHygiene.findings.map((finding) => withFindingSource(finding, 'diff_hygiene')),
    ...crossPhaseReport.findings,
    ...acCoverage.findings.map((finding) => withFindingSource(finding as FindingLike, 'ac_coverage')),
    ...allowlistDead.findings.map((finding) => withFindingSource(finding as FindingLike, 'allowlist_dead')),
    ...stateTransitions.findings.map((finding) => withFindingSource(finding as FindingLike, 'state_transitions')),
    ...trapDoorCoverage.findings.map((finding) => withFindingSource(finding as FindingLike, 'trap_door_coverage')),
    ...endpointContractConformance.findings.map((finding) => withFindingSource(finding as FindingLike, 'endpoint_contract_conformance')),
  ]);
  const sections = {
    sibling_auth_preconditions: siblingAuth,
    frontend_prop_drift: frontendPropDrift,
    ac_shape: acShape,
    rule_set_invariants: ruleSetInvariants,
    diff_hygiene: diffHygiene,
    divergence_reconciliation: divergenceReconciliation,
    cross_phase: crossPhaseReport,
    ac_coverage: acCoverage,
    allowlist_dead: allowlistDead,
    state_transitions: stateTransitions,
    trap_door_coverage: trapDoorCoverage,
    endpoint_contract_conformance: endpointContractConformance,
  };
  const reporter = new Reporter();
  return reporter.build({
    prdPath,
    diffRange: options.diffRange,
    header: buildCitadelReportHeader(options.sessionDir),
    sections,
    findings,
    decisions: decisionRequired,
    strict: options.strict,
  }) as CitadelAuditReport;
}

function stableJson(value: CitadelJsonReport): string {
  return JSON.stringify(value, null, 2);
}

export function buildCitadelReportHeader(sessionDir: string | undefined): CitadelReportHeader {
  const fallback: CitadelReportHeader = {
    pickle_phase_failed: false,
    pickle_exit_code: null,
  };
  if (!sessionDir) return fallback;

  const statePath = path.join(sessionDir, 'state.json');
  let parsed: unknown;
  try {
    parsed = readRecoverableJsonObject(statePath);
  } catch {
    return fallback;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.activity)) return fallback;
  const pickleFailures = parsed.activity.filter((entry): entry is Record<string, unknown> => (
    isRecord(entry)
      && entry.event === 'recoverable_phase_failure'
      && entry.phase === 'pickle'
      && typeof entry.exit_code === 'number'
      && entry.exit_code !== 0
  ));
  if (pickleFailures.length === 0) return fallback;

  const lastFailure = pickleFailures[pickleFailures.length - 1];
  return {
    pickle_phase_failed: true,
    pickle_exit_code: lastFailure.exit_code as number,
  };
}

function readCrossPhaseFindings(sessionDir: string | undefined): CrossPhaseReadResult {
  const anatomyArtifact = readPhaseFindings(sessionDir, 'anatomy-park', 'anatomy-park.json');
  const anatomyFindings = anatomyArtifact.findings;
  const szechuanFindings = readPhaseFindings(sessionDir, 'szechuan-sauce', 'szechuan-sauce.json');
  const merged = dedupeCrossPhaseFindings([
    ...anatomyFindings,
    ...szechuanFindings.findings,
  ]);
  const findings = anatomyArtifact.missing
    ? [missingAnatomyParkFinding(), ...merged.findings]
    : merged.findings;

  return {
    findings,
    summary: {
      anatomy_park: anatomyFindings.length,
      szechuan_sauce: szechuanFindings.findings.length,
      duplicate_ids_deduped: merged.duplicates,
      duplicate_ids_renamed: 0,
      anatomy_park_missing: anatomyArtifact.missing,
    },
    szechuan_findings: szechuanFindings.findings,
  };
}

interface PhaseFindingsRead {
  findings: CrossPhaseFinding[];
  missing: boolean;
}

function readPhaseFindings(
  sessionDir: string | undefined,
  source: CrossPhaseFinding['source'],
  sourceFile: CrossPhaseFinding['source_file'],
): PhaseFindingsRead {
  if (!sessionDir) return { findings: [], missing: sourceFile === 'anatomy-park.json' };
  const artifactPath = path.join(sessionDir, sourceFile);
  if (!existsSync(artifactPath)) return { findings: [], missing: sourceFile === 'anatomy-park.json' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf-8')) as unknown;
  } catch {
    return { findings: [], missing: false };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return { findings: [], missing: false };
  const findings = parsed.findings.flatMap((finding): CrossPhaseFinding[] => {
    if (!isRecord(finding) || typeof finding.id !== 'string' || !isSeverity(finding.severity)) return [];
    return [{
      ...finding,
      id: finding.id,
      original_id: finding.id,
      severity: finding.severity,
      source,
      source_file: sourceFile,
    }];
  });
  return { findings, missing: false };
}

function missingAnatomyParkFinding(): CrossPhaseFinding {
  return {
    id: 'anatomy-park:missing',
    original_id: 'anatomy-park:missing',
    severity: 'Low',
    source: 'anatomy-park',
    source_file: 'anatomy-park.json',
    message: 'anatomy-park.json is absent; skipping Citadel pattern-replay safety-net input.',
  };
}

function dedupeCrossPhaseFindings(findings: CrossPhaseFinding[]): { findings: CrossPhaseFinding[]; duplicates: number } {
  const seen = new Set<string>();
  const deduped: CrossPhaseFinding[] = [];
  let duplicates = 0;
  for (const finding of findings) {
    if (seen.has(finding.original_id)) {
      duplicates += 1;
      continue;
    }
    seen.add(finding.original_id);
    deduped.push(finding);
  }
  return { findings: deduped, duplicates };
}

function uniqueFindings<T extends FindingLike>(findings: T[]): T[] {
  const seen = new Set<string>();
  return findings.map((finding) => {
    const id = uniqueFindingId(finding, seen);
    seen.add(id);
    return id === finding.id ? finding : { ...finding, id };
  });
}

function uniqueFindingId(finding: FindingLike, seen: Set<string>): string {
  if (!seen.has(finding.id)) return finding.id;
  const source = typeof finding.source === 'string'
    ? finding.source
    : typeof finding.source_section === 'string'
      ? finding.source_section
      : 'citadel';
  const base = `${source}:${finding.id}`;
  if (!seen.has(base)) return base;

  let suffix = 2;
  while (seen.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

function withFindingSource<T extends { id: string; severity: string }>(
  finding: T,
  sourceSection: string,
): FindingLike {
  return {
    ...finding,
    severity: isSeverity(finding.severity) ? finding.severity : 'Medium',
    source_section: sourceSection,
  };
}

function isSeverity(value: unknown): value is CitadelSeverity {
  return value === 'Critical' || value === 'High' || value === 'Medium' || value === 'Low';
}

interface AnalyzerErrorResult {
  findings: Array<{ id: string; severity: 'Low'; analyzer_threw: true; message: string }>;
  skipped: false;
}

export interface AnalyzerSkippedResult {
  findings: [];
  skipped: 'project_shape_mismatch';
  reason: string;
}

let _analyzerOverridesForTests: Map<string, () => { findings: unknown[] }> | null = null;

export function __setAnalyzerOverridesForTests(
  overrides: Map<string, () => { findings: unknown[] }> | null,
): void {
  _analyzerOverridesForTests = overrides;
}

interface ShapeGateOptions {
  analyzerCompatibility?: ProjectShape[] | null;
  projectShapes?: ProjectShape[];
}

function safeRunAnalyzer<T extends { findings: unknown[] }>(
  id: string,
  run: () => T,
  shapeOpts?: ShapeGateOptions,
): T | AnalyzerErrorResult | AnalyzerSkippedResult {
  if (shapeOpts?.analyzerCompatibility != null && shapeOpts.projectShapes) {
    const compatible = shapeOpts.analyzerCompatibility.some((s) => shapeOpts.projectShapes!.includes(s));
    if (!compatible) {
      const required = shapeOpts.analyzerCompatibility.join(', ');
      const detected = shapeOpts.projectShapes.join(', ');
      return {
        findings: [],
        skipped: 'project_shape_mismatch',
        reason: `analyzer requires [${required}]; detected project shapes: [${detected}]`,
      };
    }
  }
  const override = _analyzerOverridesForTests?.get(id);
  const fn = override ?? run;
  try {
    return fn() as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [{ id, severity: 'Low', analyzer_threw: true, message }], skipped: false };
  }
}
