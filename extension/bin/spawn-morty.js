#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, runCmd, safeErrorMessage, parseTicketFrontmatter, getTicketTierBudgetWithOverrides, resolveWorkerTestGateTimeoutMs, } from '../services/pickle-utils.js';
import { spawn } from 'child_process';
import { PromiseTokens, hasToken, Defaults, hasLifecycleArtifact, BACKENDS } from '../types/index.js';
import { isRecord } from '../lib/is-record.js';
import { getDiffFiles, getHeadSha, listWorkingTreeDirtyPaths, resetToSha, updateTicketFrontmatter, updateTicketStatus } from '../services/git-utils.js';
import { assertBackendPreSpawn, buildWorkerInvocation, isBackend, backendEnvOverrides, resolveWorkerBackendFromState, resolveWorkerBackendFromStateFile } from '../services/backend-spawn.js';
import { scrubForbiddenWorkerTokens } from '../services/promise-tokens.js';
import { StateManager, writeActivityEntry } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { loadAgentMd } from '../services/agent-md-loader.js';
import { flushAndExit } from '../services/worker-shutdown.js';
import { autoFillCompletionCommit } from './auto-fill-completion-commit.js';
const TIER_MODEL_MAP = {
    trivial: 'haiku',
    small: 'sonnet',
    medium: 'sonnet',
    large: 'opus',
};
const sm = new StateManager();
const MIN_TIMEOUT_SECONDS = 30;
const VALID_AGENT_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const LAST_TOOL_ERROR_FILE = 'last-tool-error.json';
const HANDOFF_NOTES_FILE = 'handoff_notes.md';
const TOOL_RETRY_ANALYZE_THRESHOLD = 2;
const TOOL_RETRY_STOP_THRESHOLD = 4;
const COMPLETION_COMMIT_ACK_RE = /^COMPLETION_COMMIT_RECORDED:\s*([0-9a-f]{7,40})\s*$/gim;
export function tierToModel(tier) {
    if (!tier)
        return 'sonnet';
    return TIER_MODEL_MAP[tier] ?? 'sonnet';
}
function isAgentModel(value) {
    return typeof value === 'string' && VALID_AGENT_MODELS.has(value);
}
const PHASE_PERSONAS_DISABLED_MESSAGE = '[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on';
function readBasePersona(extensionRoot) {
    try {
        const personaPath = path.join(extensionRoot, 'persona.md');
        if (!fs.existsSync(personaPath))
            return '';
        return fs.readFileSync(personaPath, 'utf-8').trim();
    }
    catch {
        return '';
    }
}
function readPhasePersonaEntry(sessionRoot, extensionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        const step = state?.step;
        if (!step)
            return null;
        const configPath = path.join(extensionRoot, 'extension', 'data', 'phase-personas.json');
        const config = readRecoverableJsonObject(configPath);
        const rawEntry = config?.[step];
        if (!rawEntry || typeof rawEntry !== 'object')
            return null;
        const entry = rawEntry;
        const subagentType = entry.subagent_type;
        if (typeof subagentType !== 'string' || !subagentType.trim())
            return null;
        return {
            subagent_type: subagentType,
            ...(isAgentModel(entry.model) ? { model: entry.model } : {}),
        };
    }
    catch {
        return null;
    }
}
function readBmadHardeningSettings(extensionRoot) {
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        const hardening = settings?.bmad_hardening;
        return hardening && typeof hardening === 'object' && !Array.isArray(hardening)
            ? hardening
            : null;
    }
    catch {
        return null;
    }
}
export function isPhasePersonasEnabled(extensionRoot) {
    const envValue = process.env.PICKLE_PHASE_PERSONAS;
    if (envValue === 'on')
        return true;
    if (envValue === 'off')
        return false;
    const hardening = readBmadHardeningSettings(extensionRoot);
    return hardening?.phase_personas_enabled === true;
}
function hasSeenDisabledPhasePersonas(sessionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        return Array.isArray(state?.activity)
            && state.activity.some((entry) => entry.event === 'phase_personas_disabled_seen');
    }
    catch {
        return false;
    }
}
function recordPhasePersonasDisabledSeen(sessionRoot) {
    if (hasSeenDisabledPhasePersonas(sessionRoot))
        return;
    console.log(PHASE_PERSONAS_DISABLED_MESSAGE);
    writeActivityEntry(path.join(sessionRoot, 'state.json'), {
        event: 'phase_personas_disabled_seen',
        ts: new Date().toISOString(),
    });
}
function readActivePersonaBlock(opts) {
    try {
        const entry = readPhasePersonaEntry(opts.sessionRoot, opts.extensionRoot);
        if (!entry)
            return '';
        if (!isPhasePersonasEnabled(opts.extensionRoot)) {
            recordPhasePersonasDisabledSeen(opts.sessionRoot);
            return '';
        }
        const agent = loadAgentMd(entry.subagent_type, { agentsDir: opts.agentsDir });
        if (!agent)
            return '';
        const parts = [readBasePersona(opts.extensionRoot), agent.body.trim()].filter(Boolean);
        return parts.length > 0 ? `\n\n## Active Persona\n${parts.join('\n\n')}` : '';
    }
    catch {
        return '';
    }
}
export function resolvePhasePersonaModel(sessionRoot, extensionRoot) {
    if (!isPhasePersonasEnabled(extensionRoot))
        return undefined;
    return readPhasePersonaEntry(sessionRoot, extensionRoot)?.model;
}
export function resolveWorkerModelFromTierAndPersona(ticketTier, personaModel) {
    if (ticketTier)
        return tierToModel(ticketTier);
    return personaModel ?? 'sonnet';
}
function readProjectContextBlock(sessionRoot) {
    try {
        if (isArchaeologyDisabled(sessionRoot))
            return '';
        const projectContextPath = path.join(sessionRoot, 'project-context.md');
        if (!fs.existsSync(projectContextPath))
            return '';
        const projectContext = fs.readFileSync(projectContextPath, 'utf-8').trim();
        return projectContext ? `\n\n## Project Context\n${projectContext}` : '';
    }
    catch {
        return '';
    }
}
function isLastToolErrorState(value) {
    if (!isRecord(value))
        return false;
    return typeof value.ts === 'string'
        && typeof value.tool === 'string'
        && typeof value.error_signature === 'string'
        && typeof value.retry_count === 'number'
        && Number.isInteger(value.retry_count)
        && value.retry_count > 0;
}
function readLastToolErrorState(sessionRoot) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionRoot, LAST_TOOL_ERROR_FILE), 'utf-8'));
        return isLastToolErrorState(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function recordToolRetryCircuitOpen(sessionRoot, ticketId, toolError) {
    try {
        writeActivityEntry(path.join(sessionRoot, 'state.json'), {
            event: 'tool_retry_circuit_open',
            ts: new Date().toISOString(),
            source: 'pickle',
            session: path.basename(sessionRoot),
            ticket: ticketId,
            tool: toolError.tool,
            retry_count: toolError.retry_count,
            error_signature: toolError.error_signature,
        });
    }
    catch {
        /* fail open; guidance still reaches the worker */
    }
}
function buildToolRetryGuidanceBlock(ticket) {
    const toolError = readLastToolErrorState(ticket.sessionRoot);
    if (!toolError)
        return '';
    if (toolError.retry_count >= TOOL_RETRY_STOP_THRESHOLD) {
        recordToolRetryCircuitOpen(ticket.sessionRoot, ticket.ticketId, toolError);
        return `# TOOL RETRY CIRCUIT OPEN

STOP. You have hit the same ${toolError.tool} failure ${toolError.retry_count} times.
Do not retry the same command, edit, or test path again.
Use a completely different approach: inspect the failure cause, change the implementation strategy, reduce the repro, or choose another verification path before using the failing tool again.

`;
    }
    if (toolError.retry_count >= TOOL_RETRY_ANALYZE_THRESHOLD) {
        return `# TOOL RETRY GUIDANCE

You have hit the same ${toolError.tool} failure ${toolError.retry_count} times.
Analyze and fix the root cause before retrying. Do not repeat the same tool call until you can explain what changed and why it should succeed.

`;
    }
    return '';
}
function readHandoffNotesBlock(ticketPath) {
    try {
        const notesPath = path.join(ticketPath, HANDOFF_NOTES_FILE);
        if (!fs.existsSync(notesPath))
            return '';
        const notes = fs.readFileSync(notesPath, 'utf-8').trim();
        return notes ? `# PRIOR ITERATION HANDOFF\n${notes}\n\n` : '';
    }
    catch {
        return '';
    }
}
function isArchaeologyDisabled(sessionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        return state?.flags?.no_archaeology === true;
    }
    catch {
        return false;
    }
}
function die(message) {
    console.error(message);
    process.exit(1);
}
function requireFlagValue(args, index) {
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
        die('Error: --ticket-id and --ticket-path require non-empty values.');
    return value;
}
function parseTimeoutArg(argv) {
    const timeoutIndex = argv.indexOf('--timeout');
    if (timeoutIndex === -1)
        return Defaults.WORKER_TIMEOUT_SECONDS;
    const rawTimeout = argv[timeoutIndex + 1];
    if (!rawTimeout || !/^[1-9]\d*$/.test(rawTimeout)) {
        die(`Error: --timeout requires a positive integer, got: ${rawTimeout ?? 'missing'}`);
    }
    const parsed = Number(rawTimeout);
    if (!Number.isSafeInteger(parsed)) {
        die(`Error: --timeout requires a positive integer, got: ${rawTimeout}`);
    }
    return parsed;
}
function parseOutputFormatArg(argv) {
    const formatIndex = argv.indexOf('--output-format');
    const rawFormat = formatIndex !== -1 ? argv[formatIndex + 1] : undefined;
    return rawFormat && !rawFormat.startsWith('--') ? rawFormat : 'text';
}
function readTicketFileArg(argv) {
    const ticketFileIndex = argv.indexOf('--ticket-file');
    const rawTicketFile = ticketFileIndex !== -1 ? argv[ticketFileIndex + 1] : undefined;
    if (!rawTicketFile || rawTicketFile.startsWith('--') || !fs.existsSync(rawTicketFile)) {
        return { ticketFilePath: null, ticketContent: '' };
    }
    return { ticketFilePath: rawTicketFile, ticketContent: fs.readFileSync(rawTicketFile, 'utf-8') };
}
function normalizeTicketPath(ticketPath) {
    if (ticketPath.endsWith('.md') || (fs.existsSync(ticketPath) && fs.statSync(ticketPath).isFile())) {
        return path.dirname(ticketPath);
    }
    return ticketPath;
}
export function parseAndValidateArgs(argv) {
    if (argv.length < 1) {
        die('Usage: node spawn-morty.js <task> --ticket-id <id> --ticket-path <path> [--timeout <sec>] [--output-format <fmt>]');
    }
    const ticketIdIndex = argv.indexOf('--ticket-id');
    const ticketPathIndex = argv.indexOf('--ticket-path');
    if (ticketIdIndex === -1 || ticketPathIndex === -1) {
        die('Error: --ticket-id and --ticket-path are required.');
    }
    const ticketId = requireFlagValue(argv, ticketIdIndex);
    const ticketPath = normalizeTicketPath(requireFlagValue(argv, ticketPathIndex));
    if (!/^[a-zA-Z0-9_-]+$/.test(ticketId))
        die('Error: --ticket-id contains invalid characters.');
    const explicitTicketFile = readTicketFileArg(argv);
    const inferredTicketFilePath = explicitTicketFile.ticketFilePath ?? path.join(ticketPath, `linear_ticket_${ticketId}.md`);
    const ticketFilePath = fs.existsSync(inferredTicketFilePath) ? inferredTicketFilePath : null;
    const ticketContent = ticketFilePath ? fs.readFileSync(ticketFilePath, 'utf-8') : '';
    fs.mkdirSync(ticketPath, { recursive: true });
    return {
        ticket: argv[0],
        ticketId,
        ticketPath,
        ticketFilePath,
        ticketContent,
        sessionRoot: path.dirname(ticketPath),
        sessionLogPath: path.join(ticketPath, `worker_session_${process.pid}.log`),
        backend: 'claude',
        backendOverride: parseBackendOverrideArg(argv),
        timeout: parseTimeoutArg(argv),
        outputFormat: parseOutputFormatArg(argv),
        isReviewTicket: argv.includes('--review'),
    };
}
export function parseBackendOverrideArg(argv) {
    const idx = argv.indexOf('--backend');
    if (idx === -1)
        return null;
    const value = requireFlagValue(argv, idx);
    if (!isBackend(value)) {
        die(`Error: --backend must be one of claude, codex, hermes (got ${JSON.stringify(value)}).`);
    }
    return value;
}
export function resolveEffectiveTimeout(configuredTimeoutSec, parentState, wallClockNowMs) {
    const maxMins = Number(parentState?.max_time_minutes);
    const startEpoch = Number(parentState?.start_time_epoch);
    if (!Number.isFinite(maxMins) || maxMins <= 0 || !Number.isFinite(startEpoch) || startEpoch <= 0) {
        return configuredTimeoutSec;
    }
    const remaining = Math.floor(maxMins * 60 - (Math.floor(wallClockNowMs / 1000) - startEpoch));
    if (remaining <= 0)
        return Math.max(MIN_TIMEOUT_SECONDS, configuredTimeoutSec);
    if (remaining < configuredTimeoutSec)
        return Math.max(MIN_TIMEOUT_SECONDS, remaining);
    return configuredTimeoutSec;
}
export function buildWorkerPrompt(opts) {
    const { ticket } = opts;
    const extensionRoot = opts.extensionRoot ?? getExtensionRoot();
    const toolRetryGuidance = buildToolRetryGuidanceBlock(ticket);
    const handoffNotes = readHandoffNotesBlock(ticket.ticketPath);
    const promptFilename = ticket.isReviewTicket ? 'send-to-morty-review.md' : 'send-to-morty.md';
    const mortyPromptPath = path.join(os.homedir(), '.claude', 'commands', promptFilename);
    let workerPrompt;
    if (fs.existsSync(mortyPromptPath)) {
        workerPrompt = fs.readFileSync(mortyPromptPath, 'utf-8').replace(/\$ARGUMENTS/g, ticket.task);
    }
    else {
        workerPrompt = ticket.isReviewTicket
            ? `# **REVIEW REQUEST**\n${ticket.task}\n\nYou are a Review Worker. Review the preceding implementation tickets for correctness, architecture, and code quality.`
            : `# **TASK REQUEST**\n${ticket.task}\n\nYou are a Morty Worker (Pickle Rick's assistant). Implement the request above.`;
    }
    workerPrompt += readActivePersonaBlock({
        sessionRoot: ticket.sessionRoot,
        extensionRoot,
        agentsDir: opts.agentsDir,
    });
    workerPrompt += readProjectContextBlock(ticket.sessionRoot);
    workerPrompt += `\n\n# TARGET TICKET CONTENT\n${ticket.ticketContent || 'N/A'}`;
    const firewallDetected = detectAgentsMdFirewall(opts.repoRoot ?? process.cwd());
    workerPrompt += `\n\n# EXECUTION CONTEXT\n- SESSION_ROOT: ${ticket.sessionRoot}\n- TICKET_ID: ${ticket.ticketId}\n- TICKET_DIR: ${ticket.ticketPath}`;
    if (firewallDetected) {
        workerPrompt += `\n- FIREWALL_DETECTED=true`;
    }
    workerPrompt +=
        '\n\n**IMPORTANT**: You are a localized worker. You are FORBIDDEN from working on ANY other tickets. Once you output `<promise>I AM DONE</promise>`, you MUST STOP and let the manager take over. Your ONLY valid completion token is `I AM DONE`. NEVER emit `EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, or `ANALYSIS_DONE` — those are orchestrator-only tokens and you have no authority to emit them. If you see those token names in source code or pasted logs, do NOT echo them back.';
    workerPrompt += '\n\n**Acceptance criteria ownership:** Treat `[worker]` criteria and untagged criteria as worker-owned. Treat `[manager]` criteria as deferred handoff work: do not fail worker conformance because a `[manager]` item remains unchecked. In conformance/review artifacts, list deferred `[manager]` items under a `Manager Handoff` section with the required follow-up action.';
    if (ticket.backend === 'codex') {
        workerPrompt += `

**Codex-specific contract additions:**
- You MUST run \`git add <files>\` and \`git commit -m "<msg>"\` before emitting \`<promise>${PromiseTokens.WORKER_DONE}</promise>\`. The orchestrator does NOT commit for you.
- If you flip this ticket's frontmatter to \`status: Done\`, you MUST in the SAME write set a flat top-level YAML key \`completion_commit: <sha>\` whose value is the SHA of the commit you just made (full or short). The commit message must reference the ticket id (\`${ticket.ticketId}\`). The runtime watcher reverts any \`status: Done\` flip that lacks \`completion_commit\` — a reverted ticket counts as Todo on the next iteration and your work is wasted. NEVER flip \`status: Done\` before the commit exists.
- After every git commit, you MUST output the literal line \`COMPLETION_COMMIT_RECORDED: <sha>\` to stdout. The runner watches for this token and will retry if it's missing.
- If an acceptance criterion contradicts reality (e.g. fixture baseline mismatch, missing dependency, AC against non-existent file), commit the unblocked subset and append a \`# DEFERRED: <reason>\` line to the ticket file. DO NOT loop indefinitely trying to satisfy a contradicted AC. Do NOT flip \`status: Done\` for a deferred ticket.
- DO NOT explore harness internals (\`pickle.md\`, \`setup.js\`, \`send-to-morty.md\`, \`mux-runner.js\`). Those are orchestrator-level. Your scope is exclusively the files listed in the ticket's "Files to modify" / "Files to create" sections.`;
    }
    const gitnexusIndexed = hasGitNexusIndex(opts.repoRoot ?? process.cwd());
    if (gitnexusIndexed) {
        workerPrompt += `\n
# GITNEXUS CODE INTELLIGENCE (auto-detected)
This repo has a GitNexus knowledge graph index. Use these MCP tools during Research and Plan phases:
- **query()**: Find execution flows related to a concept (e.g., "auth validation logic")
- **context()**: 360-degree view of a symbol — callers, callees, process participation
- **impact()**: Blast radius analysis before modifying shared code
- **cypher()**: Custom graph queries (nodes: Function, Class, Method, File, Process, Community)

Prefer GitNexus tools over raw Grep/Glob for understanding call chains, dependencies, and execution flows.
For simple file/string lookups, Grep/Glob are still fine.`;
    }
    return `${toolRetryGuidance}${handoffNotes}${workerPrompt}`;
}
function hasGitNexusIndex(repoRoot) {
    try {
        return fs.statSync(path.join(repoRoot, '.gitnexus')).isDirectory();
    }
    catch {
        return false;
    }
}
function detectAgentsMdFirewall(workingDir) {
    const agentsPath = path.join(workingDir, 'AGENTS.md');
    if (!fs.existsSync(agentsPath))
        return false;
    try {
        const content = fs.readFileSync(agentsPath, 'utf-8');
        return /firewall|Stay inside the assigned working directory/i.test(content);
    }
    catch {
        return false;
    }
}
/**
 * P2: Post-flush guard helper. Returns true when the working dir has
 * uncommitted changes, staged changes, or commits whose committer date is
 * strictly greater than `sinceEpochSec`. Returns false on any error
 * (non-git dir, missing git binary, etc.) so the caller can fall through
 * to the original log-size heuristic for safe degradation.
 *
 * Uses `%ct` (committer epoch seconds) and a JS strict-greater comparison
 * because `git log --since=@<sec>` is not strictly greater-than — it can
 * include commits at the same second, leading to false positives when the
 * worker started immediately after a setup commit.
 */
