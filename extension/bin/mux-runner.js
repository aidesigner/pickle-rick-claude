#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone } from '../services/pickle-utils.js';
import { PromiseTokens, hasToken, VALID_STEPS, Defaults } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult } from '../services/circuit-breaker.js';
let currentChildProc = null;
/**
 * Strips the Setup section from dual-mode templates (e.g. meeseeks.md, council-of-ricks.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Matches both "## SETUP MODE" and "## SETUP" (with or without
 * the " MODE" suffix) to prevent silent failures when templates use variant headers.
 */
export function stripSetupSection(prompt) {
    const setupRe = /^## SETUP(?: MODE)?$/m;
    const reviewRe = /^## REVIEW PASS(?: MODE)?$/m;
    const setupMatch = setupRe.exec(prompt);
    const reviewMatch = reviewRe.exec(prompt);
    if (setupMatch && reviewMatch && setupMatch.index < reviewMatch.index) {
        return prompt.slice(0, setupMatch.index) + prompt.slice(reviewMatch.index);
    }
    return prompt;
}
/**
 * Extracts text content from assistant messages in stream-json output.
 * Filters out tool_result / user / system lines so that promise tokens
 * embedded in reviewed source code (e.g. stop-hook.ts containing
 * `<promise>EPIC_COMPLETED</promise>`) do not cause false matches.
 *
 * For non-stream-json (plain text) output, every line fails JSON.parse
 * and is included as-is, preserving backward compatibility.
 */
export function extractAssistantContent(output) {
    const lines = output.split('\n');
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
        catch {
            // Not valid JSON — include raw text for backward compat with plain-text output
            parts.push(line);
        }
    }
    return parts.join('\n');
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
 * Transitions a session from ticket-execution mode to Meeseeks review mode.
 * Pure function — returns a new state object without side effects.
 */
