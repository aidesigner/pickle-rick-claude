#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, collectTickets, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification } from '../services/pickle-utils.js';
import { PromiseTokens, hasToken, VALID_STEPS, Defaults, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact } from '../types/index.js';
import { StateManager, safeDeactivate, writeActivityEntry, writeTimeoutStub } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, backendEnvOverrides } from '../services/backend-spawn.js';
const sm = new StateManager();
let currentChildProc = null;
function readRunnerState(statePath) {
    return sm.read(statePath);
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
// Codex plain-text block delimiters. A line matching this regex marks the
// start of a new named block; content between a 'codex' delimiter and the
// next delimiter (or EOF) is assistant output. All other blocks are dropped.
const CODEX_DELIMITER_RE = /^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/;
/**
 * Extracts text content from assistant messages.
 *
 * Detection precedence:
 * 1. Stream-json: ≥1 line parses as JSON with type:'assistant'. Extracts
 *    only assistant text blocks and result blocks. Non-JSON lines and all
 *    other JSON types (user, system, tool_use) are skipped.
 * 2. Codex plain-text: ≥1 line matches CODEX_DELIMITER_RE. Extracts content
 *    between 'codex' delimiters only; user/exec/tokens/reasoning/tool_call
 *    blocks are dropped. Multi-turn: union of all surviving codex blocks.
 * 3. Pure plain-text fallback: returns output as-is.
 *
 * Promise tokens embedded in reviewed source (tool_result, user prompts,
 * codex user blocks) are excluded in all modes.
 */
export function extractAssistantContent(output) {
    const lines = output.split('\n');
    // Mode 1: stream-json — requires ≥1 JSON line that is a typed object
    // ({type:...}). Bare JSON values (null, numbers, arrays, objects without
    // a 'type' key) do NOT trigger this mode, so codex logs with a stray null
    // line fall through to codex-mode detection instead of silently eating all
    // content as stream-json with zero extractions.
    let isStreamJson = false;
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'type' in parsed) {
                isStreamJson = true;
                break;
            }
        }
        catch { /* not JSON */ }
    }
    if (isStreamJson) {
        const parts = [];
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'assistant') {
                    const content = parsed.message?.content;
                    if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block.type === 'text' && typeof block.text === 'string') {
                                parts.push(block.text);
                            }
                        }
                    }
                    else if (typeof content === 'string') {
                        parts.push(content);
                    }
                }
                else if (parsed.type === 'result' && typeof parsed.result === 'string') {
                    parts.push(parsed.result);
                }
                // Intentionally skip: user (tool_result), system, tool_use
            }
            catch { /* skip non-JSON in stream-json mode */ }
        }
        return parts.join('\n');
    }
    // Mode 2: codex plain-text — block-delimiter format.
    let isCodexMode = false;
    for (const line of lines) {
        if (CODEX_DELIMITER_RE.test(line)) {
            isCodexMode = true;
            break;
        }
    }
    if (isCodexMode) {
        const parts = [];
        let inCodexBlock = false;
        for (const line of lines) {
            if (CODEX_DELIMITER_RE.test(line)) {
                inCodexBlock = /^codex\s*$/.test(line);
                continue;
            }
            if (inCodexBlock)
                parts.push(line);
        }
        return parts.join('\n');
    }
    // Mode 3: pure plain-text fallback — return everything.
    return output;
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
/**
 * Reads `pickle_settings.json` as an untyped bag, returning `{}` on any
 * read/parse failure. Emits a labeled stderr breadcrumb keyed by the caller
 * site so a missing/corrupt settings file never silently yields defaults.
 * Every call site in this module consumes its own subset of keys with its
 * own defaults; this helper owns only the file I/O + JSON decode step.
 */