export function checkGitEdits(workingDir, sinceEpochSec) {
    try {
        const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
        if (uncommitted.length > 0)
            return true;
        const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
        if (staged.length > 0)
            return true;
        // Inspect the last 10 commits' committer-epoch and accept iff any is
        // strictly greater than sinceEpochSec. 10 is a generous bound: a worker
        // that produced more than 10 commits is unambiguously productive.
        const cts = runCmd(['git', 'log', '-n', '10', '--pretty=format:%ct'], { cwd: workingDir, check: false });
        if (!cts)
            return false;
        // Accept commits whose committer-epoch is >= sinceEpochSec. The caller
        // is expected to subtract a small leniency before passing — see how
        // spawn-morty derives `startEpochSec` from `startTime` (Date.now()).
        for (const line of cts.split('\n')) {
            const ct = parseInt(line.trim(), 10);
            if (Number.isFinite(ct) && ct >= sinceEpochSec)
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
export function resolveWorkerGateTier(extensionRoot, settings) {
    const settingsBag = settings ?? (() => {
        try {
            return readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        }
        catch {
            return null;
        }
    })();
    const tier = settingsBag?.worker_gate_tier;
    if (tier === 'narrow' || tier === 'fast' || tier === 'full')
        return tier;
    if (tier !== undefined) {
        console.warn(`[spawn-morty] WARNING: invalid worker_gate_tier "${String(tier)}"; defaulting to "fast"`);
    }
    return 'fast';
}
function killProcessTree(proc, signal) {
    const pid = proc.pid;
    if (!pid)
        return false;
    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, signal);
            return true;
        }
        catch {
            // Fall back to the direct child if the process group is already gone.
        }
    }
    try {
        proc.kill(signal);
        return true;
    }
    catch {
        return false;
    }
}
async function runCommand(cmd, args, cwd, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    return await new Promise((resolve) => {
        const child = spawn(cmd, args, {
            cwd,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let timedOut = false;
        let settled = false;
        let sigtermSent = false;
        let sigkillSent = false;
        let killEscalation = null;
        const finalize = (status, signal, extraStderr = '') => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            const stdout = stdoutChunks.join('');
            const stderr = `${stderrChunks.join('')}${extraStderr}`;
            const timeoutMessage = timedOut
                ? [
                    `timed out after ${timeoutMs}ms`,
                    sigkillSent
                        ? 'sent SIGTERM to process tree and escalated to SIGKILL after 2000ms'
                        : sigtermSent
                            ? 'sent SIGTERM to process tree'
                            : 'failed to signal process tree',
                ].join('; ')
                : null;
            resolve({
                ok: status === 0 && !timedOut,
                status,
                stdout,
                stderr,
                signal,
                timedOut,
                timeoutMessage,
            });
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => stdoutChunks.push(chunk));
        child.stderr?.on('data', chunk => stderrChunks.push(chunk));
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            sigtermSent = killProcessTree(child, 'SIGTERM');
            killEscalation = setTimeout(() => {
                sigkillSent = killProcessTree(child, 'SIGKILL');
            }, 2000);
            killEscalation.unref();
        }, timeoutMs);
        timeoutHandle.unref();
        child.on('error', (error) => {
            const message = safeErrorMessage(error);
            finalize(null, null, message ? `${message}\n` : '');
        });
        child.on('close', (status, signal) => {
            finalize(status, signal);
        });
    });
}
function countLintErrors(output) {
    return (output.match(/\berror\b/gi) ?? []).length;
}
function countTscErrors(output) {
    return (output.match(/\berror TS\d+:/g) ?? []).length;
}
function buildFallbackGateFailure(name, file, message) {
    return [{ name, file, message }];
}
function normalizeTestFailureFile(locationValue, extensionDir) {
    const trimmed = locationValue.trim().replace(/^['"]|['"]$/g, '');
    const filePath = trimmed.replace(/:\d+:\d+$/, '');
    if (!path.isAbsolute(filePath))
        return filePath;
    const relativePath = path.relative(extensionDir, filePath);
    return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
        ? relativePath
        : filePath;
}
function parseWorkerGateTestFailures(output, extensionDir) {
    const failures = [];
    const lines = output.split(/\r?\n/);
    let activeFailure = null;
    const flushFailure = () => {
        if (!activeFailure)
            return;
        failures.push({
            name: activeFailure.name,
            file: activeFailure.file,
            message: activeFailure.message || activeFailure.name,
        });
        activeFailure = null;
    };
    for (const line of lines) {
        const failureStart = line.match(/^not ok(?:\s+\d+)?\s+-\s+(.+)$/);
        if (failureStart) {
            flushFailure();
            activeFailure = { name: failureStart[1].trim(), file: '', message: '' };
            continue;
        }
        if (!activeFailure)
            continue;
        if (line.trim() === '...') {
            flushFailure();
            continue;
        }
        const locationMatch = line.match(/location:\s*'([^']+)'/) ?? line.match(/location:\s*"([^"]+)"/);
        if (locationMatch && !activeFailure.file) {
            activeFailure.file = normalizeTestFailureFile(locationMatch[1], extensionDir);
            continue;
        }
        const errorMatch = line.match(/error:\s*'([^']+)'/) ?? line.match(/error:\s*"([^"]+)"/) ?? line.match(/error:\s*(.+)$/);
        if (errorMatch && !activeFailure.message) {
            activeFailure.message = errorMatch[1].trim();
        }
    }
    flushFailure();
    if (failures.length > 0)
        return failures;
    const fallbackMessage = lines.map(line => line.trim()).find(line => line.length > 0) ?? 'npm run test:fast failed';
    return [{
            name: 'npm run test:fast',
            file: '',
            message: fallbackMessage,
        }];
}
function parseWorkerGateLintFailures(output, extensionDir) {
    const failures = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(.+?):\d+:\d+:\s+(.+)$/);
        if (!match)
            continue;
        failures.push({
            name: 'eslint',
            file: normalizeTestFailureFile(match[1], extensionDir),
            message: match[2].trim(),
        });
    }
    if (failures.length > 0)
        return failures;
    const fallbackMessage = output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'eslint failed';
    return buildFallbackGateFailure('eslint', '', fallbackMessage);
}
function parseWorkerGateTscFailures(output, extensionDir) {
    const failures = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:\s+(.+)$/);
        if (!match)
            continue;
        failures.push({
            name: 'tsc',
            file: normalizeTestFailureFile(match[1], extensionDir),
            message: match[2].trim(),
        });
    }
    if (failures.length > 0)
        return failures;
    const fallbackMessage = output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'tsc failed';
    return buildFallbackGateFailure('tsc', '', fallbackMessage);
}
async function runWorkerGateTestCommand(scriptName, extensionDir, workerTestGateTimeoutMs) {
    const commandName = `npm run ${scriptName}`;
    const testResult = await runCommand('npm', ['run', scriptName], extensionDir, { timeoutMs: workerTestGateTimeoutMs });
    const failures = testResult.ok
        ? []
        : testResult.timedOut
            ? [{
                    name: '__timeout__',
                    file: commandName,
                    message: testResult.timeoutMessage ?? `killed after ${workerTestGateTimeoutMs}ms`,
                }]
            : parseWorkerGateTestFailures(`${testResult.stdout}\n${testResult.stderr}`, extensionDir);
    return {
        ok: testResult.ok,
        failures,
        gatePhase: scriptName,
    };
}
function collectChangedFilesForLintGate(workingDir, preWorkerHead) {
    const files = new Set();
    if (preWorkerHead) {
        try {
            const currentHead = getHeadSha(workingDir);
            for (const entry of getDiffFiles(preWorkerHead, currentHead, workingDir))
                files.add(entry.path);
        }
        catch { /* best-effort */ }
    }
    try {
        for (const file of listWorkingTreeDirtyPaths(workingDir))
            files.add(file);
    }
    catch { /* best-effort */ }
    return [...files].sort((left, right) => left.localeCompare(right));
}
function toExtensionLintTargets(workingDir, fileList) {
    return fileList
        .filter(file => file.startsWith('extension/src/')
        && /\.(?:[cm]?[jt]sx?)$/.test(file)
        && fs.existsSync(path.join(workingDir, file)))
        .map(file => file.replace(/^extension\//, ''));
}
function toRepoRelativePath(workingDir, targetPath) {
    const relativePath = path.relative(workingDir, targetPath);
    if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }
    return relativePath;
}
function stageAndCommitLintAutofix(workingDir, ticketId, fileList) {
    const dirtyPaths = listWorkingTreeDirtyPaths(workingDir).filter(file => fileList.includes(file));
    if (dirtyPaths.length === 0)
        return null;
    runCmd(['git', 'add', '--', ...dirtyPaths], { cwd: workingDir });
    runCmd(['git', 'commit', '-m', `fix(${ticketId}): worker lint autofix`, '--no-gpg-sign'], { cwd: workingDir });
    return getHeadSha(workingDir);
}
async function runWorkerGateChecks(args) {
    let lintOk = true;
    let lintErrors = 0;
    let gateFailures = [];
    let gatePhase = null;
    if (args.lintTargets.length > 0) {
        const lintResult = await runCommand('npx', ['eslint', ...args.lintTargets, '--max-warnings=-1'], args.extensionDir);
        const lintOutput = `${lintResult.stdout}\n${lintResult.stderr}`;
        lintErrors = countLintErrors(lintOutput);
        lintOk = lintResult.ok;
        if (!lintOk) {
            gatePhase = 'lint';
            gateFailures = parseWorkerGateLintFailures(lintOutput, args.extensionDir);
        }
    }
    const tscResult = await runCommand('npx', ['tsc', '--noEmit'], args.extensionDir);
    const tscOutput = `${tscResult.stdout}\n${tscResult.stderr}`;
    const tscErrors = countTscErrors(tscOutput);
    if (lintOk && !tscResult.ok) {
        gatePhase = 'tsc';
        gateFailures = parseWorkerGateTscFailures(tscOutput, args.extensionDir);
    }
    if (!lintOk || !tscResult.ok) {
        return {
            lintOk,
            tscOk: tscResult.ok,
            testsOk: true,
            lintErrors,
            tscErrors,
            testFailures: [],
            gateFailures,
            gatePhase,
        };
    }
    if (args.workerGateTier === 'narrow') {
        return {
            lintOk,
            tscOk: tscResult.ok,
            testsOk: true,
            lintErrors,
            tscErrors,
            testFailures: [],
            gateFailures,
            gatePhase,
        };
    }
    if (args.ticketTier === 'small') {
        return {
            lintOk,
            tscOk: tscResult.ok,
            testsOk: true,
            lintErrors,
            tscErrors,
            testFailures: [],
            gateFailures,
            gatePhase,
        };
    }
    const fastTierResult = await runWorkerGateTestCommand('test:fast', args.extensionDir, args.workerTestGateTimeoutMs);
    if (!fastTierResult.ok) {
        gatePhase = fastTierResult.gatePhase;
        gateFailures = fastTierResult.failures;
    }
    if (!fastTierResult.ok || args.workerGateTier !== 'full') {
        return {
            lintOk,
            tscOk: tscResult.ok,
            testsOk: fastTierResult.ok,
            lintErrors,
            tscErrors,
            testFailures: fastTierResult.failures,
            gateFailures,
            gatePhase,
        };
    }
    const integrationTierResult = await runWorkerGateTestCommand('test:integration', args.extensionDir, args.workerTestGateTimeoutMs);
    if (!integrationTierResult.ok) {
        gatePhase = integrationTierResult.gatePhase;
        gateFailures = integrationTierResult.failures;
    }
    return {
        lintOk,
        tscOk: tscResult.ok,
        testsOk: integrationTierResult.ok,
        lintErrors,
        tscErrors,
        testFailures: integrationTierResult.failures,
        gateFailures,
        gatePhase,
    };
}
function shouldRetryWorkerGate(lintOk, tscOk, lintTargetCount) {
    return (!lintOk || !tscOk) && lintTargetCount > 0;
}
function didWorkerGateFail(lintOk, tscOk, testsOk) {
    return !lintOk || !tscOk || !testsOk;
}
// TODO(R-LINT): refactor — pre-existing 123 lines / complexity 16 introduced
// 2026-05-11 (c5e7f92a7); extract per-phase helpers in a focused PR.
// eslint-disable-next-line max-lines-per-function, complexity -- HT-1 reviewed: pre-existing length/complexity tracked by R-LINT; per-phase helper extraction deferred to a focused refactor PR.
export async function runWorkerGate(changedFiles, args) {
    const fileList = [...changedFiles];
    const extensionDir = path.join(args.workingDir, 'extension');
    if (!fs.existsSync(extensionDir)) {
        return {
            ok: true,
            fileList,
            lintErrors: 0,
            tscErrors: 0,
            testFailures: [],
            gatePhase: null,
            retryCount: 0,
            autofixApplied: false,
            completionCommitSha: null,
        };
    }
    const lintTargets = toExtensionLintTargets(args.workingDir, fileList);
    const reportedFileList = lintTargets.length > 0
        ? lintTargets.map(target => `extension/${target}`)
        : fileList;
    let retryCount = 0;
    let autofixApplied = false;
    const workerGateTier = resolveWorkerGateTier(args.workingDir);
    const workerTestGateTimeoutMs = resolveWorkerTestGateTimeoutMs(args.workingDir);
    if (workerGateTier === 'narrow') {
        console.warn('[spawn-morty] worker gate tier downgraded to "narrow"; skipping test:fast and test:integration');
    }
    const skippedPhases = args.ticketTier === 'small'
        ? (workerGateTier === 'full' ? ['test:fast', 'test:integration'] : ['test:fast'])
        : [];
    if (skippedPhases.length > 0) {
        writeActivityEntry(args.statePath, {
            event: 'tier_phase_skipped',
            ticket_id: args.ticketId,
            tier: 'small',
            skipped_phases: skippedPhases,
            ts: new Date().toISOString(),
        });
    }
    let gateResult = await runWorkerGateChecks({
        lintTargets,
        extensionDir,
        workerTestGateTimeoutMs,
        workerGateTier,
        ticketTier: args.ticketTier,
    });
    let { lintOk, tscOk, testsOk } = gateResult;
    if (shouldRetryWorkerGate(lintOk, tscOk, lintTargets.length)) {
        autofixApplied = true;
        retryCount = 1;
        await runCommand('npx', ['eslint', '--fix', ...lintTargets, '--max-warnings=-1'], extensionDir);
        writeActivityEntry(args.statePath, {
            event: 'worker_lint_autofix_applied',
            ticket_id: args.ticketId,
            file_list: reportedFileList,
            ts: new Date().toISOString(),
        });
        gateResult = await runWorkerGateChecks({
            lintTargets,
            extensionDir,
            workerTestGateTimeoutMs,
            workerGateTier,
            ticketTier: args.ticketTier,
        });
        ({ lintOk, tscOk, testsOk } = gateResult);
    }
    if (didWorkerGateFail(lintOk, tscOk, testsOk)) {
        writeActivityEntry(args.statePath, {
            event: 'worker_gate_failed',
            ticket_id: args.ticketId,
            gate_phase: gateResult.gatePhase ?? (gateResult.lintErrors > 0 ? 'lint' : gateResult.tscErrors > 0 ? 'tsc' : 'test:fast'),
            failures: gateResult.gateFailures,
            retry_count: retryCount,
            ts: new Date().toISOString(),
        });
        if (args.preWorkerHead) {
            try {
                const preservePrefixes = (args.preservePaths ?? [])
                    .map(preservePath => toRepoRelativePath(args.workingDir, preservePath))
                    .filter((prefix) => prefix !== null);
                resetToSha(args.preWorkerHead, args.workingDir, preservePrefixes);
            }
            catch { /* best-effort */ }
        }
        return {
            ok: false,
            fileList,
            lintErrors: gateResult.lintErrors,
            tscErrors: gateResult.tscErrors,
            testFailures: gateResult.testFailures,
            gatePhase: gateResult.gatePhase,
            retryCount,
            autofixApplied,
            completionCommitSha: null,
        };
    }
    const completionCommitSha = autofixApplied
        ? stageAndCommitLintAutofix(args.workingDir, args.ticketId, fileList)
        : null;
    writeActivityEntry(args.statePath, {
        event: 'worker_lint_gate_passed',
        ticket_id: args.ticketId,
        file_list: reportedFileList,
        ts: new Date().toISOString(),
    });
    return {
        ok: true,
        fileList,
        lintErrors: gateResult.lintErrors,
        tscErrors: gateResult.tscErrors,
        testFailures: gateResult.testFailures,
        gatePhase: null,
        retryCount,
        autofixApplied,
        completionCommitSha,
    };
}
async function finalizeWorkerTurn(params) {
    const { ctx, exitCode, flushTimeout, startTime, resolve } = params;
    if (ctx.mutableState.finalized)
        return;
    ctx.mutableState.finalized = true;
    clearTimeout(flushTimeout);
    const { ticketId, sessionRoot, sessionLogPath, sessionWorkingDir } = ctx;
    const logContent = scrubWorkerLog(sessionLogPath, readWorkerLog(sessionLogPath));
    let { isSuccess } = evaluateWorkerOutcome({ ctx, logContent, startTime });
    let completionCommitSha = null;
    if (isSuccess) {
        const changedFiles = collectChangedFilesForLintGate(sessionWorkingDir, ctx.preWorkerHead);
        const workerGate = await runWorkerGate(changedFiles, {
            workingDir: sessionWorkingDir,
            ticketId,
            statePath: path.join(sessionRoot, 'state.json'),
            preWorkerHead: ctx.preWorkerHead,
            preservePaths: [sessionRoot],
            ticketTier: readTicketInfo(ctx.args.ticketFilePath)?.complexity_tier,
        });
        isSuccess = workerGate.ok;
        completionCommitSha = workerGate.completionCommitSha;
    }
    try {
        updateTicketFrontmatter(ticketId, sessionRoot, isSuccess
            ? { status: 'Done', completion_commit: completionCommitSha ?? getHeadSha(sessionWorkingDir) }
            : { status: 'Failed', completion_commit: null });
    }
    catch {
        /* best-effort */
    }
    if (isSuccess) {
        // R-CCC-2: Auto-fill completion_commit: for Done tickets that missed the ACK.
        try {
            autoFillCompletionCommit({
                sessionDir: sessionRoot,
                workingDir: sessionWorkingDir,
                ticketId,
                statePath: ctx.workerStatePath,
            });
        }
        catch {
            /* best-effort */
        }
    }
    printMinimalPanel('Worker Report', { status: ctx.mutableState.timedOut ? 'timeout' : `exit:${exitCode}`, validation: isSuccess ? 'successful' : 'failed' }, isSuccess ? 'GREEN' : 'RED', '🥒');
    if (!isSuccess) {
        // The worker log stream has already been ended in the proc.close path, so
        // waiting for flushAndExit() here can miss the close event and let Node
        // fall through with exit 0 after a failed worker gate.
        process.exit(1);
    }
    resolve({ exitCode: exitCode ?? 0, isSuccess });
}
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
function pickValidEffort(value) {
    return typeof value === 'string' && VALID_EFFORTS.has(value)
        ? value
        : undefined;
}
function readSessionRuntime(args) {
    const parentStatePath = path.join(args.sessionRoot, 'state.json');
    const workerStatePath = path.join(args.ticketPath, 'state.json');
    let timeoutStatePath = null;
    if (fs.existsSync(parentStatePath))
        timeoutStatePath = parentStatePath;
    else if (fs.existsSync(workerStatePath))
        timeoutStatePath = workerStatePath;
    try {
        const state = timeoutStatePath ? sm.read(timeoutStatePath) : null;
        const sessionWorkingDir = state?.working_dir?.trim() ? state.working_dir : process.cwd();
        const sessionEffort = pickValidEffort(state?.effort);
        return { timeoutStatePath, workerStatePath, state, sessionWorkingDir, sessionEffort };
    }
    catch {
        return { timeoutStatePath, workerStatePath, state: null, sessionWorkingDir: process.cwd() };
    }
}
function readStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const items = value
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim());
    return items.length > 0 ? items : undefined;
}
function readPositiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        return undefined;
    return value;
}
function readHermesWorkerOptions(state) {
    const record = state;
    if (!record)
        return {};
    return {
        toolsets: readStringArray(record.hermes_toolsets),
        ...(typeof record.hermes_provider === 'string' && record.hermes_provider.trim() ? { provider: record.hermes_provider } : {}),
        ...(typeof record.hermes_model === 'string' && record.hermes_model.trim() ? { model: record.hermes_model } : {}),
        maxTurns: readPositiveInteger(record.hermes_max_turns) ?? readPositiveInteger(record.max_iterations),
    };
}
function readTicketInfo(ticketFilePath) {
    try {
        return ticketFilePath ? parseTicketFrontmatter(ticketFilePath) : null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-morty] WARNING: ticket frontmatter parse failed: ${msg}`);
        return null;
    }
}
function deriveBaseSource(resolvedSource, state) {
    if (resolvedSource === 'env_lock')
        return 'refinement-lock';
    if (resolvedSource === 'worker_backend')
        return 'state';
    // resolvedSource === 'backend': state.backend was used if valid; otherwise env/default
    const raw = state ? state.backend : undefined;
    if (typeof raw === 'string' && BACKENDS.includes(raw)) {
        return 'state';
    }
    const env = process.env.PICKLE_BACKEND;
    if (typeof env === 'string' && BACKENDS.includes(env)) {
        return 'env';
    }
    return 'default';
}
function resolveWorkerBackendBase(sessionRoot) {
    const statePath = path.join(sessionRoot, 'state.json');
    let preloaded = null;
    try {
        preloaded = sm.read(statePath);
    }
    catch { /* use null fallback */ }
    const resolved = resolveWorkerBackendFromStateFile(statePath);
    return {
        backend: resolved.backend,
        source: deriveBaseSource(resolved.source, preloaded),
    };
}
/**
 * Variant of `resolveWorkerBackendBase` that takes an already-loaded `State`
 * object instead of re-reading the state file from disk. Each `_sm.read()`
 * call triggers `recoverable-json` tmp recovery which `readdirSync`'s the
 * state's data root; on macOS test fixtures rooted at `/var/folders/.../T`
 * (the system temp dir with 70k+ entries) that single readdir takes ~6.7s,
 * so the pre-spawn flow's cumulative reads can blow past the test's 45s
 * spawnSync timeout. Manager-spawn callers without a pre-loaded state still
 * use the file-reading variant above.
 */
function resolveWorkerBackendBaseFromState(state) {
    const resolved = resolveWorkerBackendFromState(state);
    return {
        backend: resolved.backend,
        source: deriveBaseSource(resolved.source, state),
    };
}
function applyHeuristicBackendRouting(sessionBackend, ticketInfo) {
    const { backend } = sessionBackend;
    let routedReason = null;
    try {
        const settings = readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'));
        if (settings?.enable_backend_routing_heuristic !== true || backend !== 'codex')
            return sessionBackend;
        routedReason = ticketInfo?.complexity_tier === 'large'
            ? 'complexity_tier=large'
            : ticketInfo?.title && /\b(UI|Wire|Audit)\b/i.test(ticketInfo.title) ? `title-signal:${ticketInfo.title}` : null;
    }
    catch { /* settings missing or unreadable: no override */ }
    if (!routedReason)
        return sessionBackend;
    console.error(`[spawn-morty] backend routed: codex → claude (reason: ${routedReason})`);
    return { backend: 'claude', source: 'settings' };
}
function routeBackend(sessionRoot, ticketInfo, backendOverride, preloadedState) {
    // Refinement lock is non-overridable. Preserves the
    // refinement-team-claude-only carve-out (R-XBL-2 spec).
    if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
        return { backend: 'claude', source: 'refinement-lock' };
    }
    // R-XBL-2: `--backend <name>` CLI flag wins over state/env/heuristic. The
    // caller emits a `worker_spawn_backend_override` activity event so the
    // bypass is auditable.
    if (backendOverride) {
        return { backend: backendOverride, source: 'cli-flag-override' };
    }
    // When the caller has already read state via StateManager, prefer the
    // in-memory variant to avoid a second `_sm.read()`. Each redundant read
    // re-runs `recoverable-json` tmp recovery (full `readdirSync` of the
    // data root) which is the dominant cost on macOS test fixtures rooted
    // in `/var/folders/.../T`.
    const base = preloadedState !== undefined
        ? resolveWorkerBackendBaseFromState(preloadedState)
        : resolveWorkerBackendBase(sessionRoot);
    return applyHeuristicBackendRouting(base, ticketInfo);
}
/**
 * Resolve the codex `-m <model>` flag for worker/manager spawns.
 *
 * Precedence:
 *   1. `state.codex_model` (trimmed, non-empty) — per-session override.
 *   2. `pickle_settings.default_codex_model` — global default.
 *   3. `undefined` — codex CLI falls back to its compiled-in default.
 *
 * Combined with `--ignore-user-config`, absent values mean codex never sees a
 * `-m` flag. This is a TRAP DOOR: see extension/CLAUDE.md
 * `src/bin/spawn-morty.ts (codex model resolution)`.
 */
export function resolveCodexModel(extensionRoot, state) {
    const stateModel = state?.codex_model;
    if (typeof stateModel === 'string' && stateModel.trim().length > 0) {
        return stateModel.trim();
    }
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        const settingsModel = settings?.default_codex_model;
        if (typeof settingsModel === 'string' && settingsModel.trim().length > 0) {
            return settingsModel.trim();
        }
    }
    catch { /* settings missing or unreadable: codex CLI default */ }
    return undefined;
}
function resolveWorkerModel(backend, extensionRoot, sessionRoot, ticketInfo, state) {
    if (backend === 'codex')
        return resolveCodexModel(extensionRoot, state);
    if (backend !== 'claude')
        return undefined;
    let enableComplexityTiers = true;
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        if (settings?.enable_complexity_tiers === false)
            enableComplexityTiers = false;
    }
    catch { /* default true */ }
    try {
        const personaModel = resolvePhasePersonaModel(sessionRoot, extensionRoot);
        return enableComplexityTiers
            ? resolveWorkerModelFromTierAndPersona(ticketInfo?.complexity_tier, personaModel)
            : 'sonnet';
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-morty] WARNING: complexity tier subsystem failed: ${msg}`);
        return 'sonnet';
    }
}
function readWorkerLog(sessionLogPath) {
    try {
        return fs.readFileSync(sessionLogPath, 'utf-8');
    }
    catch (err) {
        console.error(`${Style.YELLOW}⚠️  Could not read worker log: ${safeErrorMessage(err)}${Style.RESET}`);
        return '';
    }
}
function scrubWorkerLog(sessionLogPath, logContent) {
    if (!logContent)
        return logContent;
    const scrub = scrubForbiddenWorkerTokens(logContent);
    const replacedTokens = Object.keys(scrub.replacements);
    if (replacedTokens.length === 0)
        return logContent;
    const summary = replacedTokens.map(t => `${t}=${scrub.replacements[t]}`).join(', ');
    console.error(`${Style.YELLOW}⚠️  Worker emitted forbidden orchestrator token(s) — scrubbed to ${PromiseTokens.WORKER_DONE}: ${summary}${Style.RESET}`);
    try {
        fs.writeFileSync(sessionLogPath, scrub.scrubbed, 'utf-8');
    }
    catch (err) {
        console.error(`${Style.YELLOW}⚠️  Could not persist scrubbed worker log: ${safeErrorMessage(err)}${Style.RESET}`);
    }
    return scrub.scrubbed;
}
function readTicketFiles(ticketPath) {
    try {
        return fs.readdirSync(ticketPath);
    }
    catch {
        return [];
    }
}
function buildValidationFailureReasons(checks) {
    return [
        checks.timedOut ? 'timeout' : null,
        !checks.tokenPresent ? 'no WORKER_DONE token' : null,
        !checks.hasArtifact ? `no ${checks.role} lifecycle artifact` : null,
        (!checks.logNonTrivial && !checks.hasEdits) ? `log ${checks.logContentLength}B < 200B and no git edits` : null,
    ].filter(Boolean).join(', ');
}
function bestEffortFdatasync(logPath) {
    try {
        const fd = fs.openSync(logPath, 'a');
        fs.fdatasyncSync(fd);
        fs.closeSync(fd);
    }
    catch { /* best-effort */ }
}
function attachCompletionCommitAckListener(proc, ticketId, workerActivityStatePath) {
    // R-CCC-1: Detect COMPLETION_COMMIT_RECORDED: <sha> token in worker stdout.
    let ackLineBuf = '';
    proc.stdout?.on('data', (chunk) => {
        ackLineBuf += chunk.toString('utf8');
        const newlineIdx = ackLineBuf.lastIndexOf('\n');
        if (newlineIdx < 0)
            return;
        const toScan = ackLineBuf.slice(0, newlineIdx + 1);
        ackLineBuf = ackLineBuf.slice(newlineIdx + 1);
        COMPLETION_COMMIT_ACK_RE.lastIndex = 0;
        const match = COMPLETION_COMMIT_ACK_RE.exec(toScan);
        if (match?.[1]) {
            try {
                writeActivityEntry(workerActivityStatePath, {
                    event: 'worker_completion_commit_announced',
                    source: 'pickle',
                    ticket_id: ticketId,
                    sha: match[1],
                    ts: new Date().toISOString(),
                });
            }
            catch { /* best-effort */ }
        }
    });
}
function evaluateWorkerOutcome(params) {
    const { ctx, logContent, startTime } = params;
    const role = ctx.args.isReviewTicket ? 'review' : 'implementation';
    const ticketFiles = readTicketFiles(ctx.ticketPath);
    const tokenPresent = hasToken(logContent, PromiseTokens.WORKER_DONE);
    const logNonTrivial = logContent.length > 200;
    const hasArtifact = hasLifecycleArtifact(ticketFiles, role);
    const hasEdits = checkGitEdits(ctx.sessionWorkingDir, Math.floor(startTime / 1000));
    const isSuccess = !ctx.mutableState.timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits);
    if (!isSuccess) {
        const reasons = buildValidationFailureReasons({
            timedOut: ctx.mutableState.timedOut, tokenPresent, hasArtifact, role,
            logContentLength: logContent.length, logNonTrivial, hasEdits,
        });
        console.error(`${Style.RED}Worker validation failed: ${reasons}${Style.RESET}`);
    }
    return { isSuccess, role };
}
export async function runWorkerProcess(ctx) {
    const { args, ticketPath, ticketId, sessionRoot, sessionLog, sessionLogPath, sessionWorkingDir } = ctx;
    const invocation = buildWorkerInvocation(args.backend, {
        prompt: ctx.prompt,
        addDirs: [getExtensionRoot(), getDataRoot(), sessionWorkingDir, ticketPath],
        model: ctx.model,
        outputFormat: args.outputFormat,
        effort: ctx.effort,
        ...(args.backend === 'hermes' ? ctx.hermesOptions : {}),
    });
    try {
        updateTicketStatus(ticketId, 'In Progress', sessionRoot);
    }
    catch { /* best-effort */ }
    sessionLog.on('error', err => console.error(`${Style.RED}❌ Log stream error: ${safeErrorMessage(err)}${Style.RESET}`));
    const env = { ...process.env, ...backendEnvOverrides(args.backend), PICKLE_STATE_FILE: ctx.timeoutStatePath || ctx.workerStatePath, PICKLE_ROLE: 'worker', PYTHONUNBUFFERED: '1' };
    delete env['CLAUDECODE'];
    const proc = spawn(invocation.cmd, invocation.args, { cwd: sessionWorkingDir, env, stdio: ['inherit', 'pipe', 'pipe'] });
    proc.stdout?.pipe(sessionLog, { end: false });
    proc.stderr?.pipe(sessionLog, { end: false });
    attachCompletionCommitAckListener(proc, ticketId, path.join(sessionRoot, 'state.json'));
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let idx = 0;
    const startTime = Date.now();
    const interval = setInterval(() => {
        if (!process.stdout.isTTY)
            return;
        const spinChar = spinner[idx % spinner.length];
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        process.stdout.write(`\r   ${Style.CYAN}${spinChar}${Style.RESET} Worker Active... ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`);
        idx++;
    }, 100);
    let killEscalation = null;
    const timeoutHandle = setTimeout(() => {
        ctx.mutableState.timedOut = true;
        console.log(`\n${Style.RED}❌ Worker timed out after ${Math.floor(ctx.effectiveTimeoutMs / 1000)}s${Style.RESET}`);
        try {
            proc.kill('SIGTERM');
        }
        catch { /* already dead */ }
        killEscalation = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { /* already dead */ }
        }, 2000);
    }, ctx.effectiveTimeoutMs);
    const hangGuard = setTimeout(async () => {
        console.error(`${Style.RED}❌ Worker hang detected — forcing exit${Style.RESET}`);
        bestEffortFdatasync(sessionLogPath);
        try {
            updateTicketStatus(ticketId, 'Failed', sessionRoot);
        }
        catch { /* best-effort */ }
        await flushAndExit(sessionLog, 1);
    }, ctx.effectiveTimeoutMs + 30_000);
    hangGuard.unref();
    return new Promise(resolve => {
        let spawnErrorHandled = false;
        const clearLifecycleTimers = () => {
            clearInterval(interval);
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            if (process.stdout.isTTY)
                process.stdout.write('\r\x1b[K');
        };
        proc.on('error', async (err) => {
            spawnErrorHandled = true;
            clearLifecycleTimers();
            const errorCode = err.code;
            const exitCode = (args.backend === 'hermes' && errorCode === 'ENOENT') ? 127 : 1;
            if (args.backend === 'hermes' && errorCode === 'ENOENT') {
                sessionLog.write(JSON.stringify({
                    event: 'hermes_binary_missing',
                    ts: new Date().toISOString(),
                    ticket: ticketId,
                    backend: args.backend,
                    command: invocation.cmd,
                }) + '\n');
            }
            console.error(`${Style.RED}[pickle-rick] Failed to spawn '${invocation.cmd}' (backend=${args.backend}): ${safeErrorMessage(err)}${Style.RESET}`);
            try {
                updateTicketStatus(ticketId, 'Failed', sessionRoot);
            }
            catch { /* best-effort */ }
            printMinimalPanel('Worker Report', { status: 'spawn-error', validation: 'failed' }, 'RED', '🥒');
            await flushAndExit(sessionLog, exitCode);
        });
        proc.on('close', code => {
            // When spawn fails with ENOENT, node emits both 'error' and 'close' events.
            // The 'error' handler owns the exit semantics (e.g. 127 for hermes missing);
            // skip the normal close flow so it cannot race ahead with `process.exit(1)`.
            if (spawnErrorHandled)
                return;
            clearLifecycleTimers();
            const flushTimeout = setTimeout(() => {
                console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
                finalize(code);
            }, 5000);
            sessionLog.once('finish', () => {
                clearTimeout(flushTimeout);
                finalize(code);
            });
            sessionLog.end();
            async function finalize(exitCode) {
                await finalizeWorkerTurn({ ctx, exitCode, flushTimeout, startTime, resolve });
            }
        });
    });
}
async function main() {
    const parsed = parseAndValidateArgs(process.argv.slice(2));
    const runtime = readSessionRuntime(parsed);
    const ticketInfo = readTicketInfo(parsed.ticketFilePath);
    const requestedTimeout = ticketInfo
        ? getTicketTierBudgetWithOverrides(runtime.state, ticketInfo.complexity_tier).worker_timeout_seconds
        : parsed.timeout;
    const effectiveTimeout = resolveEffectiveTimeout(requestedTimeout, runtime.state, Date.now());
    if (runtime.state && effectiveTimeout > requestedTimeout) {
        console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
    }
    else if (effectiveTimeout < requestedTimeout) {
        console.log(`${Style.YELLOW}⚠️  Worker timeout clamped: ${effectiveTimeout}s${Style.RESET}`);
    }
    const statePath = path.join(parsed.sessionRoot, 'state.json');
    // Reuse `runtime.state` (already loaded via `_sm.read()` in `readSessionRuntime`)
    // for downstream backend resolution. Each fresh `_sm.read()` re-runs
    // `recoverable-json` tmp recovery, which `readdirSync`'s the data root;
    // on macOS test fixtures landing in `/var/folders/.../T` (~70k entries)
    // a single readdir is ~6.7s and the pre-spawn flow used to do three of them.
    const workerBackendResolution = resolveWorkerBackendFromState(runtime.state);
    const { backend, source } = routeBackend(parsed.sessionRoot, ticketInfo, parsed.backendOverride, runtime.state);
    const preSpawn = assertBackendPreSpawn({
        statePath,
        resolvedBackend: backend,
        source,
    });
    if (preSpawn.mode === 'mismatch') {
        try {
            writeActivityEntry(path.join(parsed.sessionRoot, 'state.json'), {
                event: 'worker_spawn_backend_mismatch',
                ts: new Date().toISOString(),
                source,
                pid: process.pid,
                ticket: parsed.ticketId,
                session: path.basename(parsed.sessionRoot),
                resolved_backend: preSpawn.resolvedBackend,
                state_backend: preSpawn.stateBackend,
            });
        }
        catch {
            /* best-effort telemetry */
        }
        console.error(`[spawn-morty] backend mismatch: resolved=${preSpawn.resolvedBackend}, state=${preSpawn.stateBackend}; aborting worker spawn`);
        process.exit(1);
    }
    try {
        writeActivityEntry(statePath, {
            event: 'worker_backend_resolved',
            ts: new Date().toISOString(),
            ticket_id: parsed.ticketId,
            backend: workerBackendResolution.managerBackend,
            worker_backend: workerBackendResolution.workerBackend,
            source: workerBackendResolution.source,
        });
        writeActivityEntry(statePath, {
            event: 'worker_spawn_backend_resolved',
            ts: new Date().toISOString(),
            backend,
            source,
            pid: process.pid,
            ticket: parsed.ticketId,
            session: path.basename(parsed.sessionRoot),
        });
        if (source === 'cli-flag-override' && parsed.backendOverride) {
            writeActivityEntry(statePath, {
                event: 'worker_spawn_backend_override',
                ts: new Date().toISOString(),
                backend: parsed.backendOverride,
                source,
                pid: process.pid,
                ticket: parsed.ticketId,
                session: path.basename(parsed.sessionRoot),
            });
        }
    }
    catch {
        /* best-effort telemetry */
    }
    const args = { ...parsed, backend };
    const extensionRoot = getExtensionRoot();
    const model = resolveWorkerModel(backend, extensionRoot, parsed.sessionRoot, ticketInfo, runtime.state);
    printMinimalPanel(args.isReviewTicket ? 'Spawning Review Worker' : 'Spawning Morty Worker', { Request: args.ticket, Ticket: args.ticketId, Type: args.isReviewTicket ? 'review' : 'implementation', Format: args.outputFormat, Backend: backend, Timeout: `${effectiveTimeout}s (Req: ${requestedTimeout}s)`, PID: process.pid }, args.isReviewTicket ? 'MAGENTA' : 'CYAN', '🥒');
    const prompt = buildWorkerPrompt({
        ticket: { task: args.ticket, ticketContent: args.ticketContent, ticketId: args.ticketId, ticketPath: args.ticketPath, sessionRoot: args.sessionRoot, backend, isReviewTicket: args.isReviewTicket },
        model: model ?? 'sonnet',
        repoRoot: runtime.sessionWorkingDir,
    });
    const sessionLog = fs.createWriteStream(args.sessionLogPath, { flags: 'w' });
    await runWorkerProcess({
        args, prompt, ticketPath: args.ticketPath, ticketId: args.ticketId, sessionRoot: args.sessionRoot, sessionLog,
        sessionLogPath: args.sessionLogPath, sessionWorkingDir: runtime.sessionWorkingDir,
        timeoutStatePath: runtime.timeoutStatePath, workerStatePath: runtime.workerStatePath,
        effectiveTimeoutMs: effectiveTimeout * 1000, mutableState: { finalized: false, timedOut: false },
        model, effort: runtime.sessionEffort, hermesOptions: readHermesWorkerOptions(runtime.state),
        preWorkerHead: (() => {
            try {
                return getHeadSha(runtime.sessionWorkingDir);
            }
            catch {
                return null;
            }
        })(),
    });
}
if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-morty.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}${msg}${Style.RESET}`);
        process.exit(1);
    });
}