export function transitionToMeeseeks(state, extensionRoot) {
    let minPasses = 10;
    let maxPasses = 50;
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const rawMin = Number(settings.default_meeseeks_min_passes);
        if (Number.isFinite(rawMin) && rawMin > 0)
            minPasses = rawMin;
        const rawMax = Number(settings.default_meeseeks_max_passes);
        if (Number.isFinite(rawMax) && rawMax > 0)
            maxPasses = rawMax;
    }
    catch { /* use defaults */ }
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
export function loadMeeseeksModel(extensionRoot) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'pickle_settings.json'), 'utf-8'));
        if (typeof raw.default_meeseeks_model === 'string' && raw.default_meeseeks_model.length > 0) {
            return raw.default_meeseeks_model;
        }
    }
    catch { /* use default */ }
    return 'sonnet';
}
export function loadRateLimitSettings(extensionRoot) {
    let waitMinutes = 60;
    let maxRetries = 3;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'pickle_settings.json'), 'utf-8'));
        const rawWait = raw.default_rate_limit_wait_minutes;
        if (typeof rawWait === 'number' && rawWait >= 1)
            waitMinutes = rawWait;
        const rawRetries = raw.default_max_rate_limit_retries;
        if (typeof rawRetries === 'number' && rawRetries >= 1)
            maxRetries = rawRetries;
    }
    catch { /* use defaults */ }
    return { waitMinutes, maxRetries };
}
export function detectRateLimitInLog(logFile) {
    const result = { limited: false };
    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split('\n');
        const tail = lines.slice(-100);
        for (const line of tail) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.type !== 'rate_limit_event')
                    continue;
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
        const tail = lines.slice(-100);
        const filtered = tail.filter(l => !l.includes('"type":"user"') && !l.includes('"type":"tool_result"'));
        const text = filtered.join('\n');
        const patterns = [/5.*hour.*limit/i, /limit.*reached.*try.*back/i, /usage.*limit.*reached/i, /rate limit/i, /out of (extra )?usage/i];
        return patterns.some(p => p.test(text));
    }
    catch { /* file missing */ }
    return false;
}
export function classifyIterationExit(completionResult, logFile) {
    if (completionResult === 'inactive')
        return { type: 'inactive' };
    if (completionResult === 'error')
        return { type: 'error' };
    if (completionResult === 'task_completed' || completionResult === 'review_clean')
        return { type: 'success' };
    const rlInfo = detectRateLimitInLog(logFile);
    if (rlInfo.limited)
        return { type: 'api_limit', rateLimitInfo: rlInfo };
    if (detectRateLimitInText(logFile))
        return { type: 'api_limit' };
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
    const rlResetsAt = exitResult.rateLimitInfo?.resetsAt;
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
async function runIteration(sessionDir, iterationNum, extensionRoot, meeseeksModel) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
    }
    if (state.active !== true)
        return 'inactive';
    const templateName = state.command_template || 'pickle.md';
    // Validate at read time (not just at setup.ts CLI parse time) — state.json could be tampered with
    if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
        throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
    }
    const picklePromptPath = path.join(os.homedir(), '.claude/commands', templateName);
    if (!fs.existsSync(picklePromptPath)) {
        throw new Error(`${templateName} not found at ${picklePromptPath}. Run install.sh first.`);
    }
    let managerPrompt = fs.readFileSync(picklePromptPath, 'utf-8')
        .replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);
    managerPrompt = stripSetupSection(managerPrompt);
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
        managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
        try {
            fs.unlinkSync(handoffPath);
        }
        catch { /* consumed — prevent stale re-reads */ }
    }
    else {
        managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir, iterationNum);
    }
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let maxTurns = Defaults.MANAGER_MAX_TURNS;
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (typeof settings.default_tmux_max_turns === 'number' && settings.default_tmux_max_turns > 0) {
            maxTurns = settings.default_tmux_max_turns;
        }
        else if (typeof settings.default_manager_max_turns === 'number' && settings.default_manager_max_turns > 0) {
            maxTurns = settings.default_manager_max_turns;
        }
    }
    catch { /* use default */ }
    const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
    const cmdArgs = [
        '--dangerously-skip-permissions',
        '--add-dir', extensionRoot,
        '--add-dir', sessionDir,
        '--no-session-persistence',
        '--output-format', 'stream-json', '--verbose',
        '--max-turns', String(maxTurns),
    ];
    // Route meeseeks review passes through a cheaper model (default: sonnet)
    if (templateName === 'meeseeks.md' && meeseeksModel) {
        cmdArgs.push('--model', meeseeksModel);
    }
    cmdArgs.push('-p', managerPrompt);
    const env = { ...process.env, PICKLE_STATE_FILE: statePath, PYTHONUNBUFFERED: '1' };
    // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
    // inside another Claude Code session (which would alter its behavior).
    delete env['CLAUDECODE'];
    // Remove PICKLE_ROLE so manager subprocesses aren't misidentified as workers
    // by the stop-hook (tmux-runner spawns managers, not workers).
    delete env['PICKLE_ROLE'];
    // Use a raw file descriptor with synchronous writes so every chunk hits
    // the disk immediately. Node's WriteStream buffers up to 16KB internally,
    // which starves log-watcher (it polls file size via statSync).
    const logFd = fs.openSync(logFile, 'w');
    function writeToLog(chunk) {
        try {
            fs.writeSync(logFd, chunk);
        }
        catch { /* fd closed — ignore late writes */ }
    }
    // Per-iteration timeout: mirrors spawn-morty.ts + jar-runner.ts.
    // max_time_minutes is checked between iterations; if claude hangs mid-iteration
    // (e.g. stuck on a tool call), the outer loop never regains control without this.
    const rawIterTimeout = Number(state.worker_timeout_seconds);
    const iterTimeout = Number.isFinite(rawIterTimeout) && rawIterTimeout > 0
        ? rawIterTimeout
        : Defaults.WORKER_TIMEOUT_SECONDS;
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn('claude', cmdArgs, {
            cwd: state.working_dir || process.cwd(),
            env,
            stdio: ['inherit', 'pipe', 'pipe'],
        });
        currentChildProc = proc;
        // SIGTERM first, escalate to SIGKILL after 2s if still alive
        let killEscalation = null;
        const timeoutHandle = setTimeout(() => {
            if (settled)
                return;
            console.error(`\n${Style.YELLOW}⚠️  Iteration ${iterationNum} timed out after ${iterTimeout}s — killing${Style.RESET}`);
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
        }, iterTimeout * 1000);
        // Safety net: force-resolve if process doesn't exit within timeout + 30s
        const hangGuard = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            currentChildProc = null;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            try {
                fs.closeSync(logFd);
            }
            catch { /* already closed */ }
            console.error(`${Style.RED}❌ Iteration ${iterationNum} hang detected — forcing failure${Style.RESET}`);
            resolve('error');
        }, (iterTimeout + 30) * 1000);
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
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
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
            resolve(classifyCompletion(output));
        });
        proc.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            currentChildProc = null;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`${Style.RED}Failed to spawn claude: ${msg}${Style.RESET}`);
            try {
                fs.closeSync(logFd);
            }
            catch { /* already closed */ }
            resolve('error');
        });
    });
}
async function main() {
    const sessionDir = process.argv[2];
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
    // Graceful shutdown: deactivate session on SIGTERM/SIGINT so it doesn't
    // remain orphaned with active: true when the tmux pane is closed.
    const handleShutdownSignal = (signal) => {
        log(`Received ${signal} — deactivating session`);
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            state.active = false;
            writeStateFile(statePath, state);
        }
        catch {
            // Best effort: if state is unreadable, write a minimal deactivation
            try {
                writeStateFile(statePath, { active: false });
            }
            catch { /* nothing we can do */ }
        }
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
        ownerState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read initial state.json: ${msg}`);
    }
    if (ownerState.active !== true) {
        ownerState.active = true;
        writeStateFile(statePath, ownerState);
        log('Session ownership taken (active: false → true)');
    }
    // Clean up stale rate_limit_wait.json from a previous crashed session
    try {
        fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json'));
    }
    catch { /* not present */ }
    const cbSettings = loadSettings(extensionRoot);
    const cbEnabled = cbSettings.enabled;
    let cbState = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);
    const meeseeksModel = loadMeeseeksModel(extensionRoot);
    const startTime = Date.now();
    let iteration = 0;
    let lastStateIteration = -1;
    let stallCount = 0;
    let consecutiveRateLimits = 0;
    let previousTicket = null;
    let exitReason = 'error';
    while (true) {
        let state;
        try {
            state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
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
            state.active = false;
            writeStateFile(statePath, state);
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
            state.active = false;
            writeStateFile(statePath, state);
            exitReason = 'limit';
            break;
        }
        // Circuit breaker gate: if CB is OPEN, exit immediately
        if (cbEnabled && cbState && !canExecute(cbState)) {
            log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
            state.active = false;
            writeStateFile(statePath, state);
            exitReason = 'circuit_open';
            break;
        }
        // Stall detection fallback (only when CB is disabled)
        if (!cbEnabled) {
            if (curIter === lastStateIteration) {
                stallCount++;
                if (stallCount >= 3) {
                    log(`WARNING: state.iteration has not advanced in 3 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
                    state.active = false;
                    writeStateFile(statePath, state);
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
        const result = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel);
        // Detect ticket transitions: if current_ticket changed, mark the previous one Done
        try {
            const postState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            const postTicket = postState.current_ticket || null;
            if (previousTicket && postTicket !== previousTicket) {
                if (markTicketDone(sessionDir, previousTicket)) {
                    log(`Marked ticket ${previousTicket} as Done (transitioned to ${postTicket || 'none'})`);
                }
            }
            previousTicket = postTicket;
        }
        catch { /* state read failed — skip transition check */ }
        // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
        const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
        const exitResult = classifyIterationExit(result, iterLogFile);
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
                state.active = false;
                writeStateFile(statePath, state);
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
                    state.active = false;
                    writeStateFile(statePath, state);
                    break;
                }
                actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
            }
            // Cancellable + time-limit-aware sleep loop
            const waitEnd = Date.now() + actualWaitMs;
            while (Date.now() < waitEnd) {
                await sleep(Defaults.RATE_LIMIT_POLL_MS);
                try {
                    const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
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
            if (exitReason === 'cancelled' || exitReason === 'limit') {
                state.active = false;
                writeStateFile(statePath, state);
                break;
            }
            // Wake: cleanup + handoff
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
            const handoffTmp = path.join(sessionDir, `handoff.txt.tmp.${process.pid}`);
            try {
                fs.writeFileSync(handoffTmp, handoffContent);
                fs.renameSync(handoffTmp, path.join(sessionDir, 'handoff.txt'));
            }
            catch {
                try {
                    fs.unlinkSync(handoffTmp);
                }
                catch { /* ignore */ }
            }
            continue; // Skip CB recording + result branching entirely
        }
        if (exitType === 'success')
            consecutiveRateLimits = 0;
        // === Existing CB recording — only reached for non-rate-limit ===
        // Circuit breaker: record iteration outcome (skip for subprocess failures)
        if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
            let postIterState;
            try {
                postIterState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            }
            catch {
                postIterState = state;
            }
            const progress = detectProgress(postIterState.working_dir || process.cwd(), cbState.last_known_head, cbState.last_known_step, postIterState.step, cbState.last_known_ticket, postIterState.current_ticket);
            let errorSig = null;
            try {
                const logContent = fs.readFileSync(iterLogFile, 'utf-8');
                errorSig = extractErrorSignature(logContent);
            }
            catch { /* log may not exist */ }
            const prevCBState = cbState.state;
            cbState = recordIterationResult(cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, iteration, cbSettings);
            cbState.last_known_head = progress.currentHead;
            cbState.last_known_step = postIterState.step;
            cbState.last_known_ticket = postIterState.current_ticket;
            writeStateFile(cbPath, cbState);
            if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
                logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
                log(`Circuit breaker tripped: ${cbState.reason}`);
                state.active = false;
                writeStateFile(statePath, state);
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
                curState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
                exitReason = 'success';
                break;
            }
            // Mark final ticket as Done before exiting or chaining
            if (curState.current_ticket) {
                if (markTicketDone(sessionDir, curState.current_ticket)) {
                    log(`Marked final ticket ${curState.current_ticket} as Done`);
                }
            }
            if (curState.chain_meeseeks === true) {
                const newState = transitionToMeeseeks(curState, extensionRoot);
                writeStateFile(statePath, newState);
                lastStateIteration = -1;
                stallCount = 0;
                if (cbEnabled) {
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
            curState.active = false;
            writeStateFile(statePath, curState);
            exitReason = 'success';
            break;
        }
        else if (result === 'review_clean') {
            // review_clean (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES) — apply min_iterations gate
            let curState;
            try {
                curState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
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
                curState.active = false;
                writeStateFile(statePath, curState);
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
            state.active = false;
            writeStateFile(statePath, state);
            exitReason = 'error';
            break;
        }
        await sleep(1000);
    }
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    const isFailedExit = exitReason === 'error' || exitReason === 'stall' || exitReason === 'circuit_open' || exitReason === 'rate_limit_exhausted';
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), duration_min: Math.round(totalElapsed / 60), mode: 'tmux', ...(isFailedExit ? { error: exitReason } : {}) });
    let finalStep = 'unknown';
    let finalActive = 'unknown';
    let finalMinIter = 0;
    try {
        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
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
    if (process.platform === 'darwin') {
        const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        spawnSync('osascript', ['-e', `display notification "${esc(notif.body)}" with title "${esc(notif.title)}" subtitle "${esc(notif.subtitle)}"`]);
    }
}
export function buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed) {
    const isFailure = exitReason === 'error' || exitReason === 'stall' || exitReason === 'circuit_open' || exitReason === 'rate_limit_exhausted';
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
