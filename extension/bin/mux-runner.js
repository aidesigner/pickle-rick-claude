#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, collectTickets, getTicketStatus, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification, parseTicketFrontmatter, getTicketTierBudgetWithOverrides, readFrontmatterField, upsertFrontmatterField, hasCompletionCommit, ticketFilePath, VALID_TICKET_COMPLEXITY_TIERS } from '../services/pickle-utils.js';
import { PromiseTokens, hasToken, VALID_STEPS, Defaults, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact } from '../types/index.js';
import { StateManager, safeDeactivate, finalizeTerminalState, recordExitReason, clearExitReason, writeActivityEntry, writeTimeoutStub, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, resolveBackendFromStateFileWithSource, backendEnvOverrides } from '../services/backend-spawn.js';
import { resolveCodexModel } from './spawn-morty.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { extractAssistantContent, detectOutputFormat } from '../services/classifier-utils.js';
import { updateTicketStatusInTransaction } from '../services/transaction-ticket-ops.js';
import { emitCrossTicketRegressionLinearComment } from '../lib/linear-comment.js';
import { evaluateManagerRelaunch, recordManagerRelaunch, } from '../services/manager-relaunch.js';
export { extractAssistantContent, detectOutputFormat } from '../services/classifier-utils.js';
export { hasCompletionCommit } from '../services/pickle-utils.js';
export { evaluateManagerRelaunch, recordManagerRelaunch, } from '../services/manager-relaunch.js';
export { evaluateManagerRelaunch as evaluateCodexManagerRelaunch, recordManagerRelaunch as recordCodexManagerRelaunch, } from '../services/manager-relaunch.js';
const sm = new StateManager();
let currentChildProc = null;
function readRunnerState(statePath) {
    return sm.read(statePath);
}
function removeRunnerSessionMapEntry(statePath, log) {
    const sessionsMapPath = path.join(getDataRoot(), 'current_sessions.json');
    const sessionDir = path.dirname(statePath);
    const cwd = (() => {
        try {
            const state = readRunnerState(statePath);
            return typeof state.working_dir === 'string' ? state.working_dir : '';
        }
        catch {
            return '';
        }
    })();
    if (!cwd)
        return;
    try {
        const map = (readRecoverableJsonObject(sessionsMapPath) || {});
        let removed = false;
        for (const [entryCwd, entryValue] of Object.entries(map)) {
            const mappedSessionPath = typeof entryValue === 'string'
                ? entryValue
                : (entryValue && typeof entryValue === 'object' && typeof entryValue.sessionPath === 'string')
                    ? String(entryValue.sessionPath)
                    : '';
            if (entryCwd === cwd || (mappedSessionPath && path.resolve(mappedSessionPath) === path.resolve(sessionDir))) {
                delete map[entryCwd];
                removed = true;
            }
        }
        if (!removed)
            return;
        const tmpMap = `${sessionsMapPath}.tmp.${process.pid}.${Date.now()}`;
        try {
            fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
            fs.renameSync(tmpMap, sessionsMapPath);
        }
        catch (err) {
            try {
                fs.unlinkSync(tmpMap);
            }
            catch { /* ignore cleanup failure */ }
            throw err;
        }
    }
    catch (err) {
        log(`WARNING: failed to remove current_sessions.json entry for forensic exit: ${safeErrorMessage(err)}`);
    }
}
export function killCurrentChild() {
    if (currentChildProc && !currentChildProc.killed) {
        currentChildProc.kill('SIGTERM');
    }
}
/**
 * Strips the Setup section from dual-mode templates (e.g. meeseeks.md, szechuan-sauce.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Strips from "## SETUP" (with or without " MODE" suffix) to
 * the next ##-level heading, regardless of its name. This avoids coupling to a specific
 * end-marker like "## REVIEW PASS MODE" — any template layout works.
 */
export function stripSetupSection(prompt) {
    const setupRe = /^## SETUP(?: MODE)?$/m;
    const setupMatch = setupRe.exec(prompt);
    if (!setupMatch)
        return prompt;
    // Find the next ##-level heading after the setup section
    const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
    const nextHeadingRe = /^## \S/m;
    const nextMatch = nextHeadingRe.exec(afterSetup);
    if (!nextMatch)
        return prompt; // Setup is the last section — nothing to strip to
    const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
    return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}