function loadSettingsBag(extensionRoot, site) {
    try {
        return JSON.parse(fs.readFileSync(path.join(extensionRoot, 'pickle_settings.json'), 'utf-8'));
    }
    catch (err) {
        process.stderr.write(`[${site}] ${safeErrorMessage(err)}\n`);
        return {};
    }
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
export async function runIteration(sessionDir, iterationNum, extensionRoot, meeseeksModel) {
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
        managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir, iterationNum);
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
    if (typeof settings.default_tmux_max_turns === 'number' && settings.default_tmux_max_turns > 0) {
        maxTurns = settings.default_tmux_max_turns;
    }
    else if (typeof settings.default_manager_max_turns === 'number' && settings.default_manager_max_turns > 0) {
        maxTurns = settings.default_manager_max_turns;
    }
    const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
    const backend = resolveBackend(state);
    // meeseeks review passes run on a cheaper model (default: sonnet on claude).
    // Codex exposes a different model vocabulary, so only apply the override for claude.
    const iterationModel = templateName === 'meeseeks.md' && meeseeksModel && backend === 'claude'
        ? meeseeksModel
        : undefined;
    const invocation = buildManagerInvocation(backend, {
        prompt: managerPrompt,
        addDirs: [extensionRoot, getDataRoot(), sessionDir],
        model: iterationModel,
        maxTurns,
        streamJson: true,
        noSessionPersistence: true,
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
            resolve({
                completion: classifyCompletion(output),
                timedOut: didTimeout,
                exitCode: code ?? null,
                wallSeconds: (Date.now() - start) / 1000,
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
const isFailureExit = (r) => r === 'error' || r === 'stall' || r === 'circuit_open' || r === 'rate_limit_exhausted' || r === 'timeout_repeat' || r === 'manager_persistent_hallucination';
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
    safeDeactivate(statePath);
}
async function main() {
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
    // Graceful shutdown: deactivate session on SIGTERM/SIGINT so it doesn't
    // remain orphaned with active: true when the tmux pane is closed.
    const handleShutdownSignal = (signal) => {
        log(`Received ${signal} — deactivating session`);
        // eslint-disable-next-line pickle/no-raw-state-write -- crash-path bypass: signal handler cannot await lock
        sm.forceWrite(statePath, (() => {
            try {
                const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                s.active = false;
                return s;
            }
            catch {
                return { active: false };
            }
        })());
        if (currentChildProc && !currentChildProc.killed) {
            currentChildProc.kill('SIGTERM');
        }
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux' });
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
    // Take ownership: setup.js writes active: false in tmux mode so the main
    // Claude window's stop hook is released immediately. We set active: true here
    // before entering the loop so workers and state readers see a live session.
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
        const rawMaxIter = Number(rawObj.max_iterations);
        if (!Number.isFinite(rawMaxIter) || rawMaxIter <= 0) {
            issues.push(`max_iterations must be > 0 (got ${rawObj.max_iterations}) — microverse sentinel zero is valid for microverse-runner only`);
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
    if (ownerState.tmux_mode === true && ownerState.active !== true) {
        sm.update(statePath, s => { s.active = true; });
        log('Session ownership taken (active: false → true)');
    }
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
    let exitReason = 'error';
    // Non-persisted per-ticket timeout counter (FR-B3/B4) — resets on runner restart.
    let timeoutCount = 0;
    let lastTimeoutTicket = null;
    while (true) {
        let state;
        try {
            state = readRunnerState(statePath);
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
            exitReason = 'error';
            break;
        }
        if (state.active !== true) {
            log('Session inactive. Exiting.');
            exitReason = 'cancelled';
            break;
        }
        const rawMaxIter = Number(state.max_iterations);
        const maxIter = Number.isFinite(rawMaxIter) ? rawMaxIter : 0;
        const rawCurIter = Number(state.iteration);
        const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
        if (maxIter > 0 && curIter >= maxIter) {
            log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
            safeDeactivate(statePath);
            exitReason = 'limit';
            break;
        }
        const rawStartEpoch = Number(state.start_time_epoch);
        const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
        const rawMaxTimeMins = Number(state.max_time_minutes);
        const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
        const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
        if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
            log(`Time limit reached (${elapsed}s). Exiting.`);
            safeDeactivate(statePath);
            exitReason = 'limit';
            break;
        }
        // Circuit breaker gate: if CB is OPEN, exit immediately
        if (cbEnabled && cbState && !canExecute(cbState)) {
            log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
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
        const preTicket = state.current_ticket || null;
        if (previousTicket === null)
            previousTicket = preTicket;
        log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);
        logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration });
        // Multi-repo advisory check (once, on first iteration)
        if (iteration === 1) {
            const multiRepoDirs = detectMultiRepo(sessionDir);
            if (multiRepoDirs) {
                log(`⚠️  MULTI-REPO DETECTED: Tickets span [${multiRepoDirs.join(', ')}]. Pickle Rick works best with single-repo sessions.`);
                logActivity({ event: 'multi_repo_warning', source: 'pickle', session: path.basename(sessionDir) });
            }
        }
        // Resolve meeseeks model per-pass based on tier mapping
        const templateName = state.command_template || 'pickle.md';
        if (templateName === 'meeseeks.md')
            meeseeksPassCount++;
        const meeseeksModel = loadMeeseeksModel(extensionRoot, meeseeksPassCount);
        if (templateName === 'meeseeks.md') {
            log(`Meeseeks pass ${meeseeksPassCount} → model: ${meeseeksModel}`);
            logActivity({ event: 'meeseeks_model_select', source: 'pickle', session: path.basename(sessionDir), iteration, model: meeseeksModel, pass: meeseeksPassCount });
        }
        const outcome = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel);
        const result = outcome.completion;
        // Move iterLogFile computation BEFORE transition block (needed by classifyTicketCompletion)
        const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
        // Detect ticket transitions: validate completion before marking Done
        try {
            const postState = readRunnerState(statePath);
            const postTicket = postState.current_ticket || null;
            if (previousTicket && postTicket !== previousTicket) {
                // Check if the model already marked it Done via prompt-driven validation
                const tickets = collectTickets(sessionDir);
                const prevTicketInfo = tickets.find(t => t.id === previousTicket);
                if (prevTicketInfo?.status?.toLowerCase().replace(/["']/g, '') === 'done') {
                    log(`Ticket ${previousTicket} already marked Done by model — skipping validation`);
                }
                else {
                    // Drift scenario: model changed current_ticket without following protocol
                    const ticketWorkingDir = prevTicketInfo?.working_dir || state.working_dir || process.cwd();
                    const prevTicketDir = path.join(sessionDir, previousTicket);
                    const role = prevTicketInfo?.type === 'review' ? 'review' : 'implementation';
                    const verdict = classifyTicketCompletion(iterLogFile, ticketWorkingDir, prevTicketDir, role);
                    if (verdict === 'completed') {
                        if (markTicketDone(sessionDir, previousTicket)) {
                            log(`Marked ticket ${previousTicket} as Done (validated: evidence found)`);
                        }
                    }
                    else {
                        if (markTicketSkipped(sessionDir, previousTicket)) {
                            log(`Marked ticket ${previousTicket} as Skipped (no completion evidence)`);
                        }
                    }
                }
            }
            previousTicket = postTicket;
        }
        catch { /* state read failed — skip transition check */ }
        // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
        const exitResult = classifyIterationExit(outcome.completion, iterLogFile, {
            didTimeout: outcome.timedOut,
            exitCode: outcome.exitCode,
            wallSeconds: outcome.wallSeconds,
        });
        const exitType = exitResult.type;
        logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitType });
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
                    safeDeactivate(statePath);
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
                safeDeactivate(statePath);
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
                buildHandoffSummary(state, sessionDir, iteration + 1), '',
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
        const counterNext = applyTimeoutCounter({
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
                    const progress = detectProgress(s.working_dir || process.cwd(), cbState.last_known_head, cbState.last_known_step, s.step, cbState.last_known_ticket, s.current_ticket);
                    prevCBState = cbState.state;
                    cbState = recordIterationResult(cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, iteration, cbSettings);
                    cbState.last_known_head = progress.currentHead;
                    cbState.last_known_step = s.step;
                    cbState.last_known_ticket = s.current_ticket;
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
                const progress = detectProgress(postIterState.working_dir || process.cwd(), cbState.last_known_head, cbState.last_known_step, postIterState.step, cbState.last_known_ticket, postIterState.current_ticket);
                prevCBState = cbState.state;
                cbState = recordIterationResult(cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, iteration, cbSettings);
                cbState.last_known_head = progress.currentHead;
                cbState.last_known_step = postIterState.step;
                cbState.last_known_ticket = postIterState.current_ticket;
                writeStateFile(cbPath, cbState);
            }
            if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
                logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
                log(`Circuit breaker tripped: ${cbState.reason}`);
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
            const allTickets = collectTickets(sessionDir);
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
                if (decision.kind === 'recover_advance' && curState.current_ticket) {
                    // current_ticket is already Done — close it out so the next
                    // iteration picks the next non-Done ticket. Counter persists at the
                    // CURRENT ticket so a subsequent false epic on the SAME current
                    // ticket doesn't get a fresh budget.
                    if (markTicketDone(sessionDir, curState.current_ticket)) {
                        log(`Marked ticket ${curState.current_ticket} as Done (recover_advance)`);
                    }
                }
                try {
                    sm.update(statePath, s => {
                        s.false_epic_completed_count = decision.nextCount;
                        s.false_epic_completed_ticket = curState.current_ticket || null;
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
                const handoffSummary = buildHandoffSummary(state, sessionDir, iteration + 1);
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
            safeDeactivate(statePath);
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
                safeDeactivate(statePath);
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
            log('Subprocess error. Exiting loop.');
            safeDeactivate(statePath);
            exitReason = 'error';
            break;
        }
        await sleep(1000);
    }
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    const isFailedExit = isFailureExit(exitReason);
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), duration_min: Math.round(totalElapsed / 60), mode: 'tmux', ...(isFailedExit ? { error: exitReason } : {}) });
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
    const exitCode = isFailedExit ? 1 : 0;
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
