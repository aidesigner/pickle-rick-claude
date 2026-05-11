import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../../lib/is-record.js';
import { withLock } from '../state-manager.js';
import { auditAcShape } from './ac-shape-audit.js';
import { auditSiblingAuthPreconditions } from './sibling-auth-audit.js';
import { auditFrontendPropDrift } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';
import { auditRuleSetInvariants } from './rule-set-invariant-audit.js';
import { auditDiffHygiene } from './diff-hygiene.js';
import { reconcileDivergences } from './divergence-reconciliation.js';
import { Reporter } from './reporter.js';
import { parsePrdMarkdown, parseWithComposes, ComposesError } from './prd-parser.js';
import { detectProjectShapes } from './project-shape.js';
import { buildAcCoverageScorecard } from './ac-coverage-scorecard.js';
import { detectAllowlistDeadEntries } from './allowlist-dead-entry-detector.js';
import { auditStateTransitions } from './state-transition-audit.js';
import { auditTrapDoorCoverage } from './trap-door-coverage-audit.js';
import { checkEndpointContractConformance } from './endpoint-contract-conformance.js';
export async function runCitadelAudit(options) {
    const report = buildCitadelAuditReport(options);
    if (!options.sessionDir && !options.reportPath)
        return report;
    const reportPath = options.reportPath ?? path.join(options.sessionDir ?? '', 'citadel_report.json');
    const lockKey = `citadel:${path.resolve(options.sessionDir ?? path.dirname(reportPath))}`;
    await withLock(lockKey, {}, async () => {
        mkdirSync(path.dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${stableJson(report.json)}\n`, 'utf-8');
    });
    return report;
}
export function buildCitadelAuditReport(options) {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    const prdPath = path.resolve(repoRoot, options.prdPath);
    const prdMarkdown = readFileSync(prdPath, 'utf-8');
    // ticket 98dc9bed F3.1: walk composes: chain so parsedPrd.composedRcodes
    // is populated for downstream analyzers. Failure on malformed composes:
    // paths falls through to the no-compose parse so audit-runner does not
    // regress on PRDs without composes: front-matter.
    let parsedPrd;
    try {
        parsedPrd = parseWithComposes(prdPath, { repoRoot });
    }
    catch (err) {
        if (!(err instanceof ComposesError))
            throw err;
        parsedPrd = parsePrdMarkdown(prdMarkdown);
    }
    const diff = walkDiff(options.diffRange, { repoRoot });
    const projectShapes = detectProjectShapes(repoRoot);
    const siblingAuth = auditSiblingAuthPreconditions(diff);
    const frontendPropDrift = safeRunAnalyzer('citadel-frontend-prop-drift', () => auditFrontendPropDrift(diff), { analyzerCompatibility: ['react-frontend'], projectShapes });
    const acShape = auditAcShape({
        prdPath,
        sessionDir: options.sessionDir,
    });
    const ruleSetInvariants = auditRuleSetInvariants(diff, { repoRoot, prdMarkdown });
    const crossPhase = readCrossPhaseFindings(options.sessionDir);
    const crossPhaseReport = {
        findings: crossPhase.findings,
        summary: crossPhase.summary,
    };
    const diffHygiene = auditDiffHygiene(diff, { szechuanFindings: crossPhase.szechuan_findings });
    const divergenceReconciliation = reconcileDivergences(diff);
    const acCoverage = safeRunAnalyzer('citadel-ac-coverage', () => buildAcCoverageScorecard(parsedPrd.acceptanceCriteria, diff, { repoRoot }));
    const allowlistDead = safeRunAnalyzer('citadel-allowlist-dead', () => detectAllowlistDeadEntries(diff, { repoRoot }));
    const stateTransitions = safeRunAnalyzer('citadel-state-transitions', () => auditStateTransitions(parsedPrd.transitionAuditRows, diff, { repoRoot }));
    const trapDoorCoverage = safeRunAnalyzer('citadel-trap-door', () => auditTrapDoorCoverage(diff));
    const endpointContractConformance = safeRunAnalyzer('citadel-endpoint-contract', () => checkEndpointContractConformance(parsedPrd.endpoints, parsedPrd.statusCodeRows, { repoRoot }), { analyzerCompatibility: ['nestjs-api'], projectShapes });
    const decisionRequired = [
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
        ...acCoverage.findings.map((finding) => withFindingSource(finding, 'ac_coverage')),
        ...allowlistDead.findings.map((finding) => withFindingSource(finding, 'allowlist_dead')),
        ...stateTransitions.findings.map((finding) => withFindingSource(finding, 'state_transitions')),
        ...trapDoorCoverage.findings.map((finding) => withFindingSource(finding, 'trap_door_coverage')),
        ...endpointContractConformance.findings.map((finding) => withFindingSource(finding, 'endpoint_contract_conformance')),
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
        sections,
        findings,
        decisions: decisionRequired,
        strict: options.strict,
    });
}
function stableJson(value) {
    return JSON.stringify(value, null, 2);
}
function readCrossPhaseFindings(sessionDir) {
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
function readPhaseFindings(sessionDir, source, sourceFile) {
    if (!sessionDir)
        return { findings: [], missing: sourceFile === 'anatomy-park.json' };
    const artifactPath = path.join(sessionDir, sourceFile);
    if (!existsSync(artifactPath))
        return { findings: [], missing: sourceFile === 'anatomy-park.json' };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    }
    catch {
        return { findings: [], missing: false };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.findings))
        return { findings: [], missing: false };
    const findings = parsed.findings.flatMap((finding) => {
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
    return { findings, missing: false };
}
function missingAnatomyParkFinding() {
    return {
        id: 'anatomy-park:missing',
        original_id: 'anatomy-park:missing',
        severity: 'Low',
        source: 'anatomy-park',
        source_file: 'anatomy-park.json',
        message: 'anatomy-park.json is absent; skipping Citadel pattern-replay safety-net input.',
    };
}
function dedupeCrossPhaseFindings(findings) {
    const seen = new Set();
    const deduped = [];
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
function isSeverity(value) {
    return value === 'Critical' || value === 'High' || value === 'Medium' || value === 'Low';
}
let _analyzerOverridesForTests = null;
export function __setAnalyzerOverridesForTests(overrides) {
    _analyzerOverridesForTests = overrides;
}
function safeRunAnalyzer(id, run, shapeOpts) {
    if (shapeOpts?.analyzerCompatibility != null && shapeOpts.projectShapes) {
        const compatible = shapeOpts.analyzerCompatibility.some((s) => shapeOpts.projectShapes.includes(s));
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
        return fn();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { findings: [{ id, severity: 'Low', analyzer_threw: true, message }], skipped: false };
    }
}
