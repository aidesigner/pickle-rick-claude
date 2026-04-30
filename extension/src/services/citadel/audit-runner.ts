import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { withLock } from '../state-manager.js';
import { auditAcShape, AcShapeAuditReport } from './ac-shape-audit.js';
import { auditSiblingAuthPreconditions, SiblingAuthAuditReport } from './sibling-auth-audit.js';
import { auditFrontendPropDrift, FrontendPropDriftReport } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';

type CitadelSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

interface FindingLike {
  id: string;
  severity: CitadelSeverity;
  message?: string;
  [key: string]: unknown;
}

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
    duplicate_ids_renamed: number;
  };
}

export interface CitadelAuditOptions {
  prdPath: string;
  diffRange: string;
  repoRoot?: string;
  sessionDir?: string;
  reportPath?: string;
  strict?: boolean;
}

export interface CitadelAuditReport {
  schema_version: '1.0';
  prd_path: string;
  diff_range: string;
  exit_code: number;
  sections: {
    sibling_auth_preconditions: SiblingAuthAuditReport;
    frontend_prop_drift: FrontendPropDriftReport;
    ac_shape: AcShapeAuditReport;
    cross_phase: CrossPhaseFindingsReport;
  };
  findings: FindingLike[];
  decision_required: AcShapeAuditReport['decisionsRequired'];
  summary: {
    findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    decision_required: number;
  };
}

export async function runCitadelAudit(options: CitadelAuditOptions): Promise<CitadelAuditReport> {
  const report = buildCitadelAuditReport(options);
  if (!options.sessionDir && !options.reportPath) return report;

  const reportPath = options.reportPath ?? path.join(options.sessionDir ?? '', 'citadel_report.json');
  const lockKey = `citadel:${path.resolve(options.sessionDir ?? path.dirname(reportPath))}`;
  await withLock(lockKey, {}, async () => {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${stableJson(report)}\n`, 'utf-8');
  });
  return report;
}

export function buildCitadelAuditReport(options: CitadelAuditOptions): CitadelAuditReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const diff = walkDiff(options.diffRange, { repoRoot });
  const siblingAuth = auditSiblingAuthPreconditions(diff);
  const frontendPropDrift = auditFrontendPropDrift(diff);
  const acShape = auditAcShape({
    prdPath: path.resolve(repoRoot, options.prdPath),
    sessionDir: options.sessionDir,
  });
  const crossPhase = readCrossPhaseFindings(options.sessionDir);
  const findings = uniqueFindings([
    ...siblingAuth.findings.map((finding) => withFindingSource(finding, 'sibling_auth_preconditions')),
    ...frontendPropDrift.findings.map((finding) => withFindingSource(finding, 'frontend_prop_drift')),
    ...acShape.findings.map((finding) => withFindingSource(finding, 'ac_shape')),
    ...crossPhase.findings,
  ]);
  const critical = findings.filter((finding) => finding.severity === 'Critical').length;
  const high = findings.filter((finding) => finding.severity === 'High').length;
  const medium = findings.filter((finding) => finding.severity === 'Medium').length;
  const low = findings.filter((finding) => finding.severity === 'Low').length;
  const strictDecisionFindings = options.strict ? acShape.decisionsRequired.length : 0;
  const blockingFindings = critical + (options.strict ? high : 0) + strictDecisionFindings;

  return {
    schema_version: '1.0',
    prd_path: path.resolve(repoRoot, options.prdPath),
    diff_range: options.diffRange,
    exit_code: blockingFindings > 0 ? 1 : 0,
    sections: {
      sibling_auth_preconditions: siblingAuth,
      frontend_prop_drift: frontendPropDrift,
      ac_shape: acShape,
      cross_phase: crossPhase,
    },
    findings,
    decision_required: acShape.decisionsRequired,
    summary: {
      findings: findings.length,
      critical,
      high,
      medium,
      low,
      decision_required: acShape.decisionsRequired.length,
    },
  };
}

function stableJson(value: CitadelAuditReport): string {
  return JSON.stringify(value, null, 2);
}

function readCrossPhaseFindings(sessionDir: string | undefined): CrossPhaseFindingsReport {
  const anatomyFindings = readPhaseFindings(sessionDir, 'anatomy-park', 'anatomy-park.json');
  const szechuanFindings = readPhaseFindings(sessionDir, 'szechuan-sauce', 'szechuan-sauce.json');
  const findings = uniqueFindings([...anatomyFindings, ...szechuanFindings]);

  return {
    findings,
    summary: {
      anatomy_park: findings.filter((finding) => finding.source === 'anatomy-park').length,
      szechuan_sauce: findings.filter((finding) => finding.source === 'szechuan-sauce').length,
      duplicate_ids_renamed: findings.filter((finding) => finding.id !== finding.original_id).length,
    },
  };
}

function readPhaseFindings(
  sessionDir: string | undefined,
  source: CrossPhaseFinding['source'],
  sourceFile: CrossPhaseFinding['source_file'],
): CrossPhaseFinding[] {
  if (!sessionDir) return [];
  const artifactPath = path.join(sessionDir, sourceFile);
  if (!existsSync(artifactPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf-8')) as unknown;
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return [];
  return parsed.findings.flatMap((finding): CrossPhaseFinding[] => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSeverity(value: unknown): value is CitadelSeverity {
  return value === 'Critical' || value === 'High' || value === 'Medium' || value === 'Low';
}
