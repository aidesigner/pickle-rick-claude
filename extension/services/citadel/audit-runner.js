import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
function stableJson(value) {
    return JSON.stringify(value, null, 2);
}
function readCrossPhaseFindings(sessionDir) {
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
function readPhaseFindings(sessionDir, source, sourceFile) {
    if (!sessionDir)
        return [];
    const artifactPath = path.join(sessionDir, sourceFile);
    if (!existsSync(artifactPath))
        return [];
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    }
    catch {
        return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.findings))
        return [];
    return parsed.findings.flatMap((finding) => {
        if (!isRecord(finding) || typeof finding.id !== 'string' || !isSeverity(finding.severity))
            return [];
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
function uniqueFindings(findings) {
    const seen = new Set();
    return findings.map((finding) => {
        const id = uniqueFindingId(finding, seen);
        seen.add(id);
        return id === finding.id ? finding : { ...finding, id };
    });
}
function uniqueFindingId(finding, seen) {
    if (!seen.has(finding.id))
        return finding.id;
    const source = typeof finding.source === 'string'
        ? finding.source
        : typeof finding.source_section === 'string'
            ? finding.source_section
            : 'citadel';
    const base = `${source}:${finding.id}`;
    if (!seen.has(base))
        return base;
    let suffix = 2;
    while (seen.has(`${base}:${suffix}`))
        suffix += 1;
    return `${base}:${suffix}`;
}
function withFindingSource(finding, sourceSection) {
    return {
        ...finding,
        severity: isSeverity(finding.severity) ? finding.severity : 'Medium',
        source_section: sourceSection,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isSeverity(value) {
    return value === 'Critical' || value === 'High' || value === 'Medium' || value === 'Low';
}