const TASK_NOTE_PRIORITY = {
    'Next': 0,
    'Dead Ends': 1,
    'Key Discoveries': 2,
    'Progress': 3,
};
const TASK_NOTE_TRUNC_MARKER = '[truncated]';
function parseTaskNoteSections(content) {
    const sectionRegex = /^## .+$/gm;
    const sections = [];
    let preamble = '';
    let lastIndex = 0;
    let lastHeader = '';
    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
        if (lastIndex === 0 && match.index > 0) {
            preamble = content.slice(0, match.index);
        }
        else if (lastHeader) {
            sections.push({ name: lastHeader, body: content.slice(lastIndex, match.index) });
        }
        lastHeader = match[0].replace(/^## /, '').trim();
        lastIndex = match.index;
    }
    if (lastHeader) {
        sections.push({ name: lastHeader, body: content.slice(lastIndex) });
    }
    return { preamble, sections };
}
function priorityFor(name) {
    return TASK_NOTE_PRIORITY[name] ?? 3;
}
function normalizeBetweenTicketFailureFile(rawFile, workingDir) {
    const trimmed = rawFile.trim();
    if (!trimmed)
        return '';
    const normalized = trimmed.replace(/\\/g, '/');
    if (!path.isAbsolute(normalized))
        return normalized;
    const relative = path.relative(workingDir, normalized).replace(/\\/g, '/');
    return relative.startsWith('..') ? normalized : relative;
}
export function parseBetweenTicketFastGateFailures(output, workingDir) {
    const failures = [];
    const lines = output.split(/\r?\n/);
    let activeFailure = null;
    const flushFailure = () => {
        if (!activeFailure)
            return;
        failures.push({
            name: activeFailure.name,
            file: activeFailure.file,
        });
        activeFailure = null;
    };
    for (const line of lines) {
        const failureStart = line.match(/^not ok(?:\s+\d+)?\s+-\s+(.+)$/);
        if (failureStart) {
            flushFailure();
            activeFailure = { name: failureStart[1].trim(), file: '' };
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
            activeFailure.file = normalizeBetweenTicketFailureFile(locationMatch[1], workingDir);
        }
    }
    flushFailure();
    if (failures.length > 0)
        return failures;
    const fallback = lines.map(line => line.trim()).find(Boolean) ?? 'npm run test:fast failed';
    return [{ name: fallback, file: '' }];
}
export function runBetweenTicketFastTests(extensionDir) {
    const result = spawnSync('npm', ['run', 'test:fast'], {
        cwd: extensionDir,
        encoding: 'utf-8',
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return {
        ok: result.status === 0,
        failures: result.status === 0
            ? []
            : parseBetweenTicketFastGateFailures(output, path.dirname(extensionDir)),
    };
}
export function runBetweenTicketFastGate(input) {
    const extensionDir = path.join(input.workingDir, 'extension');
    if (!fs.existsSync(extensionDir))
        return null;
    const runTestFast = input.runTestFast ?? runBetweenTicketFastTests;
    const ts = (input.now ?? Date.now)();
    const result = runTestFast(extensionDir);
    sm.update(input.statePath, state => {
        state.last_between_ticket_gate = {
            ts,
            ok: result.ok,
            failures: result.failures.map(failure => ({
                name: failure.name,
                file: failure.file,
            })),
        };
    });
    if (!result.ok && normalizedStatus(input.landedStatus) === 'done') {
        writeActivityEntry(input.statePath, {
            event: 'cross_ticket_regression_detected',
            ts: new Date(ts).toISOString(),
            ticket_id: input.nextTicketId || input.completedTicketId,
            prior_ticket_id: input.completedTicketId,
            failing_tests: result.failures.map(failure => ({
                name: failure.name,
                file: failure.file,
            })),
        });
        emitCrossTicketRegressionLinearComment({
            sessionDir: path.dirname(input.statePath),
            priorTicketId: input.completedTicketId,
            regressedTicketId: input.nextTicketId || input.completedTicketId,
            failingTests: result.failures.map(failure => ({
                name: failure.name,
                file: failure.file,
            })),
            log: input.log,
        });
    }
    input.log(`between-ticket fast gate for ${input.completedTicketId}: ${result.ok ? 'passed' : `failed (${result.failures.length} failure(s))`}`);
    return result;
}
function formatWorkerGateFailureLine(failure) {
    const label = failure.file || failure.name || 'unknown';
    const message = failure.message || failure.name || 'unknown failure';
    return `  - ${label}: ${message}`;
}
export function buildWorkerGateFailureSummary(state) {
    const events = (Array.isArray(state.activity) ? state.activity : [])
        .filter((entry) => entry?.event === 'worker_gate_failed')
        .slice(-3);
    if (events.length === 0)
        return '';
    const lines = ['=== RECENT WORKER GATE FAILURES ==='];
    for (const entry of events) {
        lines.push(`worker_gate_failed ticket_id=${entry.ticket_id || 'unknown'} gate_phase=${entry.gate_phase || 'unknown'} retry_count=${Number.isInteger(entry.retry_count) ? entry.retry_count : 0}`);
        const failures = Array.isArray(entry.failures) ? entry.failures.slice(0, 3) : [];
        if (failures.length === 0) {
            lines.push('  - unknown: no structured failures recorded');
            continue;
        }
        for (const failure of failures) {
            lines.push(formatWorkerGateFailureLine(failure));
        }
    }
    return lines.join('\n');
}
function buildIterationHandoffSummary(state, sessionDir, iterationNum) {
    const handoffSummary = buildHandoffSummary(state, sessionDir, iterationNum);
    const workerGateFailureSummary = buildWorkerGateFailureSummary(state);
    return workerGateFailureSummary ? `${handoffSummary}\n\n${workerGateFailureSummary}` : handoffSummary;
}
/**
 * Truncate TASK_NOTES.md content with section-aware priority.
 * Preserves ## Next and ## Dead Ends fully, trims ## Progress from oldest.
 * Sections without recognized headers are treated as Progress.
 */
export function truncateTaskNotes(content, maxChars = 2000) {
    if (!content || !content.trim())
        return '';
    if (content.length <= maxChars)
        return content;
    const { preamble, sections } = parseTaskNoteSections(content);
    // No recognized sections — treat entire content as trimmable from top
    if (sections.length === 0) {
        const marker = `${TASK_NOTE_TRUNC_MARKER}\n`;
        return marker + content.slice(content.length - (maxChars - marker.length));
    }
    // Phase 1: Drop Progress/unrecognized sections; add back the tail of the
    // most recent Progress section if any budget remains.
    const withoutProgress = sections.filter(s => priorityFor(s.name) < 3);
    let result = preamble + withoutProgress.map(s => s.body).join('');
    if (result.length <= maxChars) {
        const progress = sections.filter(s => priorityFor(s.name) === 3);
        const remaining = maxChars - result.length;
        if (remaining > 20 && progress.length > 0) {
            const tail = progress[progress.length - 1].body;
            result += `\n${TASK_NOTE_TRUNC_MARKER}\n` + tail.slice(tail.length - remaining);
        }
        return result.length <= maxChars ? result : result.slice(0, maxChars);
    }
    // Phase 2: Drop Key Discoveries too.
    const highPriority = sections.filter(s => priorityFor(s.name) <= 1);
    result = preamble + highPriority.map(s => s.body).join('');
    if (result.length <= maxChars)
        return `${result}\n${TASK_NOTE_TRUNC_MARKER}`;
    // Phase 3: Hard truncate from end.
    return result.slice(0, maxChars - (TASK_NOTE_TRUNC_MARKER.length + 2)) + `\n${TASK_NOTE_TRUNC_MARKER}`;
}
/**
 * Detects whether tickets in a session span multiple repositories.
 * Returns an array of distinct working_dir values if 2+, null otherwise.
 * Tickets with working_dir: null are excluded (they use session default).
 */
export function detectMultiRepo(sessionDir) {
    const tickets = collectTickets(sessionDir);
    const dirs = new Set(tickets
        .map(t => t.working_dir)
        .filter((d) => d !== null && d !== undefined));
    return dirs.size >= 2 ? [...dirs] : null;
}
const MUX_LIFECYCLE_ORDER = {
    research: 0,
    plan: 1,
    implement: 2,
    review: 3,
};
function normalizeTicketStatus(status) {
    return (status || '').toLowerCase().replace(/["']/g, '').trim();
}
function isInProgressTicket(sessionDir, ticket) {
    if (!ticket.id)
        return false;
    try {
        return normalizeTicketStatus(getTicketStatus(sessionDir, ticket.id)) === 'in progress';
    }
    catch {
        return false;
    }
}
function writeTicketStatus(sessionDir, ticketId, status) {
    try {
        const planned = updateTicketStatusInTransaction(ticketId, status, sessionDir);
        fs.writeFileSync(planned.path, planned.content);
        return true;
    }
    catch {
        return false;
    }
}
function chooseInProgressWinner(inProgress, currentTicket) {
    if (currentTicket && inProgress.some(ticket => ticket.id === currentTicket))
        return currentTicket;
    return inProgress.find(ticket => !!ticket.id)?.id ?? currentTicket;
}
function reconcileTicketStateDesync(statePath, sessionDir, currentTicket, iteration, log) {
    const tickets = collectTickets(sessionDir);
    if (tickets.length === 0) {
        log('WARN: ticket_state_desync check found no ticket directories');
        return readRunnerState(statePath);
    }
    const inProgress = tickets.filter(ticket => isInProgressTicket(sessionDir, ticket));
    const winner = chooseInProgressWinner(inProgress, currentTicket);
    const winnerMatchesState = winner === currentTicket;
    const alreadySynced = inProgress.length === 1 && winnerMatchesState;
    if (alreadySynced)
        return readRunnerState(statePath);
    logActivity({
        event: 'ticket_state_desync_detected',
        source: 'pickle',
        session: path.basename(sessionDir),
        iteration,
        ticket: winner ?? currentTicket ?? undefined,
        reason: `current_ticket=${currentTicket ?? 'none'} in_progress=${inProgress.map(t => t.id || '?').join(',') || 'none'}`,
    });
    if (winner && !inProgress.some(ticket => ticket.id === winner)) {
        writeTicketStatus(sessionDir, winner, 'In Progress');
    }
    for (const ticket of inProgress) {
        if (!ticket.id || ticket.id === winner)
            continue;
        writeTicketStatus(sessionDir, ticket.id, 'Todo');
    }
    if (winner && winner !== currentTicket) {
        return updateMuxLifecycleState(statePath, {
            currentTicket: winner,
            step: inferTicketLifecycleStep(sessionDir, winner, readRunnerState(statePath).step),
        });
    }
    return readRunnerState(statePath);
}
function isPendingMuxTicket(sessionDir, ticket) {
    if (!ticket.id)
        return false;
    let status;
    try {
        status = normalizeTicketStatus(getTicketStatus(sessionDir, ticket.id));
    }
    catch {
        return false;
    }
    return !!ticket.id && status !== 'done' && status !== 'skipped';
}
function findNextPendingTicketId(sessionDir) {
    return collectTickets(sessionDir).find(ticket => isPendingMuxTicket(sessionDir, ticket))?.id ?? null;
}
function withFreshTicketStatuses(sessionDir, tickets) {
    return tickets.map(ticket => {
        if (!ticket.id)
            return { ...ticket };
        try {
            return { ...ticket, status: getTicketStatus(sessionDir, ticket.id) };
        }
        catch {
            return { ...ticket, status: null };
        }
    });
}
export function correctPhantomDoneTickets(input) {
    let corrected = 0;
    for (const ticket of collectTickets(input.sessionDir)) {
        let status;
        try {
            status = ticket.id ? normalizedStatus(getTicketStatus(input.sessionDir, ticket.id)) : '';
        }
        catch {
            continue;
        }
        if (!ticket.id || status !== 'done')
            continue;
        const workingDir = ticket.working_dir || input.workingDir || process.cwd();
        // R-CCC-5: completion_commit frontmatter is the FIRST gate. Bundle commits
        // use R-* codes in the subject (not ticket hashes) so the legacy git-log
        // scan in hasCommitReferencingTicketSince misses 100% of them. The watcher
        // (inspectPhantomDoneTicketFile) already short-circuits on the field; this
        // closes the second revert path.
        const evidence = hasCompletionCommit({ sessionDir: input.sessionDir, ticketId: ticket.id, workingDir });
        if (evidence.source !== 'absent')
            continue;
        if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo'))
            continue;
        corrected++;
        input.log?.(`Corrected phantom Done ticket ${ticket.id} back to Todo (no completion commit found)`);
        logActivity({
            event: 'ticket_phantom_done_corrected',
            source: 'pickle',
            session: path.basename(input.sessionDir),
            ticket: ticket.id,
            iteration: input.iteration,
            reason: 'done_frontmatter_without_completion_commit',
        });
    }
    return corrected;
}
/**
 * Insert or replace `completion_commit_inferred: "<sha>"` in ticket frontmatter.
 * Preserves all other body content and leaves explicit `completion_commit:` intact.
 */
function insertCompletionCommitField(content, sha) {
    if (readFrontmatterField(content, 'completion_commit'))
        return null;
    return upsertFrontmatterField(content, 'completion_commit_inferred', sha);
}
/**
 * R-ICP-5: Inspect a single linear_ticket_*.md file. If frontmatter status
 * is 'Done' but no `completion_commit:` field is present, take a three-way
 * decision:
 *   1. If git log shows a commit referencing the ticket id since HEAD~10 —
 *      backfill `completion_commit:` with that SHA (work was real, field
 *      missing).
 *   2. If no commit found — revert status to its prior value (Todo or
 *      In Progress).
 *   3. If git lookup throws/times out — treat as "no commit" (revert path)
 *      but surface the failure reason for the caller's log line.
 *
 * `priorStatus` defaults to 'Todo' but the watcher caller passes the last
 * known good status from before the flip (read off the previous mtime
 * snapshot). Pure side-effect on the ticket file plus a structured result —
 * caller owns activity-event + stderr log writes.
 */
export function inspectPhantomDoneTicketFile(filePath, sessionDir, workingDir, priorStatus = 'Todo') {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return { changed: false, reason: 'unparseable' };
    }
    const status = readFrontmatterField(content, 'status');
    if (!status || status.toLowerCase() !== 'done') {
        return { changed: false, reason: 'not_done' };
    }
    const explicitCommit = readFrontmatterField(content, 'completion_commit');
    if (explicitCommit) {
        return { changed: false, reason: 'has_completion_commit' };
    }
    const ticketId = readFrontmatterField(content, 'id');
    if (!ticketId) {
        return { changed: false, reason: 'missing_id' };
    }
    let foundSha = null;
    try {
        const evidence = hasCompletionCommit({
            sessionDir,
            ticketId,
            ticketPath: filePath,
            workingDir,
        });
        if (evidence.source === 'inferred') {
            foundSha = evidence.sha;
        }
    }
    catch (err) {
        return { changed: false, reason: 'unparseable', gitFailureReason: safeErrorMessage(err) };
    }
    if (foundSha) {
        const updated = insertCompletionCommitField(content, foundSha);
        if (!updated) {
            return { changed: false, reason: 'unparseable' };
        }
        try {
            fs.writeFileSync(filePath, updated);
        }
        catch {
            return { changed: false, reason: 'unparseable' };
        }
        return { changed: true, reason: 'backfilled', commit: foundSha };
    }
    const wrote = writeTicketStatus(sessionDir, ticketId, priorStatus);
    if (!wrote) {
        return { changed: false, reason: 'unparseable' };
    }
    const result = { changed: true, reason: 'reverted', priorStatus };
    return result;
}
function hasArtifact(files, prefix) {
    return files.some(file => file.startsWith(prefix) && file.endsWith('.md'));
}
function inferTicketLifecycleStep(sessionDir, ticketId, fallback) {
    if (!ticketId)
        return fallback === 'review' ? 'review' : 'research';
    let files;
    try {
        files = fs.readdirSync(path.join(sessionDir, ticketId));
    }
    catch {
        return 'research';
    }
    if (hasArtifact(files, 'conformance_') || hasArtifact(files, 'code_review_'))
        return 'review';
    if (hasArtifact(files, 'plan_'))
        return 'implement';
    if (hasArtifact(files, 'research_'))
        return 'plan';
    return 'research';
}
function maxLifecycleStep(current, next) {
    if (current in MUX_LIFECYCLE_ORDER) {
        const currentLifecycle = current;
        return MUX_LIFECYCLE_ORDER[currentLifecycle] > MUX_LIFECYCLE_ORDER[next] ? currentLifecycle : next;
    }
    return next;
}
function updateMuxLifecycleState(statePath, patch) {
    return sm.update(statePath, s => {
        if (patch.iteration !== undefined)
            s.iteration = patch.iteration;
        const ticketChanged = patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket;
        if (patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket) {
            s.current_ticket = patch.currentTicket;
            delete s.current_ticket_tier;
            delete s.current_ticket_budget;
            delete s.current_ticket_max_iterations;
            delete s.current_ticket_worker_timeout_seconds;
            delete s.current_ticket_budget_start_iteration;
        }
        if (patch.step !== undefined) {
            s.step = ticketChanged ? patch.step : maxLifecycleStep(s.step, patch.step);
        }
    });
}
function readTicketBudgetForState(state, sessionDir) {
    const ticketId = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
        ? state.current_ticket
        : null;
    if (!ticketId)
        return sessionRunnerBudget(state);
    const ticketPath = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
    if (!fs.existsSync(ticketPath))
        return sessionRunnerBudget(state);
    const cachedTier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : undefined;
    if (cachedTier)
        return getTicketTierBudgetWithOverrides(state, cachedTier);
    return ticketInfoBudgetFromPath(state, ticketPath);
}
function ticketInfoBudgetFromPath(state, ticketPath) {
    return getTicketTierBudgetWithOverrides(state, parseTicketFrontmatter(ticketPath)?.complexity_tier);
}
function sessionRunnerBudget(state) {
    const max_iterations = Number(state.max_iterations);
    const worker_timeout_seconds = Number(state.worker_timeout_seconds);
    const fallback = getTicketTierBudgetWithOverrides(state, undefined);
    return {
        tier: 'medium',
        max_iterations: Number.isFinite(max_iterations) && max_iterations > 0 ? max_iterations : fallback.max_iterations,
        worker_timeout_seconds: Number.isFinite(worker_timeout_seconds) && worker_timeout_seconds > 0
            ? worker_timeout_seconds
            : fallback.worker_timeout_seconds,
    };
}
export function applyTicketTierBudget(state, sessionDir) {
    const budget = readTicketBudgetForState(state, sessionDir);
    if (state.current_ticket_budget_start_iteration === undefined) {
        state.current_ticket_budget_start_iteration = Math.max(0, (Number(state.iteration) || 0) - 1);
    }
    state.current_ticket_tier = budget.tier;
    state.current_ticket_max_iterations = budget.max_iterations;
    state.current_ticket_worker_timeout_seconds = budget.worker_timeout_seconds;
    // R-CNAR-1 part 2: do NOT overwrite state.max_iterations here. Per the
    // trap-door invariant in extension/CLAUDE.md, state.max_iterations is the
    // GLOBAL manager-loop cap (operator-set at session start). The per-ticket
    // tier ceiling lives in state.current_ticket_max_iterations (set above).
    // The cap-check at runMuxLoop reads BOTH and exits whichever fires first.
    // worker_timeout_seconds is documented as the per-spawn worker budget so it
    // remains overwritten here — workers want the per-ticket timeout.
    state.worker_timeout_seconds = budget.worker_timeout_seconds;
    return budget;
}
function ticketBudgetIterationCount(state, currentIteration) {
    if (!state.current_ticket || typeof state.current_ticket_tier !== 'string')
        return currentIteration;
    const start = Number(state.current_ticket_budget_start_iteration);
    if (!Number.isFinite(start) || start < 0)
        return currentIteration;
    return Math.max(0, currentIteration - start);
}
/**
 * R-CNAR-7: Atomic clear of all five `current_ticket_*` cache fields.
 * Called when `state.current_ticket` is null/undefined and the per-ticket
 * cap-check sees a stale, non-zero `current_ticket_max_iterations` left over
 * from a previously-completed ticket. Without this, --resume of a
 * clean-success exit (which leaves the cache populated) trips
 * `iteration_cap_exhausted` on iteration 1 before any new ticket starts.
 *
 * Returns the count of fields cleared (0 = state was already clean).
 */
export function clearStaleTicketCacheFields(state) {
    let cleared = 0;
    if (state.current_ticket_tier !== undefined) {
        delete state.current_ticket_tier;
        cleared++;
    }
    if (state.current_ticket_budget !== undefined) {
        delete state.current_ticket_budget;
        cleared++;
    }
    if (state.current_ticket_max_iterations !== undefined) {
        delete state.current_ticket_max_iterations;
        cleared++;
    }
    if (state.current_ticket_worker_timeout_seconds !== undefined) {
        delete state.current_ticket_worker_timeout_seconds;
        cleared++;
    }
    if (state.current_ticket_budget_start_iteration !== undefined) {
        delete state.current_ticket_budget_start_iteration;
        cleared++;
    }
    return cleared;
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
export function hasStalePerTicketCacheFields(state) {
    return state.current_ticket_tier !== undefined
        || state.current_ticket_budget !== undefined
        || state.current_ticket_max_iterations !== undefined
        || state.current_ticket_worker_timeout_seconds !== undefined
        || state.current_ticket_budget_start_iteration !== undefined;
}
export function isValidPerTicketCapCache(state) {
    if (state.current_ticket === null || state.current_ticket === undefined)
        return false;
    if (!isPositiveInteger(state.current_ticket_max_iterations))
        return false;
    if (!isNonNegativeInteger(state.current_ticket_budget_start_iteration))
        return false;
    if (typeof state.current_ticket_tier !== 'string')
        return false;
    return VALID_TICKET_COMPLEXITY_TIERS.includes(state.current_ticket_tier.toLowerCase());
}
export function stalePerTicketCacheDiagnostic(state) {
    return `per-ticket cap-check skipped: stale cache (current_ticket=${String(state.current_ticket)}, max_iter=${String(state.current_ticket_max_iterations)}, budget_start=${String(state.current_ticket_budget_start_iteration)}, tier=${String(state.current_ticket_tier)})`;
}
function shouldEmitStalePerTicketCapSkip(state) {
    return hasStalePerTicketCacheFields(state) && !isValidPerTicketCapCache(state);
}
export function clearStalePerTicketCacheAtIterationStart(statePath, state, log) {
    if (state.current_ticket !== null || !hasStalePerTicketCacheFields(state))
        return state;
    log('clearing stale per-ticket cache fields (current_ticket=null)');
    return sm.update(statePath, s => {
        clearStaleTicketCacheFields(s);
    });
}
/**
 * Proactive empty-queue completion check, run at iteration_start before any
 * manager spawn. If all `linear_ticket_*.md` files in the session report
 * `status: Done` (and there is at least one ticket), synthesizes an
 * EPIC_COMPLETED terminal state atomically and returns true so the caller
 * can break the outer loop.
 *
 * Guard conditions (bias: don't fire):
 *   - N=0 tickets — ambiguous; could be a setup error
 *   - Any ticket file unparseable — cannot confirm all Done
 *   - Not all statuses normalize to 'done'
 *
 * On success mutates state.json twice:
 *   1. sm.update  — sets completion_promise (JSON) + appends activity entry
 *   2. finalizeTerminalState — sets active=false, step='completed', exit_reason='completed'
 */
export function applyAllTicketsDoneCompletion(statePath, sessionDir, iteration, log) {
    let dirEntries;
    try {
        dirEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch {
        return false;
    }
    const ticketPaths = [];
    for (const entry of dirEntries) {
        if (!entry.isDirectory())
            continue;
        const subDir = path.join(sessionDir, entry.name);
        try {
            const files = fs.readdirSync(subDir);
            for (const file of files) {
                if (file.startsWith('linear_ticket_') && file.endsWith('.md')) {
                    ticketPaths.push(path.join(subDir, file));
                }
            }
        }
        catch {
            // subdir unreadable — skip
        }
    }
    if (ticketPaths.length === 0)
        return false;
    const statuses = [];
    for (const ticketPath of ticketPaths) {
        const parsed = parseTicketFrontmatter(ticketPath);
        if (!parsed) {
            log(`all-tickets-done-check: cannot parse ${path.basename(path.dirname(ticketPath))} — skipping completion synthesis`);
            return false;
        }
        statuses.push(normalizeTicketStatus(parsed.status || ''));
    }
    if (!statuses.every(s => s === 'done'))
        return false;
    const ts = new Date().toISOString();
    sm.update(statePath, s => {
        s.completion_promise = JSON.stringify({ kind: PromiseTokens.EPIC_COMPLETED, reason: 'all-tickets-done', ts });
        if (!Array.isArray(s.activity))
            s.activity = [];
        s.activity.push({ event: 'epic_completed', kind: PromiseTokens.EPIC_COMPLETED, ts });
    });
    finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'completed' });
    log(`all-tickets-done (${ticketPaths.length}/${ticketPaths.length}): synthesizing ${PromiseTokens.EPIC_COMPLETED} completion`);
    return true;
}
/**
 * Returns tickets that are still pending (not Done, not Skipped) excluding
 * `currentTicket`. Used to fail-loud when the model emits EPIC_COMPLETED but
 * the ticket queue is not actually drained — silent loop-termination on a
 * partial epic is the most expensive class of bug for autonomous agents.
 *
 * Status comparison is case-insensitive and strips quotes (matches the
 * normalisation already used at line ~1017 and in monitor.ts).
 */
export function findPendingNonCurrentTickets(tickets, currentTicket) {
    const norm = (s) => (s || '').toLowerCase().replace(/["']/g, '').trim();
    return tickets.filter(t => {
        if (!t.id)
            return false;
        if (t.id === currentTicket)
            return false;
        const s = norm(t.status);
        return s !== 'done' && s !== 'skipped';
    });
}
/**
 * Decide what to do when the manager emits EPIC_COMPLETED. This is the
 * single source of truth for the recovery state machine — the main loop just
 * acts on the returned decision.
 */
export function evaluateEpicCompletion(input) {
    const { tickets, currentTicket, priorFalseCount, priorFalseTicket } = input;
    const threshold = input.threshold ?? FALSE_EPIC_THRESHOLD;
    const norm = (s) => (s || '').toLowerCase().replace(/["']/g, '').trim();
    const totalCount = tickets.filter(t => !!t.id).length;
    const doneCount = tickets.filter(t => !!t.id && norm(t.status) === 'done').length;
    const pendingIds = tickets
        .filter(t => !!t.id && norm(t.status) !== 'done' && norm(t.status) !== 'skipped' && t.id !== currentTicket)
        .map(t => t.id)
        .filter((s) => typeof s === 'string');
    const currentInfo = currentTicket ? tickets.find(t => t.id === currentTicket) : null;
    const currentIsDone = !!currentInfo && norm(currentInfo.status) === 'done';
    // The current ticket is allowed to count as "about to be Done" because the
    // manager normally marks it Done in the same iteration as EPIC_COMPLETED.
    // We treat it as Done iff it is BOTH actually Done AND no other tickets are
    // pending. This keeps the genuine path identical to the prior guard.
    if (pendingIds.length === 0 && (currentTicket == null || currentIsDone)) {
        return { kind: 'genuine', doneCount, totalCount };
    }
    // From here on the manager lied. Bump the counter (resetting when ticket
    // changes — different ticket means we're not stuck in the same loop).
    const sameTicket = currentTicket != null && priorFalseTicket === currentTicket;
    const nextCount = (sameTicket ? priorFalseCount : 0) + 1;
    if (currentTicket != null && nextCount > threshold) {
        return { kind: 'persistent_hallucination', doneCount, totalCount, ticket: currentTicket, nextCount };
    }
    if (currentIsDone) {
        return { kind: 'recover_advance', doneCount, totalCount, pendingIds, nextCount };
    }
    return { kind: 'recover_retry', doneCount, totalCount, pendingIds, nextCount };
}
/**
 * Classifies iteration output into a completion result.
 * EPIC_COMPLETED → 'task_completed' (exits the loop — all tickets done)
 * EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES → 'review_clean' (subject to min_iterations gate)
 * TASK_COMPLETED / anything else → 'continue' (single ticket done, loop continues)
 *
 * Only checks assistant message content (via extractAssistantContent) to avoid
 * false positives from promise tokens in reviewed source code.
 */
export function classifyCompletion(output) {
    const content = extractAssistantContent(output);
    if (hasToken(content, PromiseTokens.EPIC_COMPLETED)) {
        return 'task_completed';
    }
    if (hasToken(content, PromiseTokens.EXISTENCE_IS_PAIN) || hasToken(content, PromiseTokens.THE_CITADEL_APPROVES)) {
        return 'review_clean';
    }
    return 'continue';
}
/**
 * Post-hoc safety net: validates whether a ticket was actually completed
 * before marking it Done. TASK_COMPLETED token is strong evidence. Otherwise
 * require a ticket-scoped lifecycle artifact — unscoped git diff alone is a
 * ghost source (changes from any other ticket in the tree pass). Never throws.
 */
export function classifyTicketCompletion(iterLogFile, workingDir, ticketDir, role = 'implementation') {
    try {
        const logContent = fs.readFileSync(iterLogFile, 'utf-8');
        const assistantContent = extractAssistantContent(logContent);
        if (hasToken(assistantContent, PromiseTokens.TASK_COMPLETED))
            return 'completed';
    }
    catch (err) {
        process.stderr.write(`[mux-runner:classify-ticket:log-read] ${safeErrorMessage(err)}\n`); /* fall through to artifact check */
    }
    if (!ticketDir)
        return 'skipped';
    let files;
    try {
        files = fs.readdirSync(ticketDir);
    }
    catch {
        return 'skipped';
    }
    if (!hasLifecycleArtifact(files, role))
        return 'skipped';
    // Artifact exists — corroborate with git diff. Artifacts alone are
    // sufficient because the worker wrote them during its lifecycle, but a
    // dirty tree is a stronger signal that code actually changed.
    try {
        const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
        if (uncommitted.length > 0)
            return 'completed';
        const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
        if (staged.length > 0)
            return 'completed';
    }
    catch (err) {
        process.stderr.write(`[mux-runner:classify-ticket:git-probe] ${safeErrorMessage(err)}\n`); /* artifact alone suffices */
    }
    return 'completed';
}
function normalizedStatus(status) {
    return (status || '').toLowerCase().replace(/^["']|["']$/g, '').trim();
}
function isTerminalTicketStatus(status) {
    const normalized = normalizedStatus(status);
    return normalized === 'done' || normalized === 'skipped';
}
function acceptanceCriteriaSection(content) {
    const match = /^## Acceptance Criteria\s*$/m.exec(content);
    if (!match)
        return '';
    const rest = content.slice(match.index + match[0].length);
    const next = /^## \S.*$/m.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
}
function hasCheckedAcceptanceCriteria(content) {
    const section = acceptanceCriteriaSection(content);
    const boxes = [...section.matchAll(/^\s*-\s*\[([ xX])\]/gm)];
    return boxes.length > 0 && boxes.every(match => match[1].toLowerCase() === 'x');
}
function readHeadCommit(workingDir) {
    try {
        const head = runCmd(['git', 'rev-parse', 'HEAD'], { cwd: workingDir, check: false }).trim();
        return head.length > 0 ? head : null;
    }
    catch {
        return null;
    }
}
function emitMuxWastedIter(input) {
    const wasted = input.action === 'revert' || input.postIterSha === input.preIterSha;
    logActivity({
        event: 'wasted_iter',
        source: 'pickle',
        session: path.basename(input.sessionDir),
        iteration: input.iteration,
        runner: 'mux',
        action: input.action,
        wasted,
        pre_iter_sha: input.preIterSha,
        post_iter_sha: input.postIterSha,
    });
}
function gitCommitEpoch(workingDir, sha) {
    if (!sha)
        return null;
    try {
        const raw = execFileSync('git', ['-C', workingDir, 'show', '-s', '--format=%ct', sha], {
            timeout: 5000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
export function validateAutoTicketCompletion(sessionDir, ticketId, workingDir, startCommit) {
    const filePath = ticketFilePath(sessionDir, ticketId);
    try {
        if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId)))
            return { action: 'leave', reason: 'ticket_already_terminal' };
    }
    catch {
        return { action: 'leave', reason: 'malformed_or_missing_ticket_frontmatter' };
    }
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return { action: 'leave', reason: 'ticket_file_unreadable' };
    }
    if (!hasCheckedAcceptanceCriteria(content)) {
        return { action: 'skip', reason: 'acceptance_criteria_not_checked' };
    }
    const evidence = hasCompletionCommit({
        sessionDir,
        ticketId,
        workingDir,
        startTimeEpoch: gitCommitEpoch(workingDir, startCommit),
    });
    if (evidence.source === 'absent') {
        return { action: 'skip', reason: 'no_commit_referencing_ticket_since_current_set' };
    }
    return { action: 'done', reason: 'commit_and_acceptance_checked' };
}
export function applyAutoTicketCompletionValidation(input) {
    const verdict = validateAutoTicketCompletion(input.sessionDir, input.ticketId, input.workingDir, input.startCommit);
    if (verdict.action === 'done') {
        if (markTicketDone(input.sessionDir, input.ticketId)) {
            input.log?.(`Marked ticket ${input.ticketId} as Done (validated: evidence found)`);
        }
        return verdict;
    }
    if (verdict.action === 'skip') {
        if (markTicketSkipped(input.sessionDir, input.ticketId)) {
            input.log?.(`Marked ticket ${input.ticketId} as Skipped (${verdict.reason})`);
            logActivity({
                event: 'ticket_auto_skip_no_evidence',
                source: 'pickle',
                session: path.basename(input.sessionDir),
                ticket: input.ticketId,
                iteration: input.iteration,
                reason: verdict.reason,
            });
        }
        return verdict;
    }
    input.log?.(`Warning: leaving ticket ${input.ticketId} unchanged (${verdict.reason})`);
    return verdict;
}
/**
 * Reads `pickle_settings.json` as an untyped bag, returning `{}` on any
 * read/parse failure. Emits a labeled stderr breadcrumb keyed by the caller
 * site so a missing/corrupt settings file never silently yields defaults.
 * Every call site in this module consumes its own subset of keys with its
 * own defaults; this helper owns only the file I/O + JSON decode step.
 */
function loadSettingsBag(extensionRoot, site) {
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    const raw = readRecoverableJsonObject(settingsPath);
    if (raw)
        return raw;
    if (!fs.existsSync(settingsPath))
        return {};
    try {
        fs.readFileSync(settingsPath, 'utf-8');
    }
    catch (err) {
        process.stderr.write(`[${site}] ${safeErrorMessage(err)}\n`);
    }
    return {};
}
function positiveIntegerOrNull(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
/**
 * Transitions a session from ticket-execution mode to Meeseeks review mode.
 * Pure function — returns a new state object without side effects.
 */
export function transitionToMeeseeks(state, extensionRoot) {
    let minPasses = 10;
    let maxPasses = 50;
    const settings = loadSettingsBag(extensionRoot, 'mux-runner:transition-meeseeks:settings');
    const rawMin = Number(settings.default_meeseeks_min_passes);
    if (Number.isFinite(rawMin) && rawMin > 0)
        minPasses = rawMin;
    const rawMax = Number(settings.default_meeseeks_max_passes);
    if (Number.isFinite(rawMax) && rawMax > 0)
        maxPasses = rawMax;
    return {
        ...state,
        chain_meeseeks: false,
        command_template: 'meeseeks.md',
        min_iterations: minPasses,
        max_iterations: maxPasses,
        iteration: 0,
        step: 'review',
        current_ticket: null,
    };
}
// eslint-disable-next-line -- legacy model tier resolver retained behavior-preserving for global bin acceptance
export function loadMeeseeksModel(extensionRoot, passCount = 1) {
    const fallback = 'sonnet';
    let defaultModel = fallback;
    let tiers = null;
    let maxOpusPasses = 3;
    let enableModelTiers = true;
    const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-meeseeks-model:settings');
    if (typeof raw.default_meeseeks_model === 'string' && raw.default_meeseeks_model.length > 0) {
        defaultModel = raw.default_meeseeks_model;
    }
    if (raw.meeseeks_model_tiers && typeof raw.meeseeks_model_tiers === 'object') {
        tiers = raw.meeseeks_model_tiers;
    }
    const rawCap = Number(raw.max_opus_passes);
    if (Number.isFinite(rawCap) && rawCap > 0)
        maxOpusPasses = rawCap;
    // Feature flag: enable_model_tiers (default true — missing flag = enabled)
    if (raw.enable_model_tiers === false)
        enableModelTiers = false;
    if (!tiers || !enableModelTiers)
        return defaultModel;
    // Find the highest threshold that doesn't exceed passCount
    let resolvedModel = defaultModel;
    let highestThreshold = 0;
    for (const [key, model] of Object.entries(tiers)) {
        const threshold = Number(key);
        if (Number.isFinite(threshold) && threshold <= passCount && threshold > highestThreshold) {
            highestThreshold = threshold;
            resolvedModel = String(model);
        }
    }
    // Cap opus passes: if resolved model is opus and we've used more than the allowed count, fall back to sonnet
    if (resolvedModel === 'opus') {
        const opusPassNumber = passCount - highestThreshold + 1;
        if (opusPassNumber > maxOpusPasses)
            resolvedModel = 'sonnet';
    }
    return resolvedModel;
}
export function loadRateLimitSettings(extensionRoot) {
    let waitMinutes = 5;
    let maxRetries = 3;
    const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-rate-limit-settings');
    const rawWait = raw.default_rate_limit_wait_minutes;
    if (typeof rawWait === 'number' && rawWait >= 1)
        waitMinutes = rawWait;
    const rawRetries = raw.default_max_rate_limit_retries;
    if (typeof rawRetries === 'number' && rawRetries >= 1)
        maxRetries = rawRetries;
    return { waitMinutes, maxRetries };
}
export function detectRateLimitInLog(logFile) {
    const result = { limited: false, sawEvents: false };
    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split('\n');
        const tail = lines.slice(-100);
        for (const line of tail) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.type !== 'rate_limit_event')
                    continue;
                result.sawEvents = true;
                // Real API nests under rate_limit_info; check both paths for robustness
                const info = parsed.rate_limit_info ?? parsed;
                const status = info.status;
                if (status === 'rejected') {
                    result.limited = true;
                    if (typeof info.resetsAt === 'number')
                        result.resetsAt = info.resetsAt;
                    if (typeof info.rateLimitType === 'string')
                        result.rateLimitType = info.rateLimitType;
                }
            }
            catch { /* not JSON */ }
        }
    }
    catch { /* file missing */ }
    return result;
}
export function detectRateLimitInText(logFile) {
    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split('\n');
        // Only check the very tail — rate limit messages appear at the end when
        // the process is killed. 20 lines is plenty; 100 was catching assistant
        // text *about* rate limits as false positives.
        const tail = lines.slice(-20);
        // Filter out JSON content fields (assistant text, user messages, tool results)
        // to avoid matching on *discussion about* rate limits
        const filtered = tail.filter(l => !l.includes('"type":"user"') &&
            !l.includes('"type":"tool_result"') &&
            !l.includes('"type":"assistant"') &&
            !l.includes('"type":"text"') &&
            !l.includes('"content":[') &&
            !l.includes('"content":"'));
        const text = filtered.join('\n');
        // Tightened patterns — require more specific phrasing to avoid matching
        // code comments or discussions about rate limiting
        const patterns = [
            /your .* usage limit has been reached/i,
            /usage is limited.*try again/i,
            /out of (extra )?usage/i,
            /rate limited.*try again/i,
        ];
        return patterns.some(p => p.test(text));
    }
    catch { /* file missing */ }
    return false;
}
export function detectManagerMaxTurnsExit(outcome, logFile) {
    if (outcome.timedOut || outcome.exitCode !== 0) {
        return false;
    }
    let content;
    try {
        content = fs.readFileSync(logFile, 'utf-8');
    }
    catch {
        return false;
    }
    const lines = content.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]?.trim();
        if (!line)
            continue;
        if (!line.startsWith('{'))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return false;
        }
        if (!parsed || typeof parsed !== 'object')
            continue;
        const event = parsed;
        if (event.type !== 'result')
            continue;
        return event.stop_reason === 'end_turn'
            && event.terminal_reason === 'completed'
            && event.is_error === false;
    }
    return false;
}
export function classifyManagerRelaunchExit(state, outcome, logFile) {
    const backend = resolveBackend(state);
    if (backend === 'claude' && outcome && detectManagerMaxTurnsExit(outcome, logFile)) {
        return 'claude_max_turns';
    }
    if (backend === 'codex' && outcome?.timedOut === true) {
        return 'codex_4h_hang_guard';
    }
    return 'other_error';
}
export function classifyIterationExit(completionResult, logFile, timing) {
    if (completionResult === 'inactive')
        return { type: 'inactive' };
    if (completionResult === 'error')
        return { type: 'error' };
    if (completionResult === 'task_completed' || completionResult === 'review_clean')
        return { type: 'success' };
    const rlInfo = detectRateLimitInLog(logFile);
    if (rlInfo.limited)
        return { type: 'api_limit', rateLimitInfo: rlInfo };
    // Only fall back to text detection if we found NO structured rate_limit_event
    // entries at all. If structured events exist but none say 'rejected', trust
    // that — don't let fuzzy text matching override structured signals.
    if (!rlInfo.sawEvents && detectRateLimitInText(logFile))
        return { type: 'api_limit' };
    if (timing?.didTimeout) {
        return { type: 'timeout', exitCode: timing.exitCode, wallSeconds: timing.wallSeconds };
    }
    return { type: 'success' };
}
/**
 * Pure decision function: given rate limit context, returns whether to wait or bail.
 * Extracted from main() for testability. No side effects.
 *
 * When resetsAt is available from the API, always waits (the API told us when to come back).
 * Only bails when no resetsAt AND consecutive retries >= max.
 * Resets the counter after an API-guided wait completes.
 */
export function computeRateLimitAction(exitResult, consecutiveRateLimits, maxRetries, configWaitMinutes) {
    const configWaitMs = configWaitMinutes * 60 * 1000;
    const maxApiWaitMs = configWaitMs * 3;
    let waitMs = configWaitMs;
    let waitSource = 'config';
    const rlResetsAt = exitResult.type === 'api_limit' ? exitResult.rateLimitInfo?.resetsAt : undefined;
    const hasResetsAt = typeof rlResetsAt === 'number' && rlResetsAt > 0;
    if (hasResetsAt) {
        const apiWaitMs = (rlResetsAt * 1000) - Date.now();
        if (apiWaitMs > 0 && apiWaitMs <= maxApiWaitMs) {
            waitMs = apiWaitMs + 30_000; // 30s buffer
            waitSource = 'api';
        }
        // apiWaitMs > maxApiWaitMs → capped, falls through to config default
        // apiWaitMs <= 0 → resetsAt in the past, use config default
    }
    // Bail only when blind (no resetsAt) AND retries exhausted
    if (!hasResetsAt && consecutiveRateLimits >= maxRetries) {
        return { action: 'bail', waitMs: 0, waitSource: 'config', resetCounter: false, hasResetsAt };
    }
    return {
        action: 'wait',
        waitMs,
        waitSource,
        resetCounter: waitSource === 'api',
        hasResetsAt,
    };
}
// eslint-disable-next-line -- legacy iteration loop retained behavior-preserving for global bin acceptance
export async function runIteration(sessionDir, iterationNum, extensionRoot, qualityPassModel) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = readRunnerState(statePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
    }
    if (state.active !== true)
        return { completion: 'inactive', timedOut: false, exitCode: null, wallSeconds: 0 };
    const templateName = state.command_template || 'pickle.md';
    // Validate at read time (not just at setup.ts CLI parse time) — state.json could be tampered with
    if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
        throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
    }
    // Check internal templates first (hidden from slash command list), then user-facing commands.
    // Use extensionRoot for templatesDir so tests can inject an isolated directory via EXTENSION_DIR.
    const templatesDir = path.join(extensionRoot, 'templates');
    const commandsDir = path.join(os.homedir(), '.claude/commands');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
        ? path.join(templatesDir, templateName)
        : path.join(commandsDir, templateName);
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(picklePromptPath)) {
        throw new Error(`${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.`);
    }
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    let managerPrompt = fs.readFileSync(picklePromptPath, 'utf-8')
        .replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);
    managerPrompt = stripSetupSection(managerPrompt);
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (fs.existsSync(handoffPath)) {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        try {
            fs.unlinkSync(handoffPath);
        }
        catch (unlinkErr) {
            const code = unlinkErr.code;
            if (code === 'EACCES' || code === 'ENOENT') {
                console.warn(`[mux-runner] WARNING: Cannot remove handoff.txt (${code})`);
            }
        }
    }
    else {
        managerPrompt += '\n\n' + buildIterationHandoffSummary(state, sessionDir, iterationNum);
    }
    const settings = loadSettingsBag(extensionRoot, 'mux-runner:run-iteration:settings');
    // Feature flag: enable_task_notes (default true — missing flag = enabled)
    const enableTaskNotes = settings.enable_task_notes !== false;
    // Inject TASK_NOTES.md from session directory (persists across iterations)
    if (enableTaskNotes) {
        const taskNotesPath = path.join(sessionDir, 'TASK_NOTES.md');
        try {
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            if (fs.existsSync(taskNotesPath)) {
                // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                const raw = fs.readFileSync(taskNotesPath, 'utf-8');
                const truncated = truncateTaskNotes(raw, 2000);
                if (truncated.trim()) {
                    managerPrompt += '\n\n=== TASK NOTES (from previous iterations) ===\n' + truncated;
                }
            }
        }
        catch (readErr) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr);
            console.warn(`[mux-runner] WARNING: task notes subsystem failed: ${msg}`);
        }
    }
    let maxTurns = Defaults.MANAGER_MAX_TURNS;
    maxTurns = positiveIntegerOrNull(settings.default_tmux_max_turns)
        ?? positiveIntegerOrNull(settings.default_manager_max_turns)
        ?? maxTurns;
    const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
    const backend = resolveBackend(state);
    const isQualityPassTemplate = templateName === 'meeseeks.md' || templateName === 'szechuan-sauce.md';
    // Quality review passes can run on a selected Claude model. Codex exposes a
    // different model vocabulary, so only apply the override for claude.
    const iterationModel = isQualityPassTemplate && qualityPassModel && backend === 'claude'
        ? qualityPassModel
        : undefined;
    // Codex manager spawns plumb the resolved codex model so `--ignore-user-config`
    // doesn't strip away the configured `-m`. Quality-pass-template Claude
    // overrides (meeseeks/szechuan) remain claude-only above.
    const codexManagerModel = backend === 'codex' ? resolveCodexModel(extensionRoot, state) : undefined;
    const invocation = buildManagerInvocation(backend, {
        prompt: managerPrompt,
        addDirs: [extensionRoot, getDataRoot(), sessionDir],
        model: backend === 'hermes' ? state.hermes_model : (backend === 'codex' ? codexManagerModel : iterationModel),
        maxTurns: backend === 'hermes' ? positiveIntegerOrNull(state.hermes_max_turns) ?? maxTurns : maxTurns,
        streamJson: true,
        noSessionPersistence: true,
        toolsets: backend === 'hermes' ? state.hermes_toolsets : undefined,
        provider: backend === 'hermes' ? state.hermes_provider : undefined,
    });
    const env = {
        ...process.env,
        ...backendEnvOverrides(backend),
        PICKLE_STATE_FILE: statePath,
        PYTHONUNBUFFERED: '1',
    };
    // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
    // inside another Claude Code session (which would alter its behavior).
    delete env['CLAUDECODE'];
    // Remove PICKLE_ROLE so manager subprocesses aren't misidentified as workers
    // by the stop-hook (tmux-runner spawns managers, not workers).
    delete env['PICKLE_ROLE'];
    // Use a raw file descriptor with synchronous writes so every chunk hits
    // the disk immediately. Node's WriteStream buffers up to 16KB internally,
    // which starves log-watcher (it polls file size via statSync).
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    const logFd = fs.openSync(logFile, 'w');
    function writeToLog(chunk) {
        try {
            fs.writeSync(logFd, chunk);
        }
        catch { /* fd closed — ignore late writes */ }
    }
    return new Promise((resolve) => {
        let settled = false;
        const start = Date.now();
        let didTimeout = false;
        const proc = spawn(invocation.cmd, invocation.args, {
            cwd: state.working_dir || process.cwd(),
            env,
            stdio: ['inherit', 'pipe', 'pipe'],
        });
        currentChildProc = proc;
        const hangGuardMs = Defaults.MAX_ITERATION_SECONDS * 1000;
        const hangGuard = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            didTimeout = true;
            currentChildProc = null;
            try {
                proc.kill('SIGTERM');
            }
            catch { /* already dead */ }
            try {
                fs.fsyncSync(logFd);
            }
            catch { /* already closed or error */ }
            try {
                fs.closeSync(logFd);
            }
            catch { /* already closed */ }
            console.error(`${Style.RED}❌ Iteration ${iterationNum} hang detected — forcing failure${Style.RESET}`);
            resolve({ completion: 'error', timedOut: true, exitCode: null, wallSeconds: (Date.now() - start) / 1000 });
        }, hangGuardMs);
        hangGuard.unref();
        // Direct data handlers: write each chunk to both the log file (sync,
        // no buffering) and the terminal (for the tmux-runner pane).
        proc.stdout?.on('data', (chunk) => {
            writeToLog(chunk);
            process.stderr.write(chunk);
        });
        proc.stderr?.on('data', (chunk) => {
            writeToLog(chunk);
            process.stderr.write(chunk);
        });
        proc.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            currentChildProc = null;
            if (hangGuard)
                clearTimeout(hangGuard);
            try {
                fs.fsyncSync(logFd);
            }
            catch { /* already closed or error */ }
            try {
                fs.closeSync(logFd);
            }
            catch { /* already closed */ }
            const exitCodeFile = logFile.replace('.log', '.exitcode');
            try {
                fs.writeFileSync(exitCodeFile, String(code ?? -1));
            }
            catch { /* best effort */ }
            let output = '';
            try {
                output = fs.readFileSync(logFile, 'utf-8');
            }
            catch { /* missing/unreadable log */ }
            if (backend === 'codex' && detectOutputFormat(output) === 'plain-text') {
                process.stderr.write(`[classifier] codex delimiter drift: no recognizable codex/user blocks in iteration ${iterationNum} output\n`);
            }
            const completion = classifyCompletion(output);
            const normalizedOutcome = {
                completion,
                timedOut: didTimeout,
                exitCode: code ?? null,
                wallSeconds: (Date.now() - start) / 1000,
            };
            resolve({
                ...normalizedOutcome,
                completion: backend === 'claude'
                    && completion === 'continue'
                    && detectManagerMaxTurnsExit(normalizedOutcome, logFile)
                    ? 'error'
                    : completion,
            });
        });
        proc.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            currentChildProc = null;
            if (hangGuard)
                clearTimeout(hangGuard);
            const msg = safeErrorMessage(err);
            console.error(`${Style.RED}Failed to spawn ${invocation.cmd}: ${msg}${Style.RESET}`);
            try {
                fs.fsyncSync(logFd);
            }
            catch { /* already closed or error */ }
            try {
                fs.closeSync(logFd);
            }
            catch { /* already closed */ }
            resolve({ completion: 'error', timedOut: false, exitCode: null, wallSeconds: (Date.now() - start) / 1000 });
        });
    });
}
/**
 * Atomically writes handoff.txt via a tmp file + rename.
 * On rename failure, falls back to a direct (non-atomic) write.
 * On both failures, logs an error but does NOT throw — handoff is non-critical.
 * Warns (does not throw) when tmp cleanup unlinkSync hits EACCES/ENOENT.
 *
 * @param sessionDir  - session directory path
 * @param content     - handoff content to write
 * @param pid         - process id used to make tmp filename unique
 * @param log         - logging function (e.g. the runner's log() closure)
 * @param fsOps       - injectable fs subset (default: real fs — override in tests)
 */
