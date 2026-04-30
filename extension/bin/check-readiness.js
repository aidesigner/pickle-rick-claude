#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { listLinearTicketFiles } from '../services/artifact-validation.js';
import { computeOneHop } from '../services/scope-resolver.js';
import { formatLocalDateKey, safeErrorMessage } from '../services/pickle-utils.js';
const SNAPSHOT_FILE = 'readiness_snapshot.json';
const MACHINE_HINT_RE = /\b(\d+(?:\.\d+)?%?|exit\s+\d+|<\s*\d+|>\s*\d+|<=\s*\d+|>=\s*\d+|under\s+\d+|within\s+\d+|exact(?:ly)?|regex|matches?|JSON|field|file exists|writes?|emits?|test|describe\.each|node --test|npm test|tsc|eslint|table|input\/output)\b/i;
const PURE_PROSE_RE = /\b(must|should)\s+(?:be|feel)\s+(?:intuitive|performant|fast|easy|simple|clear|usable|nice|good|robust|reliable)\b/i;
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)\b/g;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_$][\w$]*\(\)/g;
function usage() {
    console.error('Usage: node check-readiness.js --session-dir <dir> [--repo-root <dir>] [--manifest <file>] [--machinability-only] [--contract-only]');
    process.exit(1);
}
function parseArgs(argv) {
    const sessionIndex = argv.indexOf('--session-dir');
    const repoIndex = argv.indexOf('--repo-root');
    const manifestIndex = argv.indexOf('--manifest');
    const sessionDir = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
    if (!sessionDir || sessionDir.startsWith('--'))
        usage();
    const repoRoot = repoIndex >= 0 && argv[repoIndex + 1] && !argv[repoIndex + 1].startsWith('--')
        ? argv[repoIndex + 1]
        : process.cwd();
    const manifest = manifestIndex >= 0 && argv[manifestIndex + 1] && !argv[manifestIndex + 1].startsWith('--')
        ? argv[manifestIndex + 1]
        : undefined;
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        manifest,
        machinabilityOnly: argv.includes('--machinability-only'),
        contractOnly: argv.includes('--contract-only'),
    };
}
export function extractAcceptanceCriteria(content) {
    const lines = content.split(/\r?\n/);
    const acs = [];
    let inSection = false;
    for (const line of lines) {
        if (/^##+\s+Acceptance Criteria\b/i.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && /^##+\s+/.test(line))
            break;
        if (!inSection)
            continue;
        const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
        if (match)
            acs.push(match[1]);
    }
    return acs;
}
export function isMachineCheckable(ac) {
    if (PURE_PROSE_RE.test(ac) && !MACHINE_HINT_RE.test(ac))
        return false;
    return MACHINE_HINT_RE.test(ac) || /\|.+\|/.test(ac) || /`[^`]+`/.test(ac);
}
export function extractContractReferences(content) {
    const refs = new Set();
    for (const match of content.matchAll(PATH_RE))
        refs.add(match[0]);
    for (const match of content.matchAll(/`([^`]+)`/g)) {
        const value = match[1].trim();
        if (PATH_RE.test(value))
            refs.add(value);
        PATH_RE.lastIndex = 0;
        if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value) || /^[A-Za-z_$][\w$]*\(\)$/.test(value))
            refs.add(value);
    }
    for (const match of content.matchAll(SYMBOL_RE))
        refs.add(match[0]);
    return [...refs]
        .filter((ref) => !ref.startsWith('AC-'))
        .filter((ref) => !refs.has(`${ref}()`))
        .sort();
}
function resolvePathRef(ref, repoRoot) {
    return fs.existsSync(path.resolve(repoRoot, ref));
}
function gitTrackedFiles(repoRoot) {
    const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' });
    if (result.status !== 0)
        return [];
    return result.stdout.split('\n').filter(Boolean);
}
function resolveSymbolRef(ref, repoRoot) {
    const normalized = ref.replace(/\(\)$/, '');
    const parts = normalized.split('.').filter(Boolean);
    const symbol = parts[parts.length - 1];
    if (!symbol)
        return false;
    const tracked = gitTrackedFiles(repoRoot).filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    const partPatterns = parts.map((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    const candidates = tracked.filter((file) => {
        try {
            const content = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
            return partPatterns.every((pattern) => pattern.test(content));
        }
        catch {
            return false;
        }
    });
    if (candidates.length === 0)
        return false;
    try {
        computeOneHop(candidates.slice(0, 1), repoRoot, { findImportersTimeoutMs: 30_000 });
        return true;
    }
    catch {
        return false;
    }
}
export function findReadinessFindings(ticketFile, repoRoot, opts) {
    const content = fs.readFileSync(ticketFile, 'utf-8');
    const findings = [];
    if (opts.checkMachinability) {
        for (const ac of extractAcceptanceCriteria(content)) {
            if (!isMachineCheckable(ac)) {
                findings.push({
                    ticket: ticketFile,
                    kind: 'machinability',
                    analyst: 'gaps',
                    message: 'Acceptance criterion is not machine-checkable',
                    detail: ac,
                });
            }
        }
    }
    if (opts.checkContracts) {
        for (const ref of extractContractReferences(content)) {
            const resolved = ref.includes('/') ? resolvePathRef(ref, repoRoot) : resolveSymbolRef(ref, repoRoot);
            if (!resolved) {
                findings.push({
                    ticket: ticketFile,
                    kind: 'contract',
                    analyst: 'codebase',
                    message: 'Referenced contract does not resolve',
                    detail: ref,
                });
            }
        }
    }
    return findings;
}
function readState(sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath))
        return {};
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch {
        return {};
    }
}
function readinessCycleCount(sessionDir, state) {
    if (Array.isArray(state.readiness?.cycle_history))
        return state.readiness.cycle_history.length;
    return fs.readdirSync(sessionDir).filter((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)).length;
}
function hashFile(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readSnapshot(sessionDir) {
    const file = path.join(sessionDir, SNAPSHOT_FILE);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return parsed && typeof parsed.hashes === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function writeSnapshot(sessionDir, ticketFiles, ticketsVersion) {
    const snapshot = {
        ticketsVersion,
        hashes: Object.fromEntries(ticketFiles.map((file) => [path.relative(sessionDir, file), hashFile(file)])),
    };
    fs.writeFileSync(path.join(sessionDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}
function getTicketsVersion(state) {
    return typeof state.tickets_version === 'number' ? state.tickets_version : undefined;
}
function selectTicketFiles(sessionDir, state) {
    const allFiles = listLinearTicketFiles(sessionDir);
    const snapshot = readSnapshot(sessionDir);
    const ticketsVersion = getTicketsVersion(state);
    const hasCorrection = Array.isArray(state.activity) && state.activity.some((entry) => entry.event === 'course_corrected');
    const delta = Boolean(snapshot && ticketsVersion !== undefined && snapshot.ticketsVersion !== ticketsVersion && hasCorrection);
    if (!delta || !snapshot)
        return { files: allFiles, delta: false };
    return {
        files: allFiles.filter((file) => snapshot.hashes[path.relative(sessionDir, file)] !== hashFile(file)),
        delta: true,
    };
}
function writeReport(sessionDir, findings, escalation) {
    const date = formatLocalDateKey(new Date());
    const filename = escalation ? `readiness_escalation_${date}.md` : `readiness_${date}.md`;
    const reportPath = path.join(sessionDir, filename);
    const lines = [
        `# ${escalation ? 'Readiness Escalation' : 'Readiness Failure'}`,
        '',
        `Date: ${date}`,
        '',
        '## Findings',
        ...findings.map((finding) => [
            `- **${finding.kind}** in \`${path.relative(sessionDir, finding.ticket)}\``,
            `  - suggested_analyst: ${finding.analyst}`,
            `  - ${finding.message}: \`${finding.detail}\``,
        ].join('\n')),
        '',
    ];
    fs.writeFileSync(reportPath, lines.join('\n'));
    return reportPath;
}
export function runReadiness(args) {
    const state = readState(args.sessionDir);
    const selected = selectTicketFiles(args.sessionDir, state);
    const checkMachinability = args.machinabilityOnly || !args.contractOnly;
    const checkContracts = args.contractOnly || !args.machinabilityOnly;
    const findings = selected.files.flatMap((file) => findReadinessFindings(file, args.repoRoot, { checkMachinability, checkContracts }));
    const ticketsVersion = getTicketsVersion(state);
    if (findings.length === 0) {
        writeSnapshot(args.sessionDir, listLinearTicketFiles(args.sessionDir), ticketsVersion);
        return { exitCode: 0, findings, delta: selected.delta };
    }
    const escalation = readinessCycleCount(args.sessionDir, state) >= 3;
    const reportPath = writeReport(args.sessionDir, findings, escalation);
    if (selected.delta) {
        logActivity({
            event: 'readiness_failed_post_correction',
            source: 'pickle',
            session: path.basename(args.sessionDir),
            gate_payload: { findings: findings.length, report: reportPath },
        });
    }
    return { exitCode: 2, findings, reportPath, delta: selected.delta };
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    try {
        const result = runReadiness(args);
        if (result.reportPath)
            process.stderr.write(`readiness failed: ${result.reportPath}\n`);
        process.exit(result.exitCode);
    }
    catch (err) {
        process.stderr.write(`check-readiness failed: ${safeErrorMessage(err)}\n`);
        process.exit(1);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-readiness.js') {
    main();
}
