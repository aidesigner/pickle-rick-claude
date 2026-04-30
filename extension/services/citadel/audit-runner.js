import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { withLock } from '../state-manager.js';
import { auditAcShape } from './ac-shape-audit.js';
import { auditSiblingAuthPreconditions } from './sibling-auth-audit.js';
import { auditFrontendPropDrift } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';
export async function runCitadelAudit(options) {
    const report = buildCitadelAuditReport(options);
    if (!options.sessionDir && !options.reportPath)
        return report;
    const reportPath = options.reportPath ?? path.join(options.sessionDir ?? '', 'citadel_report.json');
    const lockKey = `citadel:${path.resolve(options.sessionDir ?? path.dirname(reportPath))}`;
    await withLock(lockKey, {}, async () => {
        mkdirSync(path.dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${stableJson(report)}\n`, 'utf-8');
    });
    return report;
}
export function buildCitadelAuditReport(options) {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    const diff = walkDiff(options.diffRange, { repoRoot });
    const siblingAuth = auditSiblingAuthPreconditions(diff);
    const frontendPropDrift = auditFrontendPropDrift(diff);
    const acShape = auditAcShape({
        prdPath: path.resolve(repoRoot, options.prdPath),
        sessionDir: options.sessionDir,
    });
    const findings = [...siblingAuth.findings, ...frontendPropDrift.findings, ...acShape.findings];
    const critical = findings.filter((finding) => finding.severity === 'Critical').length;
    const high = findings.filter((finding) => finding.severity === 'High').length;
    const medium = findings.filter((finding) => finding.severity === 'Medium').length;
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
        },
        decision_required: acShape.decisionsRequired,
        summary: {
            findings: findings.length,
            critical,
            high,
            medium,
            decision_required: acShape.decisionsRequired.length,
        },
    };
}
function stableJson(value) {
    return JSON.stringify(value, null, 2);
}