export function writeHandoffAtomic(sessionDir, content, pid, log, fsOps = fs) {
    const handoffTmp = path.join(sessionDir, `handoff.txt.tmp.${pid}`);
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    // Step 1: write to tmp
    try {
        fsOps.writeFileSync(handoffTmp, content);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: handoff.txt tmp write failed (non-critical): ${msg}`);
        return;
    }
    // Step 2: atomic rename
    try {
        fsOps.renameSync(handoffTmp, handoffPath);
        return; // success
    }
    catch {
        log('WARNING: handoff.txt rename failed — falling back to direct write');
    }
    // Step 3: non-atomic fallback
    try {
        fsOps.writeFileSync(handoffPath, content);
    }
    catch (writeErr) {
        const msg = safeErrorMessage(writeErr);
        log(`ERROR: handoff.txt write failed (non-critical): ${msg}`);
    }
    // Step 4: clean up leftover tmp
    try {
        fsOps.unlinkSync(handoffTmp);
    }
    catch (unlinkErr) {
        const code = unlinkErr.code;
        if (code === 'EACCES' || code === 'ENOENT') {
            log(`WARNING: Cannot remove tmp handoff file (${code})`);
        }
    }
}
export const COMMIT_PENDING_HANDOFF_TEXT = `## CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING

You have uncommitted edits in the working tree but the iteration counter has not advanced for N iterations. This commonly means you are looping on a contradiction or over-exploring instead of shipping.

REQUIRED THIS TURN:
1. Run \`git add <files>\` and \`git commit -m "<msg>"\` to lock in current edits.
2. If an acceptance criterion is blocked (e.g. fixture mismatch, missing dependency), append a \`# DEFERRED: <reason>\` line to the ticket file and signal Done.
3. Do NOT continue exploring — your unblocked subset is already valuable and must not be orphaned.

After committing, emit \`<promise>${PromiseTokens.WORKER_DONE}</promise>\` as usual.
`;
/**
 * Pre-spawn health probe. Detects the codex "commit-skip" failure mode:
 * uncommitted edits in the working tree combined with iteration counter
 * stagnation. When triggered, writes handoff.txt with a direct nudge so the
 * next worker turn commits + signals Done before the circuit breaker trips.
 *
 * Triggers ONLY when ALL are true:
 *   - backend === 'codex' (claude lacks this failure mode per RCA)
 *   - iteration - lastProgressIteration >= threshold (default 2)
 *   - `git diff --stat` OR `git diff --stat --cached` is non-empty
 *
 * Idempotent: if handoff.txt already exists at probe time (e.g. user-written
 * or rate-limit handoff), the probe defers and skips. Never throws — best
 * effort. Returns a string status for tests/logs.
 */
export function commitPendingProbe(input) {
    const { sessionDir, workingDir, backend, iteration, lastProgressIteration, threshold, pid, log } = input;
    if (backend !== 'codex')
        return 'skipped:not-codex';
    const stagnation = iteration - lastProgressIteration;
    if (stagnation < threshold)
        return 'skipped:no-stagnation';
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
        log(`commit-pending probe deferred: existing handoff.txt at ${handoffPath}`);
        return 'skipped:existing-handoff';
    }
    // Detect uncommitted edits using the same git-diff pattern as
    // classifyTicketCompletion (lines ~381-384). Both unstaged and staged
    // diffs count as "pending commit" — codex has been observed leaving
    // either flavor.
    let hasUncommitted = false;
    try {
        const unstaged = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
        if (unstaged.length > 0)
            hasUncommitted = true;
        if (!hasUncommitted) {
            const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
            if (staged.length > 0)
                hasUncommitted = true;
        }
    }
    catch (err) {
        log(`commit-pending probe: git probe failed (${safeErrorMessage(err)}) — skipping`);
        return 'skipped:no-uncommitted';
    }
    if (!hasUncommitted)
        return 'skipped:no-uncommitted';
    const content = COMMIT_PENDING_HANDOFF_TEXT.replace('N iterations', `${stagnation} iterations`);
    writeHandoffAtomic(sessionDir, content, pid, log);
    log(`commit-pending probe FIRED: stagnation=${stagnation} (>= threshold ${threshold}), uncommitted edits present — handoff.txt written`);
    return 'fired';
}
export function runMuxReadinessGate(input) {
    const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'check-readiness.js');
    const installedBinPath = path.join(input.extensionRoot, 'bin', 'check-readiness.js');
    const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
    if (!fs.existsSync(binPath)) {
        input.log(`readiness gate skipped: ${binPath} not found`);
        return 0;
    }
    const args = [
        binPath,
        '--session-dir', input.sessionDir,
        '--repo-root', input.repoRoot,
    ];
    if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
        args.push('--skip-readiness', input.skipReason);
        input.log(`readiness gate skipped via state.flags.skip_readiness_reason: ${input.skipReason}`);
    }
    const result = spawnSync(process.execPath, args, {
        cwd: input.repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout)
        process.stdout.write(result.stdout);
    if (result.stderr)
        process.stderr.write(result.stderr);
    return result.status ?? 1;
}
/**
 * Invokes audit-ticket-bundle.js on the session's ticket files immediately
 * after runMuxReadinessGate exits 0 and BEFORE iteration-0 spawn.
 * Non-zero exit → caller halts with exit_reason='ticket_audit_failed'.
 * skipReason (from state.flags.skip_ticket_audit_reason) → bypassed.
 */
