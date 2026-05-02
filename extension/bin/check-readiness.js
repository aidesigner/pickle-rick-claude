#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { listLinearTicketFiles } from '../services/artifact-validation.js';
import { computeOneHop } from '../services/scope-resolver.js';
import { formatLocalDateKey, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
const SNAPSHOT_FILE = 'readiness_snapshot.json';
const READINESS_MAX_RECYCLE_CYCLES = 3;
const DEFAULT_HISTORY_LIMIT = 10;
const MACHINE_HINT_RE = /\b(\d+(?:\.\d+)?%?|exit\s+\d+|<\s*\d+|>\s*\d+|<=\s*\d+|>=\s*\d+|under\s+\d+|within\s+\d+|exact(?:ly)?|regex|matches?|JSON|field|file exists|writes?|emits?|test|describe\.each|node --test|npm test|tsc|eslint|table|input\/output)\b/i;
const PURE_PROSE_RE = /\b(must|should)\s+(?:be|feel)\s+(?:intuitive|performant|fast|easy|simple|clear|usable|nice|good|robust|reliable)\b/i;
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)\b/g;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_$][\w$]*\(\)/g;
const GIT_LS_FILES_TIMEOUT_MS = 30_000;
function usage() {
    console.error('Usage: node check-readiness.js --session-dir <dir> [--repo-root <dir>] [--manifest <file>] [--machinability-only] [--contract-only] [--history [--last N]] [--skip-readiness <reason>]');
    process.exit(1);
}
const SKIP_USAGE_MSG = '--skip-readiness requires a reason argument (e.g. --skip-readiness "bundle pre-validated by refinement team")';
const SKIP_USAGE_EXIT_CODE = 64;
function parseSkipReadiness(argv) {
    const skipIndex = argv.indexOf('--skip-readiness');
    if (skipIndex < 0)
        return undefined;
    const raw = argv[skipIndex + 1];
    if (raw === undefined || raw.startsWith('--') || raw.trim() === '') {
        process.stderr.write(`${SKIP_USAGE_MSG}\n`);
        process.exit(SKIP_USAGE_EXIT_CODE);
    }
    return raw;
}
function parseLast(argv) {
    const lastIndex = argv.indexOf('--last');
    if (lastIndex < 0)
        return DEFAULT_HISTORY_LIMIT;
    const rawLast = argv[lastIndex + 1];
    if (!rawLast || rawLast.startsWith('--'))
        usage();
    const last = Number.parseInt(rawLast, 10);
    if (!Number.isInteger(last) || last < 1)
        usage();
    return last;
}
function parseValueFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx < 0)
        return undefined;
    const value = argv[idx + 1];
    return value && !value.startsWith('--') ? value : undefined;
}
export function parseArgs(argv) {
    const sessionDir = parseValueFlag(argv, '--session-dir');
    if (!sessionDir)
        usage();
    const repoRoot = parseValueFlag(argv, '--repo-root') ?? process.cwd();
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        manifest: parseValueFlag(argv, '--manifest'),
        machinabilityOnly: argv.includes('--machinability-only'),
        contractOnly: argv.includes('--contract-only'),
        history: argv.includes('--history'),
        last: parseLast(argv),
        skipReadiness: parseSkipReadiness(argv),
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
function acceptanceCriterionVerifyPhase(ac) {
    return /\bverify_pre\b/i.test(ac) ? 'pre' : 'post';
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
function resolvePathRef(ref, repoRoot, ticketFile, sessionDir) {
    if (path.isAbsolute(ref) && fs.existsSync(ref))
        return true;
    const bases = [
        repoRoot,
        ticketFile ? path.dirname(ticketFile) : undefined,
        sessionDir,
    ].filter((base) => typeof base === 'string');
    return bases.some((base) => fs.existsSync(path.resolve(base, ref)));
}
function gitTrackedFiles(repoRoot) {
    const result = spawnSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: GIT_LS_FILES_TIMEOUT_MS,
    });
    if (result.status !== 0)
        return [];
    return result.stdout.split('\n').filter(Boolean);
}
function resolveSymbolRef(ref, repoRoot) {
    const normalized = ref.replace(/\(\)$/, '');
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length === 0)
        return false;
    const tracked = gitTrackedFiles(repoRoot).filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/(^|\/)tests?\//.test(file));
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
            if (acceptanceCriterionVerifyPhase(ac) === 'post')
                continue;
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
            if (ref.includes('/'))
                continue;
            const resolved = resolveSymbolRef(ref, repoRoot);
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
function parseFrontmatter(content) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    return match ? match[1] : '';
}
function readScalar(frontmatter, key) {
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
    if (!match)
        return undefined;
    const value = match[1].trim();
    if (value === '[]')
        return undefined;
    return value.replace(/^['"]|['"]$/g, '');
}
function readStringArray(frontmatter, key) {
    const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(frontmatter);
    if (inline) {
        return inline[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    const lines = frontmatter.split(/\r?\n/);
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
    if (index < 0)
        return [];
    const values = [];
    for (let i = index + 1; i < lines.length; i += 1) {
        const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
        if (!match)
            break;
        values.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
    return values;
}
function unquoteYamlish(value) {
    return value.trim().replace(/^['"]|['"]$/g, '');
}
function readNestedStringArray(frontmatter, parentKey, childKey) {
    const lines = frontmatter.split(/\r?\n/);
    const parentIndex = lines.findIndex((line) => new RegExp(`^${parentKey}:\\s*$`).test(line));
    if (parentIndex < 0)
        return [];
    const values = [];
    for (let i = parentIndex + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\S/.test(line))
            break;
        if (!new RegExp(`^\\s+${childKey}:\\s*$`).test(line))
            continue;
        for (let j = i + 1; j < lines.length; j += 1) {
            const item = lines[j];
            if (/^\s{2}\S/.test(item) && !/^\s{4,}-\s+/.test(item))
                break;
            const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(item);
            if (match)
                values.push(unquoteYamlish(match[1]));
        }
        break;
    }
    return values;
}
function dependencyRefs(content, frontmatter) {
    const refs = new Map();
    for (const dep of [...readStringArray(frontmatter, 'depends_on'), ...readStringArray(frontmatter, 'dependencies')]) {
        const external = /\bexternal\b/i.test(dep) || dep.startsWith('external:');
        refs.set(dep.replace(/^external:/, '').trim(), external);
    }
    for (const match of content.matchAll(/title:\s*["']?Depends on:\s*([^"'\n]+)["']?/gi)) {
        const raw = match[1].trim();
        const ref = raw.split(/\s+[—-]\s+|\s+\(/)[0]?.trim();
        if (!ref)
            continue;
        refs.set(ref, /\bexternal\b/i.test(raw));
    }
    return [...refs].map(([ref, external]) => ({ ref, external }));
}
function ticketInfo(ticketFile) {
    const content = fs.readFileSync(ticketFile, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const id = readScalar(frontmatter, 'id') ?? path.basename(path.dirname(ticketFile));
    const acIds = [
        ...readStringArray(frontmatter, 'ac_ids'),
        ...extractAcceptanceCriteria(content)
            .flatMap((ac) => [...ac.matchAll(/\b(?:AC-[A-Z0-9-]+|P\d+\.\d+|R\d+|T\d+)\b/g)].map((match) => match[0])),
    ];
    return {
        file: ticketFile,
        id,
        key: readScalar(frontmatter, 'key'),
        sourcePrd: readScalar(frontmatter, 'source_prd'),
        sourceSection: readScalar(frontmatter, 'source_section'),
        mappedRequirements: readStringArray(frontmatter, 'mapped_requirements'),
        acIds: [...new Set(acIds)].sort(),
        dependencies: dependencyRefs(content, frontmatter),
    };
}
function readJsonFile(file) {
    if (!file || !fs.existsSync(file))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.length > 0);
}
function resolvePeerPrdPath(parentPrdPath, peerPath, repoRoot) {
    if (path.isAbsolute(peerPath) && fs.existsSync(peerPath))
        return peerPath;
    const candidates = [
        path.resolve(path.dirname(parentPrdPath), peerPath),
        path.resolve(repoRoot, peerPath),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}
function sourceRequirementsFromParentPrd(parentPrdPath, repoRoot) {
    if (!parentPrdPath || !fs.existsSync(parentPrdPath))
        return [];
    const parentContent = fs.readFileSync(parentPrdPath, 'utf-8');
    const peerPaths = readNestedStringArray(parseFrontmatter(parentContent), 'peer_prds', 'deferred');
    const requirements = [];
    for (const peerPath of peerPaths) {
        const resolved = resolvePeerPrdPath(parentPrdPath, peerPath, repoRoot);
        if (!resolved)
            continue;
        const lines = fs.readFileSync(resolved, 'utf-8').split(/\r?\n/);
        let section = '';
        for (const line of lines) {
            const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
            if (heading)
                section = heading[1].trim();
            for (const match of line.matchAll(/\bAC-[A-Z0-9-]+\b/g)) {
                requirements.push({ sourcePrd: peerPath, sourceSection: section, requirementId: match[0] });
            }
        }
    }
    return requirements;
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => value.trim() !== ''))].sort();
}
function resolveManifestPrdPath(manifest, sessionDir, repoRoot) {
    if (!isRecord(manifest) || typeof manifest.prd_path !== 'string' || manifest.prd_path.trim() === '')
        return undefined;
    const prdPath = manifest.prd_path;
    if (path.isAbsolute(prdPath))
        return prdPath;
    const candidates = [
        path.resolve(repoRoot, prdPath),
        path.resolve(sessionDir, prdPath),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
function manifestTickets(manifest) {
    if (!isRecord(manifest) || !Array.isArray(manifest.tickets))
        return [];
    return manifest.tickets.filter(isRecord);
}
function manifestTicketFor(ticket, manifest) {
    return manifestTickets(manifest).find((entry) => entry.id === ticket.id || entry.key === ticket.key);
}
function sourceRequirementIndex(requirements) {
    const index = new Map();
    for (const requirement of requirements) {
        const existing = index.get(requirement.requirementId) ?? [];
        existing.push(requirement);
        index.set(requirement.requirementId, existing);
    }
    return index;
}
function enrichTickets(tickets, manifest, sourceRequirements) {
    const byRequirement = sourceRequirementIndex(sourceRequirements);
    return tickets.map((ticket) => {
        const manifestTicket = manifestTicketFor(ticket, manifest);
        const mappedRequirements = uniqueStrings([
            ...ticket.mappedRequirements,
            ...stringArray(manifestTicket?.mapped_requirements),
            ...stringArray(manifestTicket?.requirements),
            ...stringArray(manifestTicket?.ac_ids),
        ]);
        const acIds = uniqueStrings([...ticket.acIds, ...mappedRequirements]);
        const matches = acIds.flatMap((id) => byRequirement.get(id) ?? []);
        const sourcePrds = uniqueStrings(matches.map((match) => match.sourcePrd));
        const sourceSections = uniqueStrings(matches.map((match) => match.sourceSection));
        const inferredSourcePrd = sourcePrds.join(', ') || undefined;
        const inferredSourceSection = sourceSections.join(', ') || undefined;
        return {
            ...ticket,
            sourcePrd: ticket.sourcePrd ?? (typeof manifestTicket?.source_prd === 'string' ? manifestTicket.source_prd : undefined) ?? inferredSourcePrd,
            sourceSection: ticket.sourceSection ?? (typeof manifestTicket?.source_section === 'string' ? manifestTicket.source_section : undefined) ?? inferredSourceSection,
            mappedRequirements,
            acIds,
        };
    });
}
function manifestRequirementIds(manifest, sourceRequirements = []) {
    const ids = new Set();
    for (const req of sourceRequirements)
        ids.add(req.requirementId);
    if (!isRecord(manifest))
        return [...ids].sort();
    for (const req of stringArray(manifest.requirements))
        ids.add(req);
    if (isRecord(manifest.prd_requirements)) {
        for (const value of Object.values(manifest.prd_requirements)) {
            for (const req of stringArray(value))
                ids.add(req);
        }
    }
    for (const ticket of manifestTickets(manifest)) {
        for (const req of stringArray(ticket.requirements))
            ids.add(req);
    }
    return [...ids].sort();
}
function manifestRefs(manifest, tickets) {
    const refs = new Set(tickets.flatMap((ticket) => [ticket.id, ticket.key].filter((value) => Boolean(value))));
    for (const ticket of manifestTickets(manifest)) {
        if (typeof ticket.id === 'string')
            refs.add(ticket.id);
        if (typeof ticket.key === 'string')
            refs.add(ticket.key);
    }
    return refs;
}
function ticketRequirementIds(manifest, tickets) {
    const ids = new Set(tickets.flatMap((ticket) => [...ticket.acIds, ...ticket.mappedRequirements]));
    for (const ticket of manifestTickets(manifest)) {
        for (const ac of stringArray(ticket.ac_ids))
            ids.add(ac);
        for (const req of stringArray(ticket.requirements))
            ids.add(req);
    }
    return ids;
}
function findPrdMapFindings(tickets, manifest, sourceRequirements) {
    const mapped = ticketRequirementIds(manifest, tickets);
    return manifestRequirementIds(manifest, sourceRequirements)
        .filter((requirement) => !mapped.has(requirement))
        .map((requirement) => ({
        ticket: 'manifest',
        kind: 'prd_map',
        analyst: 'gaps',
        message: 'PRD requirement is not mapped to any ticket',
        detail: requirement,
    }));
}
function findPathFindings(ticket, repoRoot, sessionDir) {
    const content = fs.readFileSync(ticket.file, 'utf-8');
    const refs = new Set();
    for (const match of content.matchAll(PATH_RE))
        refs.add(match[0]);
    return [...refs].sort()
        .filter((ref) => !resolvePathRef(ref, repoRoot, ticket.file, sessionDir))
        .map((ref) => ({
        ticket: ticket.file,
        kind: 'file_path',
        analyst: 'codebase',
        message: 'Referenced ticket file path does not resolve',
        detail: ref,
    }));
}
function findDependencyFindings(ticket, refs) {
    return ticket.dependencies
        .filter((dep) => !dep.external && !refs.has(dep.ref))
        .map((dep) => ({
        ticket: ticket.file,
        kind: 'dependency',
        analyst: 'risk',
        message: 'Ticket dependency is not in the manifest and is not marked external',
        detail: dep.ref,
    }));
}
function displayTicketRef(sessionDir, ticket) {
    return path.isAbsolute(ticket) ? path.relative(sessionDir, ticket) : ticket;
}
function readState(sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath))
        return {};
    try {
        return new StateManager().read(statePath);
    }
    catch {
        return {};
    }
}
function writeState(sessionDir, state) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath))
        return;
    const sm = new StateManager();
    sm.update(statePath, (current) => {
        Object.assign(current, state);
    });
}
function readinessCycleHistory(state) {
    const history = state.readiness?.cycle_history;
    if (!Array.isArray(history))
        return [];
    return history.filter(isRecord).map((entry, index) => ({
        cycle: typeof entry.cycle === 'number' && Number.isFinite(entry.cycle) ? entry.cycle : index + 1,
        status: typeof entry.status === 'string' ? entry.status : '',
        suggested_analyst: typeof entry.suggested_analyst === 'string' ? entry.suggested_analyst : null,
        user_action: typeof entry.user_action === 'string' ? entry.user_action : null,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    }));
}
function readinessCycleCount(sessionDir, state) {
    if (Array.isArray(state.readiness?.cycle_history))
        return state.readiness.cycle_history.length;
    return fs.readdirSync(sessionDir).filter((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)).length;
}
function appendReadinessCycle(sessionDir, state, findings, escalated) {
    if (escalated)
        return;
    const existing = readinessCycleHistory(state);
    if (existing.length >= READINESS_MAX_RECYCLE_CYCLES)
        return;
    const next = {
        cycle: existing.length + 1,
        status: 'failed',
        suggested_analyst: findings[0]?.analyst ?? null,
        user_action: null,
        timestamp: new Date().toISOString(),
    };
    state.readiness = {
        ...(isRecord(state.readiness) ? state.readiness : {}),
        cycle_history: [...existing, next].slice(0, READINESS_MAX_RECYCLE_CYCLES),
    };
    writeState(sessionDir, state);
}
function hashFile(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readSnapshot(sessionDir) {
    const file = path.join(sessionDir, SNAPSHOT_FILE);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = readRecoverableJsonObject(file);
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
    writeStateFile(path.join(sessionDir, SNAPSHOT_FILE), snapshot);
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
function writeReport(sessionDir, tickets, findings, escalation) {
    const date = formatLocalDateKey(new Date());
    const filename = escalation ? `readiness_escalation_${date}.md` : `readiness_${date}.md`;
    const reportPath = path.join(sessionDir, filename);
    const prdMapRows = tickets.map((ticket) => `| ${ticket.id} | ${ticket.key ?? ''} | ${ticket.sourcePrd ?? ''} | ${ticket.sourceSection ?? ''} | ${uniqueStrings([...ticket.acIds, ...ticket.mappedRequirements]).join(', ')} |`);
    const acRows = tickets.flatMap((ticket) => extractAcceptanceCriteria(fs.readFileSync(ticket.file, 'utf-8')).map((ac) => {
        const status = acceptanceCriterionVerifyPhase(ac) === 'post' ? 'SKIP_POST' : isMachineCheckable(ac) ? 'PASS' : 'FAIL';
        return `| ${path.relative(sessionDir, ticket.file)} | ${status} | ${ac.replace(/\|/g, '\\|')} |`;
    }));
    const contractRows = findings
        .filter((finding) => finding.kind === 'contract')
        .map((finding) => `| ${displayTicketRef(sessionDir, finding.ticket)} | FAIL | ${finding.detail} | ${finding.analyst} |`);
    const lines = [
        `# ${escalation ? 'Readiness Escalation' : 'Readiness Failure'}`,
        '',
        `Date: ${date}`,
        '',
        '## PRD-ticket map',
        '',
        '| Ticket | Key | Source PRD | Source section | Mapped requirements |',
        '|---|---|---|---|---|',
        ...prdMapRows,
        ...findings.filter((finding) => finding.kind === 'prd_map').map((finding) => `| manifest |  |  |  | MISSING: ${finding.detail} |`),
        '',
        '## AC verifiability matrix',
        '',
        '| Ticket | Status | Criterion |',
        '|---|---|---|',
        ...acRows,
        '',
        '## Contract resolution table',
        '',
        '| Ticket | Status | Reference | Suggested analyst |',
        '|---|---|---|---|',
        ...(contractRows.length > 0 ? contractRows : ['| all | PASS |  |  |']),
        '',
        '## Findings',
        ...findings.map((finding) => [
            `- **${finding.kind}** in \`${displayTicketRef(sessionDir, finding.ticket)}\``,
            `  - suggested_analyst: ${finding.analyst}`,
            `  - ${finding.message}: \`${finding.detail}\``,
        ].join('\n')),
        '',
    ];
    fs.writeFileSync(reportPath, lines.join('\n'));
    return reportPath;
}
export function runReadiness(args) {
    const started = Date.now();
    const state = readState(args.sessionDir);
    const selected = selectTicketFiles(args.sessionDir, state);
    const checkMachinability = args.machinabilityOnly || !args.contractOnly;
    const checkContracts = args.contractOnly || !args.machinabilityOnly;
    const manifestPath = args.manifest ? path.resolve(args.sessionDir, args.manifest) : path.join(args.sessionDir, 'decomposition_manifest.json');
    const manifest = readJsonFile(fs.existsSync(manifestPath) ? manifestPath : args.manifest);
    const sourceRequirements = sourceRequirementsFromParentPrd(resolveManifestPrdPath(manifest, args.sessionDir, args.repoRoot), args.repoRoot);
    const tickets = enrichTickets(selected.files.map(ticketInfo), manifest, sourceRequirements);
    const refs = manifestRefs(manifest, tickets);
    const findings = [
        ...findPrdMapFindings(tickets, manifest, sourceRequirements),
        ...tickets.flatMap((ticket) => findPathFindings(ticket, args.repoRoot, args.sessionDir)),
        ...tickets.flatMap((ticket) => findDependencyFindings(ticket, refs)),
        ...selected.files.flatMap((file) => findReadinessFindings(file, args.repoRoot, { checkMachinability, checkContracts })),
    ];
    const ticketsVersion = getTicketsVersion(state);
    if (findings.length === 0) {
        writeSnapshot(args.sessionDir, listLinearTicketFiles(args.sessionDir), ticketsVersion);
        return { exitCode: 0, findings, delta: selected.delta, elapsed_ms: Date.now() - started };
    }
    const escalation = readinessCycleCount(args.sessionDir, state) >= READINESS_MAX_RECYCLE_CYCLES;
    const reportPath = writeReport(args.sessionDir, tickets, findings, escalation);
    appendReadinessCycle(args.sessionDir, state, findings, escalation);
    if (selected.delta) {
        logActivity({
            event: 'readiness_failed_post_correction',
            source: 'pickle',
            session: path.basename(args.sessionDir),
            gate_payload: { findings: findings.length, report: reportPath },
        });
    }
    return { exitCode: 2, findings, reportPath, delta: selected.delta, elapsed_ms: Date.now() - started };
}
export function runHistory(args) {
    const history = readinessCycleHistory(readState(args.sessionDir)).slice(-args.last);
    const rows = history.map((entry) => [
        entry.cycle,
        entry.status || '',
        entry.suggested_analyst ?? '',
        entry.user_action ?? '',
        entry.timestamp || '',
    ]);
    return [
        '| Cycle | Status | Suggested analyst | User action | Timestamp |',
        '|---:|---|---|---|---|',
        ...(rows.length > 0 ? rows.map((row) => `| ${row.join(' | ')} |`) : ['|  |  |  |  |  |']),
        '',
    ].join('\n');
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    try {
        if (args.history) {
            process.stdout.write(runHistory(args));
            process.exit(0);
        }
        if (args.skipReadiness !== undefined) {
            const reason = args.skipReadiness;
            logActivity({
                event: 'readiness_skipped',
                source: 'pickle',
                session: path.basename(args.sessionDir),
                gate_payload: { reason, timestamp: new Date().toISOString() },
            });
            process.stdout.write(`${JSON.stringify({ status: 'skipped', reason, elapsed_ms: 0 })}\n`);
            process.exit(0);
        }
        const result = runReadiness(args);
        process.stdout.write(`${JSON.stringify({
            status: result.exitCode === 0 ? 'pass' : 'fail',
            findings: result.findings,
            elapsed_ms: result.elapsed_ms,
            report: result.reportPath,
            delta: result.delta,
        })}\n`);
        if (result.reportPath)
            process.stderr.write(`readiness failed: ${result.reportPath}\n`);
        process.exit(result.exitCode);
    }
    catch (err) {
        process.stdout.write(`${JSON.stringify({
            status: 'error',
            findings: [],
            elapsed_ms: 0,
            error: safeErrorMessage(err),
        })}\n`);
        process.stderr.write(`check-readiness failed: ${safeErrorMessage(err)}\n`);
        process.exit(1);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-readiness.js') {
    main();
}
