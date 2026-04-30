import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { withLock } from '../state-manager.js';
import { auditSiblingAuthPreconditions, SiblingAuthAuditReport } from './sibling-auth-audit.js';
import { auditFrontendPropDrift, FrontendPropDriftReport } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';

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
  };
  summary: {
    findings: number;
    critical: number;
    high: number;
    medium: number;
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
  const findings = [...siblingAuth.findings, ...frontendPropDrift.findings];
  const critical = findings.filter((finding) => finding.severity === 'Critical').length;
  const high = findings.filter((finding) => finding.severity === 'High').length;
  const medium = findings.filter((finding) => finding.severity === 'Medium').length;
  const blockingFindings = critical + (options.strict ? high : 0);

  return {
    schema_version: '1.0',
    prd_path: path.resolve(repoRoot, options.prdPath),
    diff_range: options.diffRange,
    exit_code: blockingFindings > 0 ? 1 : 0,
    sections: {
      sibling_auth_preconditions: siblingAuth,
      frontend_prop_drift: frontendPropDrift,
    },
    summary: {
      findings: findings.length,
      critical,
      high,
      medium,
    },
  };
}

function stableJson(value: CitadelAuditReport): string {
  return JSON.stringify(value, null, 2);
}