export function runTicketAuditGate(input) {
    if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
        input.log(`ticket audit gate bypassed via state.flags.skip_ticket_audit_reason: ${input.skipReason}`);
        return { status: 'bypassed', reason: input.skipReason };
    }
    const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'audit-ticket-bundle.js');
    const installedBinPath = path.join(input.extensionRoot, 'bin', 'audit-ticket-bundle.js');
    const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
    if (!fs.existsSync(binPath)) {
        input.log(`ticket audit gate skipped: ${binPath} not found`);
        return { status: 'ok' };
    }
    const result = spawnSync(process.execPath, [binPath, input.sessionDir], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout)
        process.stdout.write(result.stdout);
    if (result.stderr)
        process.stderr.write(result.stderr);
    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
        return { status: 'failed', exitCode };
    }
    return { status: 'ok' };
}
/**
 * Best-effort append of a one-line marker to `pipeline-runner.log` in the
 * session directory. The pipeline-runner owns that file when it spawns
 * mux-runner; in standalone mux-runner runs the file may not exist (we never
 * create it). Failure is silent — the same marker also lands in mux-runner's
 * own log via the caller's `log()`. This exists so a human reading the
 * pipeline log alone sees the recovery event.
 */
export function appendPipelineRunnerMarker(sessionDir, message) {
    const target = path.join(sessionDir, 'pipeline-runner.log');
    if (!fs.existsSync(target))
        return; // standalone mux-runner — nothing to annotate
    try {
        fs.appendFileSync(target, `[${new Date().toISOString()}] [mux-runner] ${message}\n`);
    }
    catch { /* non-critical — the marker is also in mux-runner.log */ }
}
const isHaltExit = (r) => r === 'cancelled' || r === 'limit' || r === 'timeout_repeat';
const isFailureExit = (r) => r === 'error' || r === 'stall' || r === 'circuit_open' || r === 'rate_limit_exhausted' || r === 'timeout_repeat' || r === 'manager_persistent_hallucination' || r === 'iteration_cap_exhausted' || r === 'codex_unhealthy_consecutive_failures' || r === 'ticket_audit_failed';
// ---------------------------------------------------------------------------
// R-CNAR-6 — Spark codex smoke-run gate
// ---------------------------------------------------------------------------
/** Codex CLI surfaces transport, auth, and rate-limit failures with these markers. */
const CODEX_CLI_ERROR_PATTERNS = [
    /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/,
    /\bHTTP\s*(?:429|5\d\d)\b/,
    /\b429\s+Too\s+Many\s+Requests\b/i,
    /\b5\d\d\s+(?:Bad\s+Gateway|Internal\s+Server\s+Error|Service\s+Unavailable)\b/i,
    /\bcodex(?:\s+CLI)?[:\s]+(?:error|exited|failed|crashed)\b/i,
    /\bstream\s+(?:error|disconnected)\b/i,
    /\brate[_\s-]?limit(?:\s+exceeded|_exceeded)\b/i,
    /\b401\s+Unauthorized\b/i,
];
// R-BUNDLE-1: session-hash allowlist for bundle_bootstrap_mode auto-skip.
// Extend this table when a new bundle needs both gates bypassed at launch.
const BUNDLE_BOOTSTRAP_ALLOWLIST = {
    '2026-05-07-deferred-slots': new Set(['2026-05-07-488e6e1f']),
    '2026-05-08-mega': new Set(['2026-05-09-7ff82595']),
};
const SPARK_MODEL_PATTERN = /^gpt-5\.3-codex-spark/;
function ticketHasCodexCliError(ticketDir) {
    let entries;
    try {
        entries = fs.readdirSync(ticketDir);
    }
    catch {
        return false;
    }
    for (const file of entries) {
        if (!/^worker_session_\d+\.log$/.test(file))
            continue;
        let content;
        try {
            content = fs.readFileSync(path.join(ticketDir, file), 'utf-8');
        }
        catch {
            continue;
        }
        if (CODEX_CLI_ERROR_PATTERNS.some(re => re.test(content)))
            return true;
    }
    return false;
}
function isSparkGateActive(state) {
    if (state.backend !== 'codex')
        return false;
    const codexModel = typeof state.codex_model === 'string' ? state.codex_model : '';
    return SPARK_MODEL_PATTERN.test(codexModel);
}
function isFailedWithCodexError(sessionDir, ticket) {
    if (!ticket.id)
        return false;
    const status = (ticket.status ?? '').trim().toLowerCase();
    if (status !== 'failed')
        return false;
    return ticketHasCodexCliError(path.join(sessionDir, ticket.id));
}
/**
 * Pure decision helper for the R-CNAR-6 spark codex smoke-run gate.
 *
 * Active iff `state.backend === 'codex'` AND `state.codex_model` matches
 * `^gpt-5\.3-codex-spark`. When inactive, returns `allow / gate_inactive`.
 *
 * Halt criteria:
 *   (i) tickets[0] or tickets[1] has `status: Failed` AND a codex-CLI-error
 *       breadcrumb in any `worker_session_<pid>.log` under that ticket dir.
 *  (ii) any 3 consecutive tickets in canonical (collectTickets) order are
 *       Failed-with-codex-CLI-error breadcrumb.
 *
 * Bypass: `state.flags.skip_smoke_gate_reason='<reason>'` short-circuits to
 * `bypass`. Caller is responsible for emitting the `smoke_gate_bypassed`
 * activity event exactly once per session.
 */
export function evaluateSparkSmokeGate(state, sessionDir) {
    if (!isSparkGateActive(state)) {
        return { action: 'allow', reason: 'gate_inactive', rule: 'gate_inactive' };
    }
    const skipReasonRaw = state.flags?.skip_smoke_gate_reason;
    const skipReason = typeof skipReasonRaw === 'string' ? skipReasonRaw.trim() : '';
    if (skipReason.length > 0) {
        return { action: 'bypass', reason: skipReason, rule: 'bypassed' };
    }
    const tickets = collectTickets(sessionDir);
    let consecutive = 0;
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const failedWithErr = isFailedWithCodexError(sessionDir, ticket);
        if (i < 2 && failedWithErr) {
            return {
                action: 'halt',
                reason: `first 2 tickets must complete: ticket[${i}]=${ticket.id} failed with codex-CLI error`,
                rule: 'first_two_failed',
            };
        }
        consecutive = failedWithErr ? consecutive + 1 : 0;
        if (consecutive >= 3) {
            return {
                action: 'halt',
                reason: `3 consecutive ticket failures with codex-CLI errors (last: ${ticket.id})`,
                rule: 'three_consecutive_failed',
            };
        }
    }
    return { action: 'allow', reason: 'ok', rule: 'allow' };
}
const CIRCUIT_BREAKER_TIER_BUDGETS = {
    trivial: 3,
    small: 4,
    medium: 5,
    large: 12,
};
function isCircuitBreakerTier(value) {
    return Object.prototype.hasOwnProperty.call(CIRCUIT_BREAKER_TIER_BUDGETS, value);
}
function defaultCircuitBreakerBudget() {
    return { tier: 'medium', budget: CIRCUIT_BREAKER_TIER_BUDGETS.medium };
}
function parseTicketComplexityTier(content) {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== '---')
        return null;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '---')
            return null;
        const match = /^complexity_tier:\s*["']?([A-Za-z_-]+)["']?\s*$/.exec(line);
        if (!match)
            continue;
        const tier = match[1].toLowerCase();
        return isCircuitBreakerTier(tier) ? tier : null;
    }
    return null;
}
export function getCircuitBreakerBudget(state, sessionDir) {
    const cachedTier = typeof state.current_ticket_tier === 'string'
        ? state.current_ticket_tier.toLowerCase()
        : '';
    const rawCachedBudget = Number(state.current_ticket_budget);
    const cachedBudget = Number.isFinite(rawCachedBudget) ? rawCachedBudget : 0;
    if (isCircuitBreakerTier(cachedTier) && cachedBudget === CIRCUIT_BREAKER_TIER_BUDGETS[cachedTier]) {
        return { tier: cachedTier, budget: cachedBudget };
    }
    const ticket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
        ? state.current_ticket
        : null;
    if (!ticket) {
        const fallback = defaultCircuitBreakerBudget();
        state.current_ticket_tier = fallback.tier;
        state.current_ticket_budget = fallback.budget;
        return fallback;
    }
    const ticketPath = path.join(sessionDir, ticket, `linear_ticket_${ticket}.md`);
    let budget = defaultCircuitBreakerBudget();
    try {
        const tier = parseTicketComplexityTier(fs.readFileSync(ticketPath, 'utf-8'));
        if (tier)
            budget = { tier, budget: CIRCUIT_BREAKER_TIER_BUDGETS[tier] };
    }
    catch {
        budget = defaultCircuitBreakerBudget();
    }
    state.current_ticket_tier = budget.tier;
    state.current_ticket_budget = budget.budget;
    return budget;
}
function settingsWithCircuitBreakerBudget(settings, budget) {
    return {
        ...settings,
        noProgressThreshold: budget,
        halfOpenAfter: Math.min(settings.halfOpenAfter, Math.max(1, budget - 1)),
    };
}
function formatCircuitBreakerTripReason(reason, budget) {
    const match = /^No progress in (\d+) iterations(?:\..*)?$/.exec(reason);
    if (!match)
        return reason;
    return `No progress in ${match[1]} iterations (tier: ${budget.tier}, budget: ${budget.budget})`;
}
function clearCircuitBreakerBudgetCacheOnTicketChange(state, previousTicket) {
    if (previousTicket !== null && previousTicket !== state.current_ticket) {
        delete state.current_ticket_tier;
        delete state.current_ticket_budget;
    }
}
/**
 * Pure counter update: increment on same-ticket timeout, reset to 1 on
 * different-ticket timeout, zero on clean completion, pass-through otherwise.
 * `halt: true` when count reaches 2 on the same ticket.
 */
export function applyTimeoutCounter(input) {
    const { prev, ticketNow, timedOut, completedClean } = input;
    if (timedOut) {
        if (ticketNow !== null && ticketNow === prev.ticket) {
            const count = prev.count + 1;
            return { count, ticket: ticketNow, halt: count >= 2 };
        }
        return { count: 1, ticket: ticketNow, halt: false };
    }
    if (completedClean) {
        return { count: 0, ticket: null, halt: false };
    }
    return { count: prev.count, ticket: prev.ticket, halt: false };
}
/**
 * Halt side-effects for FR-B12/B14: reset CB (prevent orphan streak),
 * write state.json.activity entry, emit structured stderr JSON with
 * remediation_code=RAISE_TIMEOUT, safeDeactivate. Caller sets exitReason
 * and breaks the loop.
 */
export function executeTimeoutHalt(ctx) {
    const { statePath, sessionDir, ticketNow, timeoutCount } = ctx;
    resetCircuitBreaker(sessionDir, 'timeout_repeat halt');
    writeActivityEntry(statePath, {
        event: 'halt',
        halt_reason: 'timeout_repeat',
        halted_ticket: ticketNow,
        halted_at: new Date().toISOString(),
        timeout_count: timeoutCount,
        remediation: `Re-run via /pickle-pipeline --worker-timeout <N> for fresh session, or edit worker_timeout_seconds in ${statePath} and run /pickle-retry for this session.`,
    });
    console.error(JSON.stringify({
        exit_reason: 'timeout_repeat',
        remediation_code: 'RAISE_TIMEOUT',
        ticket_id: ticketNow,
        timeout_count: timeoutCount,
        message: 'Ticket timed out on 2 consecutive attempts.',
        state_path: statePath,
    }));
    recordExitReason(statePath, 'timeout_repeat');
    safeDeactivate(statePath);
}
function ctxNow(ctx) {
    return ctx.now ? ctx.now() : Date.now();
}
function ctxReadState(ctx) {
    return (ctx.readState || readRunnerState)(ctx.statePath);
}
function ctxDeactivate(ctx) {
    (ctx.deactivate || safeDeactivate)(ctx.statePath);
}
function ctxFinalize(ctx, exitReason) {
    if (ctx.deactivate) {
        // Test seam: caller injected a deactivate hook — preserve old contract.
        ctx.deactivate(ctx.statePath);
        return;
    }
    finalizeTerminalState(ctx.statePath, {
        step: 'completed',
        runnerIteration: ctx.iteration,
        exitReason,
    });
}
function writeLoopState(ctx, targetPath, value) {
    (ctx.writeState || writeStateFile)(targetPath, value);
}
function applyTimeoutCounterForLoop(input) {
    return applyTimeoutCounter({ ...input });
}
function unlinkLoopPath(ctx, targetPath) {
    if (ctx.unlink) {
        ctx.unlink(targetPath);
        return;
    }
    try {
        fs.unlinkSync(targetPath);
    }
    catch { /* ok */ }
}
export function validateStartupState(state, statePath) {
    const rawObj = state;
    const issues = [];
    const maxIterField = rawObj.max_iterations;
    const rawMaxIter = Number(maxIterField);
    if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
        issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
    }
    const rawTimeout = Number(rawObj.worker_timeout_seconds);
    if (!Number.isFinite(rawTimeout) || rawTimeout <= 0)
        issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
    else if (rawTimeout > 86400)
        issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
    const iterField = rawObj.iteration;
    const rawIter = Number(iterField);
    if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0)
        issues.push(`iteration must be >= 0 (got ${iterField})`);
    if (issues.length > 0)
        throw new Error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
}
export function setupSignalHandlers(statePath, log) {
    const handleShutdownSignal = (signal) => {
        const backend = readBackendForActivity(statePath);
        log(`Received ${signal} — deactivating session`);
        recordExitReason(statePath, 'signal');
        safeDeactivate(statePath);
        removeRunnerSessionMapEntry(statePath, log);
        if (currentChildProc && !currentChildProc.killed)
            currentChildProc.kill('SIGTERM');
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(statePath)), mode: 'tmux', backend });
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}
function readBackendForActivity(statePath) {
    try {
        return resolveBackend(readRunnerState(statePath));
    }
    catch {
        return resolveBackend(null);
    }
}
export function classifyCapCheckReadError(err, sessionDir, log) {
    const msg = safeErrorMessage(err);
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 'SCHEMA_MISMATCH') {
        log(`WARN: state.json schema mismatch on cap-check read: ${msg}. Retrying next iteration.`);
        logActivity({
            event: 'cap_check_failed_schema_mismatch',
            source: 'pickle',
            session: path.basename(sessionDir),
            error: msg,
        });
        return 'continue';
    }
    log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
    return 'exit_error';
}
export function shouldExitMainLoop(state, ctx) {
    if (state.active !== true) {
        ctx.log('Session inactive. Exiting.');
        return { exit: true, reason: 'cancelled' };
    }
    const curIter = Number.isFinite(Number(state.iteration)) ? Number(state.iteration) : 0;
    const limitAction = shouldExitForLimits(state, ctx, curIter);
    if (limitAction.exit)
        return limitAction;
    if (ctx.cbEnabled && ctx.cbState && !canExecute(ctx.cbState)) {
        ctx.log(`Circuit breaker OPEN: ${ctx.cbState.reason}. Exiting.`);
        ctxDeactivate(ctx);
        return { exit: true, reason: 'circuit_open' };
    }
    if (!ctx.cbEnabled && curIter === ctx.lastStateIteration && (ctx.stallCount || 0) >= 1) {
        ctx.log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
        ctxDeactivate(ctx);
        return { exit: true, reason: 'stall' };
    }
    return { exit: false };
}
function shouldExitForLimits(state, ctx, curIter) {
    const maxIter = Number.isFinite(Number(state.max_iterations)) ? Number(state.max_iterations) : 0;
    if (maxIter > 0 && curIter >= maxIter) {
        ctx.log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
        ctxDeactivate(ctx);
        return { exit: true, reason: 'limit' };
    }
    const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
    const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(ctxNow(ctx) / 1000) - startEpoch) : 0;
    if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
        ctx.log(`Time limit reached (${elapsed}s). Exiting.`);
        ctxDeactivate(ctx);
        return { exit: true, reason: 'limit' };
    }
    return { exit: false };
}
export async function processRateLimitCycle(state, ctx) {
    const exitResult = ctx.exitResult;
    if (exitResult?.type !== 'api_limit')
        return { kind: 'noop' };
    const consecutiveRateLimits = (ctx.consecutiveRateLimits || 0) + 1;
    const maxRetries = ctx.maxRateLimitRetries || 3;
    const waitMinutes = ctx.rateLimitWaitMinutes || 5;
    ctx.log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRetries})`);
    const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRetries, waitMinutes);
    if (rlAction.action === 'bail') {
        logActivity({ event: 'rate_limit_exhausted', source: 'pickle', session: path.basename(ctx.sessionDir), error: `max retries (${maxRetries}) exceeded, no resetsAt available` });
        ctxDeactivate(ctx);
        return { kind: 'break', reason: 'rate_limit_exhausted', consecutiveRateLimits };
    }
    return processRateLimitWait(state, ctx, exitResult, rlAction, consecutiveRateLimits);
}
async function processRateLimitWait(state, ctx, exitResult, rlAction, consecutiveRateLimits) {
    const waitSource = rlAction.waitSource;
    const waitPath = path.join(ctx.sessionDir, 'rate_limit_wait.json');
    const waitUntil = new Date(ctxNow(ctx) + rlAction.waitMs).toISOString();
    logActivity({ event: 'rate_limit_wait', source: 'pickle', session: path.basename(ctx.sessionDir), duration_min: Math.ceil(rlAction.waitMs / 60_000) });
    writeLoopState(ctx, waitPath, {
        waiting: true, reason: 'API rate limit', started_at: new Date(ctxNow(ctx)).toISOString(), wait_until: waitUntil,
        consecutive_waits: consecutiveRateLimits, rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
        resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null, wait_source: waitSource,
    });
    const limitedWait = await waitThroughRateLimit(state, ctx, rlAction.waitMs);
    if (limitedWait.exit)
        return { kind: 'break', reason: limitedWait.reason, consecutiveRateLimits };
    unlinkLoopPath(ctx, waitPath);
    const nextConsecutive = rlAction.resetCounter ? 0 : consecutiveRateLimits;
    logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(ctx.sessionDir) });
    const handoffContent = [
        buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1), '',
        `NOTE: Resumed after ${Math.ceil(rlAction.waitMs / 60_000)}-minute API rate limit wait (source: ${waitSource}).`,
        'Resume from current phase — do not repeat the rate-limited iteration.',
    ].join('\n');
    (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffContent, process.pid, ctx.log);
    return { kind: 'continue', consecutiveRateLimits: nextConsecutive };
}
async function waitThroughRateLimit(state, ctx, computedWaitMs) {
    const epoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
    const maxMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
    let actualWaitMs = computedWaitMs;
    if (maxMins > 0 && epoch > 0) {
        const remaining = (maxMins * 60) - (Math.floor(ctxNow(ctx) / 1000) - epoch);
        if (remaining <= 0) {
            ctxDeactivate(ctx);
            return { exit: true, reason: 'limit' };
        }
        actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
    }
    const waitEnd = ctxNow(ctx) + actualWaitMs;
    while (ctxNow(ctx) < waitEnd) {
        await (ctx.sleep || sleep)(Defaults.RATE_LIMIT_POLL_MS);
        try {
            if (ctxReadState(ctx).active !== true)
                return { exit: true, reason: 'cancelled' };
        }
        catch { /* proceed */ }
        if (maxMins > 0 && epoch > 0 && Math.floor(ctxNow(ctx) / 1000) - epoch >= maxMins * 60)
            return { exit: true, reason: 'limit' };
    }
    return { exit: false };
}
export async function processIterationOutcome(state, outcome, ctx) {
    const result = outcome.completion;
    const timeoutAction = processTimeoutOutcome(state, outcome, ctx);
    if (timeoutAction.kind === 'break')
        return timeoutAction;
    const cbAction = recordCircuitBreakerOutcome(state, result, ctx);
    if (cbAction.kind === 'break')
        return { ...timeoutAction, ...cbAction };
    const branchAction = await processCompletionBranch(state, result, ctx);
    return { ...timeoutAction, ...branchAction, cbState: cbAction.cbState };
}
function processTimeoutOutcome(state, outcome, ctx) {
    let ticketForTimeout = state.current_ticket || null;
    try {
        ticketForTimeout = ctxReadState(ctx).current_ticket || null;
    }
    catch { /* keep pre-iteration ticket */ }
    const counterNext = applyTimeoutCounterForLoop({
        prev: { count: ctx.timeoutCount || 0, ticket: ctx.lastTimeoutTicket || null },
        ticketNow: ticketForTimeout,
        timedOut: outcome.timedOut === true,
        completedClean: outcome.completion === 'task_completed',
    });
    if (outcome.timedOut) {
        (ctx.writeTimeout || writeTimeoutStub)(ctx.sessionDir, {
            ticketId: ticketForTimeout, iteration: ctx.iteration, wallSeconds: outcome.wallSeconds,
            workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0, timeoutCount: counterNext.count,
            logFile: ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
        });
    }
    if (!counterNext.halt)
        return { kind: 'noop', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
    ctx.log(`Timeout halt: ticket ${ticketForTimeout} timed out ${counterNext.count} consecutive iterations`);
    executeTimeoutHalt({ statePath: ctx.statePath, sessionDir: ctx.sessionDir, ticketNow: ticketForTimeout, timeoutCount: counterNext.count });
    // Preserves the legacy source-order invariant: exitReason = 'timeout_repeat' before break.
    return { kind: 'break', reason: 'timeout_repeat', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
}
function recordCircuitBreakerOutcome(state, result, ctx) {
    if (!ctx.cbEnabled || !ctx.cbState || !ctx.cbSettings || result === 'error' || result === 'inactive')
        return { kind: 'noop', cbState: ctx.cbState };
    const errorSig = readCircuitBreakerErrorSignature(ctx);
    const postIterState = readPostIterationState(state, ctx);
    clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, ctx.cbState.last_known_ticket);
    const progress = detectProgress(postIterState.working_dir || process.cwd(), ctx.cbState.last_known_head, ctx.cbState.last_known_step, postIterState.step, ctx.cbState.last_known_ticket, postIterState.current_ticket);
    const budget = getCircuitBreakerBudget(postIterState, ctx.sessionDir);
    const cbSettings = settingsWithCircuitBreakerBudget(ctx.cbSettings, budget.budget);
    const prevCBState = ctx.cbState.state;
    const cbState = recordIterationResult(ctx.cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, ctx.iteration, cbSettings);
    cbState.last_known_head = progress.currentHead;
    cbState.last_known_step = postIterState.step;
    cbState.last_known_ticket = postIterState.current_ticket;
    if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
    }
    if (ctx.cbPath)
        writeLoopState(ctx, ctx.cbPath, cbState);
    if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(ctx.sessionDir), error: cbState.reason });
        ctx.log(`Circuit breaker tripped: ${cbState.reason}`);
        ctxDeactivate(ctx);
        return { kind: 'break', reason: 'circuit_open', cbState };
    }
    if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
        logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(ctx.sessionDir) });
        ctx.log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
    }
    return { kind: 'noop', cbState };
}
function readCircuitBreakerErrorSignature(ctx) {
    try {
        const logContent = fs.readFileSync(ctx.iterLogFile || '', 'utf-8');
        return logContent ? extractErrorSignature(logContent) : null;
    }
    catch {
        return null;
    }
}
function readPostIterationState(state, ctx) {
    try {
        return ctxReadState(ctx);
    }
    catch {
        return state;
    }
}
export async function processCompletionBranch(state, result, ctx) {
    if (result === 'task_completed')
        return processTaskCompleted(state, ctx);
    if (result === 'review_clean')
        return processReviewClean(ctx);
    if (result === 'inactive') {
        ctx.log('Session deactivated. Exiting loop.');
        return { kind: 'break', reason: 'cancelled' };
    }
    if (result === 'error') {
        // Codex tmux_mode runs one long-lived manager across many tickets.
        // A 4h hang-guard SIGTERM (or other subprocess error) does not mean
        // the work is doomed — relaunch the manager and let it pick up the
        // remaining ticket queue. Bounded by CODEX_MANAGER_RELAUNCH_CAP and
        // gated on circuit-breaker state.
        let postState = state;
        try {
            postState = ctxReadState(ctx);
        }
        catch { /* fall back to pre-iteration state */ }
        const exitKind = classifyManagerRelaunchExit(postState, ctx.outcome, ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`));
        const decision = evaluateManagerRelaunch(postState, collectTickets(ctx.sessionDir), ctx.cbState ?? null, exitKind);
        if (decision.reason === 'time_limit') {
            ctx.log('Time limit reached. Exiting.');
            finalizeTerminalState(ctx.statePath, { step: 'completed', runnerIteration: ctx.iteration, exitReason: 'limit' });
            return { kind: 'break', reason: 'limit' };
        }
        if (decision.shouldRelaunch && decision.exitKind !== 'other_error') {
            const relaunchBackend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
            ctx.log(`${relaunchBackend} manager subprocess exited via ${decision.exitKind} with ${decision.pendingCount} ticket(s) still pending — ` +
                `relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`);
            recordManagerRelaunch(ctx.statePath, ctx.sessionDir, decision, ctx.iteration, ctx.log);
            // Relaunch IS progress — reset stall counter. Do NOT deactivate.
            // Do NOT reset the circuit breaker: a 4h hang-guard timeout is
            // exactly the kind of repeated event the CB should observe.
            return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: decision.pendingCount, resetStall: true };
        }
        ctx.log('Subprocess error. Exiting loop.');
        ctxDeactivate(ctx);
        return { kind: 'break', reason: 'error' };
    }
    await (ctx.sleep || sleep)(1000);
    return { kind: 'noop' };
}
function processTaskCompleted(state, ctx) {
    let curState;
    try {
        curState = ctxReadState(ctx);
    }
    catch (err) {
        ctx.log(`ERROR: Cannot read state.json after task_completed: ${safeErrorMessage(err)}. Exiting.`);
        return { kind: 'break', reason: 'success' };
    }
    const decision = evaluateEpicCompletion({
        tickets: withFreshTicketStatuses(ctx.sessionDir, collectTickets(ctx.sessionDir)), currentTicket: curState.current_ticket || null,
        priorFalseCount: Number(curState.false_epic_completed_count) || 0,
        priorFalseTicket: curState.false_epic_completed_ticket ?? null,
    });
    if (decision.kind === 'persistent_hallucination') {
        ctxDeactivate(ctx);
        return { kind: 'break', reason: 'manager_persistent_hallucination' };
    }
    if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
        const handoffSummary = buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1);
        (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffSummary, process.pid, ctx.log);
        return { kind: 'continue', resetStall: true };
    }
    if (curState.current_ticket) {
        markTicketDone(ctx.sessionDir, curState.current_ticket);
        try {
            runBetweenTicketFastGate({
                statePath: ctx.statePath,
                workingDir: curState.working_dir || state.working_dir || process.cwd(),
                completedTicketId: curState.current_ticket,
                nextTicketId: null,
                landedStatus: 'done',
                log: ctx.log,
                now: ctx.now,
            });
        }
        catch (err) {
            ctx.log(`between-ticket fast gate failed after final completion (ignored): ${safeErrorMessage(err)}`);
        }
    }
    if (curState.chain_meeseeks === true) {
        if (ctx.updateState)
            ctx.updateState(s => Object.assign(s, ctx.transitionToMeeseeks ? ctx.transitionToMeeseeks(s) : transitionToMeeseeks(s, ctx.extensionRoot)));
        return { kind: 'continue', resetStall: true };
    }
    ctx.log('Task completed. Exiting loop.');
    ctxFinalize(ctx, 'success');
    return { kind: 'break', reason: 'success' };
}
function processReviewClean(ctx) {
    let curState;
    try {
        curState = ctxReadState(ctx);
    }
    catch (err) {
        ctx.log(`ERROR: Cannot read state.json after review_clean: ${safeErrorMessage(err)}. Treating as completed.`);
        ctxFinalize(ctx, 'success');
        return { kind: 'break', reason: 'success' };
    }
    const minIter = Number.isFinite(Number(curState.min_iterations)) ? Number(curState.min_iterations) : 0;
    const curIterNow = Number.isFinite(Number(curState.iteration)) ? Number(curState.iteration) : 0;
    if (minIter > 0 && curIterNow < minIter) {
        ctx.log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
        return { kind: 'noop' };
    }
    ctx.log('Review clean. Exiting loop.');
    ctxFinalize(ctx, 'success');
    return { kind: 'break', reason: 'success' };
}
/**
 * R-WSE-2: Emit worker_partial_lifecycle_exit when research-review is APPROVED
 * but downstream lifecycle artifacts are missing from the ticket dir.
 */
export function checkPartialLifecycleExit(sessionDir, statePath, ticketId) {
    const ticketDir = path.join(sessionDir, ticketId);
    let files;
    try {
        files = fs.readdirSync(ticketDir);
    }
    catch {
        return;
    }
    if (!files.includes('research_review.md'))
        return;
    let reviewContent;
    try {
        reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8');
    }
    catch {
        return;
    }
    if (!reviewContent.trimEnd().endsWith('APPROVED'))
        return;
    const downstreamPrefixes = ['plan', 'conformance', 'code_review'];
    const artifactsMissing = downstreamPrefixes.filter(prefix => !files.some(f => f === `${prefix}.md` || f.startsWith(`${prefix}_`)));
    if (artifactsMissing.length === 0)
        return;
    let sessionLogSize = 0;
    for (const file of files) {
        if (/^worker_session_\d+\.log$/.test(file)) {
            try {
                sessionLogSize += fs.statSync(path.join(ticketDir, file)).size;
            }
            catch { /* ignore */ }
        }
    }
    writeActivityEntry(statePath, {
        event: 'worker_partial_lifecycle_exit',
        ts: new Date().toISOString(),
        source: 'pickle',
        ticket: ticketId,
        gate_payload: { artifacts_missing: artifactsMissing, session_log_size: sessionLogSize },
    });
}
/**
 * R-WSE-3: Emit a stderr breadcrumb when a ticket has status Failed
 * but its research_review.md ends in APPROVED.
 */
export function checkFailedAfterResearchApproved(sessionDir, ticketId) {
    let status;
    try {
        status = getTicketStatus(sessionDir, ticketId);
    }
    catch {
        return;
    }
    if (normalizeTicketStatus(status) !== 'failed')
        return;
    const ticketDir = path.join(sessionDir, ticketId);
    let reviewContent;
    try {
        reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8');
    }
    catch {
        return;
    }
    if (!reviewContent.trimEnd().endsWith('APPROVED'))
        return;
    process.stderr.write(`[warn] [${new Date().toISOString()}] ⚠ ticket ${ticketId} failed AFTER research APPROVED — see ${sessionDir}/${ticketId}/\n`);
}
export function detectPkgJsonVersionDrift(srcPath, depPath, statePath) {
    const ts = new Date().toISOString();
    let srcPkg;
    let depPkg;
    try {
        srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
    }
    catch {
        writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
        return;
    }
    try {
        depPkg = JSON.parse(fs.readFileSync(depPath, 'utf-8'));
    }
    catch {
        writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
        return;
    }
    const srcVersion = String(srcPkg.version ?? '');
    const depVersion = String(depPkg.version ?? '');
    if (srcVersion === depVersion)
        return;
    const srcOther = Object.fromEntries(Object.entries(srcPkg).filter(([k]) => k !== 'version'));
    const depOther = Object.fromEntries(Object.entries(depPkg).filter(([k]) => k !== 'version'));
    const onlyVersionDiffers = JSON.stringify(srcOther) === JSON.stringify(depOther);
    const eventKind = onlyVersionDiffers ? 'pkgjson_only_revert_detected' : 'pkgjson_full_drift_detected';
    if (onlyVersionDiffers) {
        process.stderr.write(`[pickle-rick] pkgjson revert detected: src=${srcVersion} dep=${depVersion}\n`);
    }
    writeActivityEntry(statePath, {
        event: eventKind,
        src_version: srcVersion,
        dep_version: depVersion,
        src_path: srcPath,
        dep_path: depPath,
        ts,
    });
}
async function main() {
    try {
        assertSchemaVersionDeployParity();
    }
    catch (err) {
        if (err instanceof SchemaVersionDeployDriftError) {
            process.stderr.write(`${safeErrorMessage(err)}\n`);
            process.exit(1);
        }
        throw err;
    }
    await runMuxRunnerMain();
}
// eslint-disable-next-line -- legacy mux runner loop retained behavior-preserving for global bin acceptance
async function runMuxRunnerMain() {
    const sessionDir = process.argv[2];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
        console.error('Usage: node mux-runner.js <session-dir>');
        process.exit(1);
    }
    const extensionRoot = getExtensionRoot();
    const statePath = path.join(sessionDir, 'state.json');
    const runnerLog = path.join(sessionDir, 'mux-runner.log');
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        process.stderr.write(line);
    };
    log('mux-runner started');
    // Take ownership: setup.js writes active: false in tmux mode so the main
    // Claude window's stop hook is released immediately. We set active: true here
    // before monitor recovery and before entering the loop so workers and state
    // readers see a live session.
    let ownerState;
    try {
        ownerState = readRunnerState(statePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        throw new Error(`Cannot read initial state.json: ${msg}`);
    }
    // Startup validation — mux-runner only. microverse-runner owns its own sentinels
    // (worker_timeout_seconds=0 disables per-iteration timeout there; max_iterations=0
    // means unlimited iterations there). These rules must NOT be shared.
    {
        // Use raw object to detect null (JSON-serialized NaN) vs absent vs zero
        const rawObj = ownerState;
        const issues = [];
        const maxIterField = rawObj.max_iterations;
        const rawMaxIter = Number(maxIterField);
        if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
            issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
        }
        const rawTimeout = Number(rawObj.worker_timeout_seconds);
        if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
            issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
        }
        else if (rawTimeout > 86400) {
            issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
        }
        // iteration=0 is valid (fresh session); null/undefined are not — check explicitly
        // before numeric coercion since Number(null)=0 would otherwise pass.
        const iterField = rawObj.iteration;
        const rawIter = Number(iterField);
        if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) {
            issues.push(`iteration must be >= 0 (got ${iterField})`);
        }
        if (issues.length > 0) {
            console.error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
            process.exit(2);
        }
    }
    if (ownerState.tmux_mode === true &&
        (ownerState.active !== true || ownerState.pid !== process.pid)) {
        sm.update(statePath, s => {
            s.active = true;
            s.pid = process.pid;
        });
        clearExitReason(statePath);
        log(ownerState.active === true
            ? 'Session ownership refreshed (pid updated)'
            : 'Session ownership taken (active: false → true)');
    }
    // Auto-spawn the 4-pane monitor window. Previously each pickle skill prompt
    // (pickle-tmux, pickle-pipeline, pickle-refine-prd, …) ended with a manual
    // `bash tmux-monitor.sh …` step that the agent sometimes dropped silently.
    // Owning it here makes it unskippable. No-op when not inside tmux.
    try {
        const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
        log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
    catch (err) {
        log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
    }
    // R-PJV-2: one-shot package.json version drift detector.
    try {
        const srcPkgPath = path.join(ownerState.working_dir ?? '', 'extension', 'package.json');
        const depPkgPath = path.join(extensionRoot, 'extension', 'package.json');
        detectPkgJsonVersionDrift(srcPkgPath, depPkgPath, statePath);
    }
    catch (err) {
        log(`detectPkgJsonVersionDrift: threw (ignored): ${safeErrorMessage(err)}`);
    }
    // R-ICP-5: phantom-Done filesystem watcher. Catches Todo→Done flips that
    // happen mid-iteration (between the iteration-boundary backstop in
    // correctPhantomDoneTickets). One fs.watch per linear_ticket_*.md file.
    // Closed on SIGTERM/SIGINT/SIGHUP/exit so we don't leak file descriptors.
    const phantomDoneWatchers = [];
    let phantomDoneWatchersClosed = false;
    // Per-ticket debounce timers, last-known prior status (the value before a
    // possible Done flip), and re-check counters. Re-checks are capped at 2 per
    // ticket per minute to bound the cost of pathological re-flip loops.
    const phantomDoneDebounceMs = 150;
    const phantomDoneRecheckMs = 300;
    const phantomDoneRecheckWindowMs = 60_000;
    const phantomDoneRecheckCap = 2;
    const debounceTimers = new Map();
    const priorStatusMap = new Map();
    const recheckTimestamps = new Map();
    const closePhantomDoneWatchers = () => {
        if (phantomDoneWatchersClosed)
            return;
        phantomDoneWatchersClosed = true;
        for (const watcher of phantomDoneWatchers) {
            try {
                watcher.close();
            }
            catch { /* best-effort */ }
        }
        phantomDoneWatchers.length = 0;
        for (const timer of debounceTimers.values()) {
            try {
                clearTimeout(timer);
            }
            catch { /* best-effort */ }
        }
        debounceTimers.clear();
    };
    const refreshPriorStatusAfterInspect = (ticketId, ticketFile, result) => {
        if (result.reason === 'reverted' && result.priorStatus) {
            priorStatusMap.set(ticketId, result.priorStatus);
            return;
        }
        if (result.reason !== 'not_done' && result.reason !== 'has_completion_commit')
            return;
        try {
            const live = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
            if (live)
                priorStatusMap.set(ticketId, live);
        }
        catch { /* best-effort */ }
    };
    const emitBackfillEvent = (ticketId, commit, ts) => {
        const shortSha = commit.slice(0, 7);
        process.stderr.write(`phantom-Done inferred completion commit for ticket ${ticketId} with commit ${shortSha} (work was done, explicit field was missing)\n`);
        try {
            writeActivityEntry(statePath, {
                event: 'phantom_done_backfilled',
                source: 'pickle',
                session: path.basename(sessionDir),
                ticket: ticketId,
                commit_hash: commit,
                ts,
            });
            writeActivityEntry(statePath, {
                event: 'completion_commit_inferred_from_git',
                source: 'pickle',
                session: path.basename(sessionDir),
                ticket_id: ticketId,
                sha: commit,
                ts,
            });
        }
        catch (err) {
            log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
        }
    };
    const emitRevertEvent = (ticketId, result, ts) => {
        const priorMsg = result.priorStatus ?? 'Todo';
        if (result.gitFailureReason) {
            process.stderr.write(`phantom-Done detected for ticket ${ticketId} — reverted (git lookup failed: ${result.gitFailureReason})\n`);
        }
        else {
            process.stderr.write(`phantom-Done detected for ticket ${ticketId} — reverted to ${priorMsg} (no completion_commit field, no matching commit in HEAD~10)\n`);
        }
        try {
            writeActivityEntry(statePath, {
                event: 'phantom_done_detected',
                source: 'pickle',
                session: path.basename(sessionDir),
                ticket: ticketId,
                completion_commit_present: false,
                ts,
            });
        }
        catch (err) {
            log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
        }
    };
    const scheduleRecheckIfBudget = (ticketId, ticketFile, workingDir) => {
        const now = Date.now();
        const stamps = (recheckTimestamps.get(ticketId) ?? []).filter((t) => now - t < phantomDoneRecheckWindowMs);
        if (stamps.length >= phantomDoneRecheckCap) {
            recheckTimestamps.set(ticketId, stamps);
            log(`phantom-Done watcher: re-check cap reached for ${ticketId} — skipping further re-checks this minute`);
            return;
        }
        stamps.push(now);
        recheckTimestamps.set(ticketId, stamps);
        setTimeout(() => {
            if (phantomDoneWatchersClosed)
                return;
            handlePhantomDoneEvent(ticketId, ticketFile, workingDir, true);
        }, phantomDoneRecheckMs);
    };
    const handlePhantomDoneEvent = (ticketId, ticketFile, workingDir, isRecheck) => {
        const prior = priorStatusMap.get(ticketId) ?? 'Todo';
        let result;
        try {
            result = inspectPhantomDoneTicketFile(ticketFile, sessionDir, workingDir, prior);
        }
        catch (err) {
            log(`phantom-Done watcher: inspect threw for ${ticketId} (ignored): ${safeErrorMessage(err)}`);
            return;
        }
        refreshPriorStatusAfterInspect(ticketId, ticketFile, result);
        if (!result.changed)
            return;
        const ts = new Date().toISOString();
        if (result.reason === 'backfilled' && result.commit) {
            emitBackfillEvent(ticketId, result.commit, ts);
            return;
        }
        if (result.reason !== 'reverted')
            return;
        emitRevertEvent(ticketId, result, ts);
        if (!isRecheck)
            scheduleRecheckIfBudget(ticketId, ticketFile, workingDir);
    };
    const installPhantomDoneWatchers = () => {
        let installed = 0;
        let skipped = 0;
        for (const ticket of collectTickets(sessionDir)) {
            if (!ticket.id) {
                skipped++;
                continue;
            }
            const ticketFile = path.join(sessionDir, ticket.id, `linear_ticket_${ticket.id}.md`);
            if (!fs.existsSync(ticketFile)) {
                skipped++;
                continue;
            }
            const ticketId = ticket.id;
            const ticketWorkingDir = ticket.working_dir || ownerState.working_dir || process.cwd();
            // Seed prior status from disk so the first revert restores the right
            // value (Todo vs. In Progress) instead of defaulting to Todo.
            try {
                const seed = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
                if (seed && seed.toLowerCase() !== 'done') {
                    priorStatusMap.set(ticketId, seed);
                }
            }
            catch { /* best-effort */ }
            try {
                const watcher = fs.watch(ticketFile, { persistent: false }, (event) => {
                    if (event !== 'change')
                        return;
                    // Debounce: coalesce rapid-fire change events into a single read.
                    const existing = debounceTimers.get(ticketId);
                    if (existing)
                        clearTimeout(existing);
                    const timer = setTimeout(() => {
                        debounceTimers.delete(ticketId);
                        if (phantomDoneWatchersClosed)
                            return;
                        handlePhantomDoneEvent(ticketId, ticketFile, ticketWorkingDir, false);
                    }, phantomDoneDebounceMs);
                    debounceTimers.set(ticketId, timer);
                });
                phantomDoneWatchers.push(watcher);
                installed++;
            }
            catch (err) {
                log(`phantom-Done watcher: fs.watch threw for ${ticket.id} (ignored): ${safeErrorMessage(err)}`);
                skipped++;
            }
        }
        log(`phantom-Done watcher: installed=${installed} skipped=${skipped}`);
    };
    installPhantomDoneWatchers();
    process.on('exit', closePhantomDoneWatchers);
    // Graceful shutdown: deactivate session on SIGTERM/SIGINT so it doesn't
    // remain orphaned with active: true when the tmux pane is closed.
    const handleShutdownSignal = (signal) => {
        const backend = readBackendForActivity(statePath);
        log(`Received ${signal} — deactivating session`);
        recordExitReason(statePath, 'signal');
        safeDeactivate(statePath);
        removeRunnerSessionMapEntry(statePath, log);
        if (currentChildProc && !currentChildProc.killed) {
            currentChildProc.kill('SIGTERM');
        }
        closePhantomDoneWatchers();
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux', backend });
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
    // Clean up stale rate_limit_wait.json from a previous crashed session
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    try {
        fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json'));
    }
    catch { /* not present */ }
    const cbSettings = loadSettings(extensionRoot);
    const cbEnabled = cbSettings.enabled;
    let cbState = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);
    const startTime = Date.now();
    let iteration = 0;
    let meeseeksPassCount = 0;
    let lastStateIteration = -1;
    let stallCount = 0;
    let consecutiveRateLimits = 0;
    let previousTicket = null;
    let previousTicketStartCommit = null;
    let exitReason = 'error';
    // Non-persisted per-ticket timeout counter (FR-B3/B4) — resets on runner restart.
    let timeoutCount = 0;
    let lastTimeoutTicket = null;
    // Commit-pending probe: track the last outer-loop iteration where state.iteration
    // advanced. Used to detect stagnation independently of the circuit breaker (the
    // probe runs whether CB is enabled or not).
    let lastProgressOuterIteration = 0;
    let lastObservedStateIteration = -1;
    // Settings bag for the commit-pending probe threshold (default 2). Read once
    // at startup; the loop is short-lived enough that hot-reloading isn't worth
    // the disk traffic.
    const probeSettings = loadSettingsBag(extensionRoot, 'mux-runner:commit-pending-probe:settings');
    const rawProbeThreshold = Number(probeSettings.commit_pending_probe_threshold);
    const commitPendingProbeThreshold = Number.isFinite(rawProbeThreshold) && rawProbeThreshold > 0 ? rawProbeThreshold : 2;
    let readinessGateChecked = false;
    let ticketAuditGateChecked = false;
    let smokeGateBypassEmitted = false;
    let bundleBootstrapApplied = false;
    while (true) {
        let state;
        try {
            state = readRunnerState(statePath);
        }
        catch (err) {
            const decision = classifyCapCheckReadError(err, sessionDir, log);
            if (decision === 'continue') {
                await sleep(1000);
                continue;
            }
            exitReason = 'error';
            break;
        }
        if (state.active !== true) {
            log('Session inactive. Exiting.');
            exitReason = 'cancelled';
            break;
        }
        state = clearStalePerTicketCacheAtIterationStart(statePath, state, log);
        const rawGlobalMaxIter = Number(state.max_iterations);
        const globalMaxIter = Number.isFinite(rawGlobalMaxIter) ? rawGlobalMaxIter : 0;
        const ticketCacheValid = isValidPerTicketCapCache(state);
        const ticketMaxIter = ticketCacheValid
            ? Number(state.current_ticket_max_iterations)
            : 0;
        const rawCurIter = Number(state.iteration);
        const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
        const budgetIter = ticketBudgetIterationCount(state, curIter);
        // R-ICP-1 + R-CNAR-1 part 2: two independent cap exits.
        //   (a) PER-TICKET budget exhaustion — current ticket isn't progressing
        //       within its tier ceiling (current_ticket_max_iterations).
        //   (b) GLOBAL manager-loop cap exhaustion — total iterations across all
        //       tickets reached operator-set state.max_iterations.
        // Both exit_reason='iteration_cap_exhausted' so pipeline-runner halts
        // (exit code 3, R-ICP-1 contract). Forensic-style deactivation preserves
        // step/current_ticket so postmortem can show the unfinished queue. The
        // `Max iterations reached ...` log line is retained as a stable marker
        // for grep-based forensics.
        //
        // R-CNAR-7 stale-cache guard: when state.current_ticket is null/undefined
        // but state.current_ticket_max_iterations carries a stale value from the
        // previously-completed ticket, the per-ticket cap-check would fire with
        // no ticket to attribute the exit to. This is the run-#6 attempt-1 trip:
        // a clean-success exit via finalizeTerminalState left max_iterations
        // populated; --resume re-entered the loop and the very first cap-check
        // tripped before any ticket started. Self-heal: emit
        // cap_check_skipped_stale_cache + clear the stale fields, continue.
        if (shouldEmitStalePerTicketCapSkip(state)) {
            log(stalePerTicketCacheDiagnostic(state));
            logActivity({
                event: 'cap_check_skipped_stale_cache',
                source: 'pickle',
                session: path.basename(sessionDir),
                iteration: curIter,
                gate_payload: {
                    current_ticket: state.current_ticket,
                    current_ticket_max_iterations: state.current_ticket_max_iterations,
                    current_ticket_budget_start_iteration: state.current_ticket_budget_start_iteration,
                    current_ticket_tier: state.current_ticket_tier,
                },
            });
        }
        else if (ticketMaxIter > 0 && budgetIter >= ticketMaxIter) {
            const tier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : 'unknown';
            const ticketId = state.current_ticket ?? 'unknown';
            log(`mux-runner exiting with code 3: per-ticket budget (${budgetIter}/${ticketMaxIter}, tier=${tier}) exhausted on ticket ${ticketId} without ${PromiseTokens.EPIC_COMPLETED} promise`);
            log(`Max iterations reached (${budgetIter}/${ticketMaxIter}). Exiting.`);
            recordExitReason(statePath, 'iteration_cap_exhausted');
            safeDeactivate(statePath);
            exitReason = 'iteration_cap_exhausted';
            break;
        }
        if (globalMaxIter > 0 && curIter >= globalMaxIter) {
            log(`mux-runner exiting with code 3: global iteration cap (${curIter}/${globalMaxIter}) exhausted without ${PromiseTokens.EPIC_COMPLETED} promise`);
            log(`Max iterations reached (${curIter}/${globalMaxIter}). Exiting.`);
            recordExitReason(statePath, 'iteration_cap_exhausted');
            safeDeactivate(statePath);
            exitReason = 'iteration_cap_exhausted';
            break;
        }
        const rawStartEpoch = Number(state.start_time_epoch);
        const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
        const rawMaxTimeMins = Number(state.max_time_minutes);
        const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
        const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
        if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
            log(`Time limit reached (${elapsed}s). Exiting.`);
            finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
            exitReason = 'limit';
            break;
        }
        // Circuit breaker gate: if CB is OPEN, exit immediately
        if (cbEnabled && cbState && !canExecute(cbState)) {
            log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
            recordExitReason(statePath, 'circuit_open');
            safeDeactivate(statePath);
            exitReason = 'circuit_open';
            break;
        }
        // Stall detection fallback (only when CB is disabled)
        if (!cbEnabled) {
            if (curIter === lastStateIteration) {
                stallCount++;
                if (stallCount >= 2) { // Stall threshold only consulted when !cbEnabled; CB-enabled sessions use CB's own progress threshold
                    log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
                    recordExitReason(statePath, 'stall');
                    safeDeactivate(statePath);
                    exitReason = 'stall';
                    break;
                }
            }
            else {
                stallCount = 0;
            }
            lastStateIteration = curIter;
        }
        iteration++;
        const templateName = state.command_template || 'pickle.md';
        if (templateName !== 'meeseeks.md') {
            correctPhantomDoneTickets({
                sessionDir,
                workingDir: state.working_dir || process.cwd(),
                startCommit: state.start_commit || null,
                iteration,
                log,
            });
        }
        const preTicket = templateName === 'meeseeks.md'
            ? null
            : (state.current_ticket || findNextPendingTicketId(sessionDir));
        const preStep = templateName === 'meeseeks.md'
            ? 'review'
            : inferTicketLifecycleStep(sessionDir, preTicket, state.step);
        state = updateMuxLifecycleState(statePath, { iteration, currentTicket: preTicket, step: preStep });
        state = reconcileTicketStateDesync(statePath, sessionDir, state.current_ticket || null, iteration, log);
        if (templateName !== 'meeseeks.md') {
            state = sm.update(statePath, s => {
                applyTicketTierBudget(s, sessionDir);
            });
        }
        if (previousTicket === null) {
            previousTicket = state.current_ticket || null;
            if (previousTicket) {
                const ticketInfo = collectTickets(sessionDir).find(t => t.id === previousTicket);
                previousTicketStartCommit = readHeadCommit(ticketInfo?.working_dir || state.working_dir || process.cwd());
            }
        }
        log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);
        logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackend(state) });
        if (templateName !== 'meeseeks.md' && applyAllTicketsDoneCompletion(statePath, sessionDir, iteration, log)) {
            exitReason = 'success';
            break;
        }
        // R-BUNDLE-1: bundle bootstrap mode — auto-apply both skip reasons for allowlisted sessions.
        // Updates local state.flags so the two gate checks below read the derived skip reasons.
        if (!bundleBootstrapApplied && curIter === 0) {
            bundleBootstrapApplied = true;
            const bootstrapMode = typeof state.flags?.bundle_bootstrap_mode === 'string'
                ? state.flags.bundle_bootstrap_mode
                : null;
            if (bootstrapMode !== null && BUNDLE_BOOTSTRAP_ALLOWLIST[bootstrapMode]?.has(path.basename(sessionDir))) {
                const derivedReason = `bundle_bootstrap_mode=${bootstrapMode}`;
                const existingFlags = state.flags ?? {};
                const skipReadinessReason = typeof existingFlags.skip_readiness_reason === 'string' && existingFlags.skip_readiness_reason.length > 0
                    ? existingFlags.skip_readiness_reason
                    : derivedReason;
                const skipTicketAuditReason = typeof existingFlags.skip_ticket_audit_reason === 'string' && existingFlags.skip_ticket_audit_reason.length > 0
                    ? existingFlags.skip_ticket_audit_reason
                    : derivedReason;
                state = { ...state, flags: { ...existingFlags, skip_readiness_reason: skipReadinessReason, skip_ticket_audit_reason: skipTicketAuditReason } };
                logActivity({
                    event: 'bundle_bootstrap_exemption_applied',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    gate_payload: {
                        bundle_id: bootstrapMode,
                        skip_readiness_reason: skipReadinessReason,
                        skip_ticket_audit_reason: skipTicketAuditReason,
                    },
                });
                log(`bundle bootstrap mode applied: ${bootstrapMode} — both gates auto-skipped for session ${path.basename(sessionDir)}`);
            }
        }
        if (!readinessGateChecked && curIter === 0) {
            readinessGateChecked = true;
            const skipReasonRaw = state.flags?.skip_readiness_reason;
            const skipReason = typeof skipReasonRaw === 'string' && skipReasonRaw.length > 0 ? skipReasonRaw : undefined;
            const readinessStatus = runMuxReadinessGate({
                sessionDir,
                repoRoot: state.working_dir || process.cwd(),
                extensionRoot,
                log,
                skipReason,
            });
            if (readinessStatus !== 0) {
                log(`READINESS HALT: check-readiness exited ${readinessStatus}; no manager spawn attempted`);
                recordExitReason(statePath, 'readiness_halt');
                safeDeactivate(statePath);
                exitReason = 'error';
                break;
            }
        }
        // R-TAQ-3: ticket audit gate (slot: readiness → ticket-audit → spawn).
        // Runs once on iteration-0 after readiness gate exits 0.
        if (!ticketAuditGateChecked && curIter === 0) {
            ticketAuditGateChecked = true;
            const skipAuditReasonRaw = state.flags?.skip_ticket_audit_reason;
            const skipAuditReason = typeof skipAuditReasonRaw === 'string' && skipAuditReasonRaw.length > 0 ? skipAuditReasonRaw : undefined;
            const auditResult = runTicketAuditGate({
                sessionDir,
                extensionRoot,
                log,
                skipReason: skipAuditReason,
            });
            if (auditResult.status === 'bypassed') {
                logActivity({
                    event: 'ticket_audit_bypassed',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    reason: auditResult.reason,
                });
            }
            else if (auditResult.status === 'failed') {
                log(`TICKET AUDIT HALT: audit-ticket-bundle exited ${auditResult.exitCode}; defects found — no manager spawn attempted`);
                process.stderr.write(`[mux-runner] ticket audit failed (exit ${auditResult.exitCode}): defects must be resolved before the pipeline can proceed\n`);
                logActivity({
                    event: 'ticket_audit_failed',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                });
                recordExitReason(statePath, 'ticket_audit_failed');
                safeDeactivate(statePath);
                exitReason = 'ticket_audit_failed';
                break;
            }
        }
        // Multi-repo advisory check (once, on first iteration)
        if (iteration === 1) {
            const multiRepoDirs = detectMultiRepo(sessionDir);
            if (multiRepoDirs) {
                log(`⚠️  MULTI-REPO DETECTED: Tickets span [${multiRepoDirs.join(', ')}]. Pickle Rick works best with single-repo sessions.`);
                logActivity({ event: 'multi_repo_warning', source: 'pickle', session: path.basename(sessionDir) });
            }
        }
        // Resolve meeseeks model per-pass based on tier mapping
        if (templateName === 'meeseeks.md')
            meeseeksPassCount++;
        const meeseeksModel = loadMeeseeksModel(extensionRoot, meeseeksPassCount);
        if (templateName === 'meeseeks.md') {
            log(`Meeseeks pass ${meeseeksPassCount} → model: ${meeseeksModel}`);
            logActivity({ event: 'meeseeks_model_select', source: 'pickle', session: path.basename(sessionDir), iteration, model: meeseeksModel, pass: meeseeksPassCount });
        }
        // Update outer-loop progress tracker for the commit-pending probe.
        // First observation seeds both fields so a fresh session never trips
        // the probe at iteration 1 from the default zero-init.
        if (lastObservedStateIteration < 0) {
            lastObservedStateIteration = curIter;
            lastProgressOuterIteration = iteration;
        }
        else if (curIter > lastObservedStateIteration) {
            lastObservedStateIteration = curIter;
            lastProgressOuterIteration = iteration;
        }
        // Pre-spawn commit-pending health probe (codex-only). RCA: codex
        // sometimes produces edits but never `git add` + `git commit`; if
        // stagnation persists past the threshold, nudge the next worker turn
        // to commit + signal Done so the breaker doesn't strand orphan work.
        try {
            const probeBackend = resolveBackend(state);
            const probeWorkingDir = state.working_dir || process.cwd();
            const probeResult = commitPendingProbe({
                sessionDir,
                workingDir: probeWorkingDir,
                backend: probeBackend,
                iteration,
                lastProgressIteration: lastProgressOuterIteration,
                threshold: commitPendingProbeThreshold,
                pid: process.pid,
                log,
            });
            if (probeResult === 'fired') {
                logActivity({
                    event: 'commit_pending_probe_fired',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    iteration,
                });
            }
        }
        catch (err) {
            // Probe is best-effort — never block the iteration on probe failure.
            log(`commit-pending probe threw (ignored): ${safeErrorMessage(err)}`);
        }
        // R-CNAR-6: spark codex smoke-run gate. Active only when state.backend='codex'
        // AND state.codex_model matches /^gpt-5\.3-codex-spark/. Halt exits with
        // exit_reason='codex_unhealthy_consecutive_failures'; auto-resume.sh STOPS per
        // R-CNAR-4(c) (any non-pipeline_phase_incomplete exit halts the resume loop).
        {
            const smokeDecision = evaluateSparkSmokeGate(state, sessionDir);
            if (smokeDecision.action === 'bypass' && !smokeGateBypassEmitted) {
                smokeGateBypassEmitted = true;
                log(`spark smoke gate bypassed: ${smokeDecision.reason}`);
                logActivity({
                    event: 'smoke_gate_bypassed',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    reason: smokeDecision.reason,
                });
            }
            if (smokeDecision.action === 'halt') {
                log(`SMOKE GATE HALT: ${smokeDecision.reason} (rule=${smokeDecision.rule})`);
                logActivity({
                    event: 'codex_unhealthy_consecutive_failures',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    reason: smokeDecision.reason,
                });
                recordExitReason(statePath, 'codex_unhealthy_consecutive_failures');
                safeDeactivate(statePath);
                exitReason = 'codex_unhealthy_consecutive_failures';
                break;
            }
        }
        const iterWorkingDir = state.working_dir || process.cwd();
        const preIterSha = readHeadCommit(iterWorkingDir);
        const outcome = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel);
        const result = outcome.completion;
        // R-WSE-2: detect partial lifecycle exit (research-review APPROVED, downstream artifacts missing)
        // R-WSE-3: emit stderr breadcrumb when ticket Failed after research APPROVED
        try {
            const iterTicket = state.current_ticket;
            if (iterTicket)
                checkPartialLifecycleExit(sessionDir, statePath, iterTicket);
            if (iterTicket)
                checkFailedAfterResearchApproved(sessionDir, iterTicket);
        }
        catch { /* best-effort — never block iteration on partial-lifecycle check failure */ }
        // Move iterLogFile computation BEFORE transition block (needed by classifyTicketCompletion)
        const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
        // Detect ticket transitions: validate completion before marking Done
        try {
            const postState = readRunnerState(statePath);
            const postTicket = postState.current_ticket || null;
            let completedBoundary = null;
            if (previousTicket && postTicket !== previousTicket) {
                // Check if the model already marked it Done via prompt-driven validation
                const tickets = collectTickets(sessionDir);
                const prevTicketInfo = tickets.find(t => t.id === previousTicket);
                if (prevTicketInfo?.id && normalizedStatus(getTicketStatus(sessionDir, prevTicketInfo.id)) === 'done') {
                    log(`Ticket ${previousTicket} already marked Done by model — skipping validation`);
                }
                else {
                    // Drift scenario: model changed current_ticket without following protocol
                    const ticketWorkingDir = prevTicketInfo?.working_dir || state.working_dir || process.cwd();
                    applyAutoTicketCompletionValidation({
                        sessionDir,
                        ticketId: previousTicket,
                        workingDir: ticketWorkingDir,
                        startCommit: previousTicketStartCommit,
                        iteration,
                        log,
                    });
                }
                completedBoundary = {
                    ticketId: previousTicket,
                    landedStatus: prevTicketInfo?.id ? getTicketStatus(sessionDir, prevTicketInfo.id) : null,
                    workingDir: prevTicketInfo?.working_dir || postState.working_dir || state.working_dir || process.cwd(),
                    nextTicketId: postTicket,
                };
            }
            const postStep = inferTicketLifecycleStep(sessionDir, postTicket, postState.step);
            const lifecycleState = updateMuxLifecycleState(statePath, { currentTicket: postTicket, step: postStep });
            const nextTicket = lifecycleState.current_ticket || null;
            if (completedBoundary) {
                completedBoundary.nextTicketId = nextTicket;
                try {
                    runBetweenTicketFastGate({
                        statePath,
                        workingDir: completedBoundary.workingDir,
                        completedTicketId: completedBoundary.ticketId,
                        nextTicketId: completedBoundary.nextTicketId,
                        landedStatus: completedBoundary.landedStatus,
                        log,
                    });
                }
                catch (err) {
                    log(`between-ticket fast gate failed at ticket boundary (ignored): ${safeErrorMessage(err)}`);
                }
            }
            if (nextTicket !== previousTicket) {
                const nextTicketInfo = nextTicket ? collectTickets(sessionDir).find(t => t.id === nextTicket) : null;
                previousTicketStartCommit = nextTicket
                    ? readHeadCommit(nextTicketInfo?.working_dir || lifecycleState.working_dir || process.cwd())
                    : null;
            }
            previousTicket = nextTicket;
        }
        catch { /* state read failed — skip transition check */ }
        // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
        const exitResult = classifyIterationExit(outcome.completion, iterLogFile, {
            didTimeout: outcome.timedOut,
            exitCode: outcome.exitCode,
            wallSeconds: outcome.wallSeconds,
        });
        const exitType = exitResult.type;
        logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitType, backend: resolveBackend(state) });
        emitMuxWastedIter({
            sessionDir,
            iteration,
            action: result,
            preIterSha,
            postIterSha: readHeadCommit(iterWorkingDir),
        });
        if (exitType === 'api_limit') {
            consecutiveRateLimits++;
            log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
            if (exitResult.rateLimitInfo?.resetsAt) {
                log(`API reports reset at ${new Date(exitResult.rateLimitInfo.resetsAt * 1000).toISOString()} (type: ${exitResult.rateLimitInfo.rateLimitType || 'unknown'})`);
            }
            const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes);
            if (rlAction.action === 'bail') {
                exitReason = 'rate_limit_exhausted';
                logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
                    session: path.basename(sessionDir), error: `max retries (${maxRateLimitRetries}) exceeded, no resetsAt available` });
                recordExitReason(statePath, 'rate_limit_exhausted');
                safeDeactivate(statePath);
                break;
            }
            const { waitMs: computedWaitMs, waitSource } = rlAction;
            if (waitSource === 'api') {
                log(`Using API-provided reset time: ${Math.ceil(computedWaitMs / 60_000)}min wait (vs ${rateLimitWaitMinutes}min config default)`);
            }
            const waitUntil = new Date(Date.now() + computedWaitMs).toISOString();
            logActivity({ event: 'rate_limit_wait', source: 'pickle',
                session: path.basename(sessionDir), duration_min: Math.ceil(computedWaitMs / 60_000) });
            writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
                waiting: true, reason: 'API rate limit',
                started_at: new Date().toISOString(),
                wait_until: waitUntil,
                consecutive_waits: consecutiveRateLimits,
                rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
                resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null,
                wait_source: waitSource,
            });
            // Pre-wait time check
            const rawEpoch = Number(state.start_time_epoch);
            const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
            const rawMax = Number(state.max_time_minutes);
            const maxMins = Number.isFinite(rawMax) ? rawMax : 0;
            let actualWaitMs = computedWaitMs;
            if (maxMins > 0 && epoch > 0) {
                const elapsed = Math.floor(Date.now() / 1000) - epoch;
                const remaining = (maxMins * 60) - elapsed;
                if (remaining <= 0) {
                    exitReason = 'limit';
                    finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
                    break;
                }
                actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
            }
            // Cancellable + time-limit-aware sleep loop
            const waitEnd = Date.now() + actualWaitMs;
            while (Date.now() < waitEnd) {
                await sleep(Defaults.RATE_LIMIT_POLL_MS);
                try {
                    const ws = readRunnerState(statePath);
                    if (ws.active !== true) {
                        exitReason = 'cancelled';
                        break;
                    }
                }
                catch { /* proceed */ }
                if (maxMins > 0 && epoch > 0) {
                    const elapsed = Math.floor(Date.now() / 1000) - epoch;
                    if (elapsed >= maxMins * 60) {
                        exitReason = 'limit';
                        break;
                    }
                }
            }
            if (isHaltExit(exitReason)) {
                // 'limit' is a clean-success terminal exit (budget consumed) and gets
                // finalizeTerminalState. Other halt reasons (currently only 'cancelled'
                // is reachable here from the sleep loop; 'timeout_repeat' is also
                // included in the union for parity with failure-bucket sites elsewhere
                // in this file, even though it actually exits earlier via
                // executeTimeoutHalt) preserve step/current_ticket for postmortem.
                const halt = exitReason;
                if (halt === 'limit') {
                    finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
                }
                else if (halt === 'cancelled' || halt === 'timeout_repeat') {
                    recordExitReason(statePath, halt);
                    safeDeactivate(statePath);
                }
                break;
            }
            // Wake: cleanup + handoff
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            try {
                fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json'));
            }
            catch { /* ok */ }
            if (rlAction.resetCounter)
                consecutiveRateLimits = 0;
            logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) });
            const waitedMinutes = Math.ceil(computedWaitMs / 60_000);
            const handoffContent = [
                buildIterationHandoffSummary(state, sessionDir, iteration + 1), '',
                `NOTE: Resumed after ${waitedMinutes}-minute API rate limit wait (source: ${waitSource}).`,
                'Resume from current phase — do not repeat the rate-limited iteration.',
            ].join('\n');
            writeHandoffAtomic(sessionDir, handoffContent, process.pid, log);
            continue; // Skip CB recording + result branching entirely
        }
        if (exitType === 'success')
            consecutiveRateLimits = 0;
        // --- Per-ticket timeout halt (FR-B3/B4/B12/B14) — MUST run BEFORE CB recording ---
        let ticketForTimeout = state.current_ticket || null;
        try {
            const postState = readRunnerState(statePath);
            ticketForTimeout = postState.current_ticket || null;
        }
        catch { /* keep pre-iteration ticket as fallback */ }
        const counterNext = applyTimeoutCounterForLoop({
            prev: { count: timeoutCount, ticket: lastTimeoutTicket },
            ticketNow: ticketForTimeout,
            timedOut: outcome.timedOut === true,
            completedClean: result === 'task_completed',
        });
        timeoutCount = counterNext.count;
        lastTimeoutTicket = counterNext.ticket;
        if (outcome.timedOut) {
            writeTimeoutStub(sessionDir, {
                ticketId: ticketForTimeout,
                iteration,
                wallSeconds: outcome.wallSeconds,
                workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0,
                timeoutCount,
                logFile: iterLogFile,
            });
        }
        if (counterNext.halt) {
            log(`Timeout halt: ticket ${ticketForTimeout} timed out ${timeoutCount} consecutive iterations`);
            executeTimeoutHalt({ statePath, sessionDir, ticketNow: ticketForTimeout, timeoutCount });
            exitReason = 'timeout_repeat';
            break;
        }
        // === Existing CB recording — only reached for non-rate-limit ===
        // Circuit breaker: record iteration outcome (skip for subprocess failures)
        if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
            let errorSig = null;
            try {
                // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                const logContent = fs.readFileSync(iterLogFile, 'utf-8');
                errorSig = extractErrorSignature(logContent);
            }
            catch { /* log may not exist */ }
            let prevCBState = cbState.state;
            // Write CB state inside sm.update to keep circuit_breaker.json in sync with state.json iteration
            try {
                sm.update(statePath, s => {
                    clearCircuitBreakerBudgetCacheOnTicketChange(s, cbState.last_known_ticket);
                    const progress = detectProgress(s.working_dir || process.cwd(), cbState.last_known_head, cbState.last_known_step, s.step, cbState.last_known_ticket, s.current_ticket);
                    const budget = getCircuitBreakerBudget(s, sessionDir);
                    const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
                    prevCBState = cbState.state;
                    cbState = recordIterationResult(cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, iteration, dynamicCbSettings);
                    cbState.last_known_head = progress.currentHead;
                    cbState.last_known_step = s.step;
                    cbState.last_known_ticket = s.current_ticket;
                    if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
                        cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
                    }
                    writeStateFile(cbPath, cbState);
                });
            }
            catch {
                // sm.update failed — fall back to direct reads/writes (iteration desync possible but non-fatal)
                let postIterState = state;
                try {
                    postIterState = readRunnerState(statePath);
                }
                catch { /* use last known state */ }
                clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, cbState.last_known_ticket);
                const progress = detectProgress(postIterState.working_dir || process.cwd(), cbState.last_known_head, cbState.last_known_step, postIterState.step, cbState.last_known_ticket, postIterState.current_ticket);
                const budget = getCircuitBreakerBudget(postIterState, sessionDir);
                const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
                prevCBState = cbState.state;
                cbState = recordIterationResult(cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, iteration, dynamicCbSettings);
                cbState.last_known_head = progress.currentHead;
                cbState.last_known_step = postIterState.step;
                cbState.last_known_ticket = postIterState.current_ticket;
                if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
                    cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
                }
                writeStateFile(cbPath, cbState);
            }
            if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
                logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
                log(`Circuit breaker tripped: ${cbState.reason}`);
                recordExitReason(statePath, 'circuit_open');
                safeDeactivate(statePath);
                exitReason = 'circuit_open';
                break;
            }
            if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
                logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(sessionDir) });
                log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
            }
        }
        if (result === 'task_completed') {
            // EPIC_COMPLETED / TASK_COMPLETED — check for meeseeks chain before exiting
            let curState;
            try {
                curState = readRunnerState(statePath);
            }
            catch (err) {
                const msg = safeErrorMessage(err);
                log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
                exitReason = 'success';
                break;
            }
            // Verify EPIC_COMPLETED against ticket frontmatter. The pure helper
            // below is the only place that decides genuine vs. recoverable vs.
            // pathological — a single false EPIC_COMPLETED no longer kills the
            // pipeline. See `evaluateEpicCompletion` for the full state machine.
            const allTickets = withFreshTicketStatuses(sessionDir, collectTickets(sessionDir));
            const decision = evaluateEpicCompletion({
                tickets: allTickets,
                currentTicket: curState.current_ticket || null,
                priorFalseCount: Number(curState.false_epic_completed_count) || 0,
                priorFalseTicket: curState.false_epic_completed_ticket ?? null,
            });
            if (decision.kind === 'persistent_hallucination') {
                log(`MANAGER_PERSISTENT_HALLUCINATION: ticket ${decision.ticket} emitted ${PromiseTokens.EPIC_COMPLETED} ${decision.nextCount} times without finishing (threshold ${FALSE_EPIC_THRESHOLD}). Done=${decision.doneCount}/${decision.totalCount}. Bailing for human review.\n       Iteration log: ${iterLogFile}`);
                appendPipelineRunnerMarker(sessionDir, `MANAGER_PERSISTENT_HALLUCINATION ticket=${decision.ticket} count=${decision.nextCount} done=${decision.doneCount}/${decision.totalCount}`);
                try {
                    sm.update(statePath, s => {
                        s.false_epic_completed_count = decision.nextCount;
                        s.false_epic_completed_ticket = decision.ticket;
                    });
                }
                catch (err) {
                    log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`);
                }
                logActivity({
                    event: 'manager_persistent_hallucination',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    ticket: decision.ticket,
                    error: `${PromiseTokens.EPIC_COMPLETED} hallucinated ${decision.nextCount}× on ticket ${decision.ticket} (done ${decision.doneCount}/${decision.totalCount})`,
                });
                recordExitReason(statePath, 'manager_persistent_hallucination');
                safeDeactivate(statePath);
                exitReason = 'manager_persistent_hallucination';
                break;
            }
            if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
                const tag = decision.kind === 'recover_advance' ? 'advancing' : 'retrying same ticket';
                const currentId = curState.current_ticket || '(none)';
                log(`MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED}: ${PromiseTokens.EPIC_COMPLETED} claimed but ${decision.doneCount} of ${decision.totalCount} tickets Done (pending: ${decision.pendingIds.join(', ') || '(none)'}). Treating as ${PromiseTokens.TASK_COMPLETED} — ${tag}. count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD}.\n       Iteration log: ${iterLogFile}`);
                appendPipelineRunnerMarker(sessionDir, `MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED} ticket=${currentId} mode=${tag} count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD} done=${decision.doneCount}/${decision.totalCount} pending=${decision.pendingIds.join(',')}`);
                logActivity({
                    event: 'manager_false_epic_completed',
                    source: 'pickle',
                    session: path.basename(sessionDir),
                    ticket: curState.current_ticket || undefined,
                    error: `${PromiseTokens.EPIC_COMPLETED} with ${decision.totalCount - decision.doneCount} pending — ${tag}`,
                });
                let recoveredCurrentTicket = curState.current_ticket || null;
                if (decision.kind === 'recover_advance' && curState.current_ticket) {
                    // current_ticket is already Done — close it out so the next
                    // iteration picks the next non-Done ticket. Counter persists at the
                    // CURRENT ticket so a subsequent false epic on the SAME current
                    // ticket doesn't get a fresh budget.
                    if (markTicketDone(sessionDir, curState.current_ticket)) {
                        log(`Marked ticket ${curState.current_ticket} as Done (recover_advance)`);
                    }
                    recoveredCurrentTicket = findNextPendingTicketId(sessionDir);
                }
                try {
                    sm.update(statePath, s => {
                        s.false_epic_completed_count = decision.nextCount;
                        s.false_epic_completed_ticket = curState.current_ticket || null;
                        const priorTicket = s.current_ticket;
                        if (s.current_ticket !== recoveredCurrentTicket) {
                            s.current_ticket = recoveredCurrentTicket;
                            delete s.current_ticket_tier;
                            delete s.current_ticket_budget;
                            delete s.current_ticket_max_iterations;
                            delete s.current_ticket_worker_timeout_seconds;
                            delete s.current_ticket_budget_start_iteration;
                        }
                        const recoveredStep = inferTicketLifecycleStep(sessionDir, recoveredCurrentTicket, s.step);
                        s.step = priorTicket !== recoveredCurrentTicket ? recoveredStep : maxLifecycleStep(s.step, recoveredStep);
                    });
                }
                catch (err) {
                    log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`);
                }
                // Stricter retry brief — handed to the next iteration via handoff.txt.
                const retryBrief = [
                    `=== MANAGER FALSE EPIC RECOVERY (count ${decision.nextCount}/${FALSE_EPIC_THRESHOLD}) ===`,
                    `You emitted <promise>${PromiseTokens.EPIC_COMPLETED}</promise> but only ${decision.doneCount} of ${decision.totalCount} tickets are status: Done.`,
                    decision.pendingIds.length > 0 ? `Pending tickets: ${decision.pendingIds.join(', ')}.` : '',
                    decision.kind === 'recover_advance'
                        ? `Continue with the next non-Done ticket. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`
                        : `Resume work on current_ticket=${curState.current_ticket}. It is NOT yet Done. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`,
                    `Use ${PromiseTokens.TASK_COMPLETED} for single-ticket completions; reserve ${PromiseTokens.EPIC_COMPLETED} for the moment all tickets are Done.`,
                ].filter(Boolean).join('\n');
                const handoffSummary = buildIterationHandoffSummary(state, sessionDir, iteration + 1);
                writeHandoffAtomic(sessionDir, `${handoffSummary}\n\n${retryBrief}`, process.pid, log);
                // Reset stall counter so the recovery iteration isn't immediately
                // killed by the no-progress detector — the manager IS making progress
                // (we just disagree about whether it's done).
                lastStateIteration = -1;
                stallCount = 0;
                await sleep(1000);
                continue;
            }
            // Genuine epic completion — clear any lingering false-epic counter and
            // proceed as before.
            if (Number(curState.false_epic_completed_count) > 0) {
                try {
                    sm.update(statePath, s => {
                        s.false_epic_completed_count = 0;
                        s.false_epic_completed_ticket = null;
                    });
                }
                catch (err) {
                    log(`WARN: failed to clear false_epic counter: ${safeErrorMessage(err)}`);
                }
            }
            // Mark final ticket as Done before exiting or chaining
            if (curState.current_ticket) {
                if (markTicketDone(sessionDir, curState.current_ticket)) {
                    log(`Marked final ticket ${curState.current_ticket} as Done`);
                }
            }
            if (curState.chain_meeseeks === true) {
                sm.update(statePath, s => { Object.assign(s, transitionToMeeseeks(s, extensionRoot)); });
                lastStateIteration = -1;
                stallCount = 0;
                if (cbEnabled) {
                    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                    try {
                        fs.unlinkSync(cbPath);
                    }
                    catch { /* may not exist */ }
                    cbState = initCircuitBreaker(sessionDir, cbSettings);
                }
                log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing loop.');
                continue;
            }
            log('Task completed. Exiting loop.');
            finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
            exitReason = 'success';
            break;
        }
        else if (result === 'review_clean') {
            // review_clean (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES) — apply min_iterations gate
            let curState;
            try {
                curState = readRunnerState(statePath);
            }
            catch (err) {
                const msg = safeErrorMessage(err);
                log(`ERROR: Cannot read state.json after review_clean: ${msg}. Treating as completed.`);
                finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
                exitReason = 'success';
                break;
            }
            const rawMinIter = Number(curState.min_iterations);
            const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
            const rawCurIter2 = Number(curState.iteration);
            const curIterNow = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
            if (minIter > 0 && curIterNow < minIter) {
                log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
            }
            else {
                log('Review clean. Exiting loop.');
                finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
                exitReason = 'success';
                break;
            }
        }
        else if (result === 'inactive') {
            log('Session deactivated. Exiting loop.');
            exitReason = 'cancelled';
            break;
        }
        else if (result === 'error') {
            // Codex tmux_mode runs ONE long-lived manager subprocess that loops
            // across many tickets internally. The 4h hang-guard SIGTERMs it with
            // `{ completion: 'error', timedOut: true }`. Treating that as terminal
            // strands every Todo ticket the manager hadn't picked up yet. Bounded
            // relaunch path keeps the queue draining; CB-OPEN and the cap still
            // fall through to the legacy exit-on-error.
            let postState = state;
            try {
                postState = readRunnerState(statePath);
            }
            catch { /* fall back */ }
            const exitKind = classifyManagerRelaunchExit(postState, outcome, iterLogFile);
            const relaunchDecision = evaluateManagerRelaunch(postState, collectTickets(sessionDir), cbState, exitKind);
            if (relaunchDecision.reason === 'time_limit') {
                log('Time limit reached. Exiting.');
                finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
                exitReason = 'limit';
                break;
            }
            if (relaunchDecision.shouldRelaunch && relaunchDecision.exitKind !== 'other_error') {
                const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
                log(`${relaunchBackend} manager subprocess exited via ${relaunchDecision.exitKind} with ${relaunchDecision.pendingCount} ticket(s) still pending — ` +
                    `relaunching (count ${relaunchDecision.nextRelaunchCount}/${relaunchDecision.cap}).`);
                recordManagerRelaunch(statePath, sessionDir, relaunchDecision, iteration, log);
                // Relaunch IS progress for outer-loop stall detection — reset stall.
                // Do NOT clear the circuit breaker: a 4h hang-guard timeout is the
                // exact event the CB should observe across relaunches.
                lastStateIteration = -1;
                stallCount = 0;
                await sleep(1000);
                continue;
            }
            log('Subprocess error. Exiting loop.');
            recordExitReason(statePath, 'error');
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = 'error';
            break;
        }
        await sleep(1000);
    }
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    const isFailedExit = isFailureExit(exitReason);
    logActivity({
        event: 'session_end',
        source: 'pickle',
        session: path.basename(sessionDir),
        duration_min: Math.round(totalElapsed / 60),
        mode: 'tmux',
        backend: readBackendForActivity(statePath),
        ...(isFailedExit ? { error: exitReason } : {}),
    });
    let finalStep = 'unknown';
    let finalActive = 'unknown';
    let finalMinIter = 0;
    try {
        const finalState = readRunnerState(statePath);
        const rawStep = finalState.step || 'unknown';
        finalStep = VALID_STEPS.includes(rawStep) ? rawStep : 'unknown';
        finalActive = String(finalState.active);
        const rawFinalMinIter = Number(finalState.min_iterations);
        finalMinIter = Number.isFinite(rawFinalMinIter) ? rawFinalMinIter : 0;
    }
    catch { /* use fallback values */ }
    printMinimalPanel('mux-runner Complete', {
        Iterations: iteration,
        Elapsed: formatTime(totalElapsed),
        FinalPhase: finalStep,
        Active: finalActive,
        ...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
    }, 'GREEN', '🥒');
    log(`mux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);
    const notif = buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed);
    displayMacNotification(notif.title, notif.body, notif.subtitle);
    // Explicit exit code so parent processes (pipeline-runner) can detect failure.
    // Matches microverse-runner.ts pattern.
    // R-ICP-1: 'iteration_cap_exhausted' is a distinct exit code (3) so
    // pipeline-runner can halt the pipeline instead of treating cap-without-
    // EPIC_COMPLETED as either silent success (0) or a generic failure (1).
    let exitCode;
    if (exitReason === 'iteration_cap_exhausted')
        exitCode = 3;
    else if (isFailedExit)
        exitCode = 1;
    else
        exitCode = 0;
    closePhantomDoneWatchers();
    process.exit(exitCode);
}
export function buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed) {
    const isFailure = isFailureExit(exitReason);
    const title = isFailure
        ? '🥒 Pickle Run Failed'
        : '🥒 Pickle Run Complete';
    const subtitle = isFailure
        ? `Exit: ${exitReason} (phase: ${finalStep})`
        : exitReason === 'success'
            ? `Finished in ${formatTime(totalElapsed)}`
            : `Stopped: ${exitReason} (${formatTime(totalElapsed)})`;
    const body = `${iteration} iterations, ${formatTime(totalElapsed)}`;
    return { title, subtitle, body };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'mux-runner.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
