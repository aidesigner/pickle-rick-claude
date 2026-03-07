import * as fs from 'fs';
import * as path from 'path';
import { runCmd, writeStateFile } from './pickle-utils.js';
// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let warned = false;
// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
function freshState() {
    return {
        state: 'CLOSED',
        last_change: new Date().toISOString(),
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        last_error_signature: null,
        last_known_head: '',
        last_known_step: null,
        last_known_ticket: null,
        last_progress_iteration: 0,
        total_opens: 0,
        reason: '',
        opened_at: null,
        history: [],
    };
}
function transition(state, to, reason, iteration) {
    const from = state.state;
    if (from === to)
        return;
    const now = new Date().toISOString();
    state.history.push({ timestamp: now, iteration, from, to, reason });
    state.state = to;
    state.last_change = now;
    state.reason = to === 'CLOSED' ? '' : reason;
    if (to === 'OPEN') {
        state.total_opens++;
        state.opened_at = now;
    }
    if (to === 'CLOSED') {
        state.opened_at = null;
    }
}
export function loadSettings(extensionRoot) {
    const config = {
        enabled: true,
        noProgressThreshold: 5,
        sameErrorThreshold: 5,
        halfOpenAfter: 2,
    };
    try {
        const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (typeof raw.default_circuit_breaker_enabled === 'boolean') {
            config.enabled = raw.default_circuit_breaker_enabled;
        }
        const rawNP = Number(raw.default_cb_no_progress_threshold);
        if (Number.isFinite(rawNP) && rawNP > 0)
            config.noProgressThreshold = rawNP;
        const rawSE = Number(raw.default_cb_same_error_threshold);
        if (Number.isFinite(rawSE) && rawSE > 0)
            config.sameErrorThreshold = rawSE;
        const rawHO = Number(raw.default_cb_half_open_after);
        if (Number.isFinite(rawHO) && rawHO > 0)
            config.halfOpenAfter = rawHO;
    }
    catch {
        // Silent I/O failure — use defaults
    }
    // Validation: enforce minimums and relationship constraints
    if (config.noProgressThreshold < 2)
        config.noProgressThreshold = 2;
    if (config.sameErrorThreshold < 2)
        config.sameErrorThreshold = 2;
    if (config.halfOpenAfter >= config.noProgressThreshold) {
        config.halfOpenAfter = Math.max(1, config.noProgressThreshold - 1);
    }
    if (config.halfOpenAfter < 1)
        config.halfOpenAfter = 1;
    return config;
}
export function initCircuitBreaker(sessionDir, _settings) {
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    try {
        const raw = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
        // Validate structure — must have a valid state field
        if (raw.state !== 'CLOSED' && raw.state !== 'HALF_OPEN' && raw.state !== 'OPEN') {
            return freshState();
        }
        // Staleness check: if last_progress_iteration is wildly out of range
        // compared to state.json iteration, re-create fresh
        const statePath = path.join(sessionDir, 'state.json');
        try {
            const stateRaw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            const stateIter = Number(stateRaw.iteration);
            const cbLastProgress = Number(raw.last_progress_iteration);
            if (Number.isFinite(stateIter) && Number.isFinite(cbLastProgress) && cbLastProgress > stateIter + 1) {
                return freshState();
            }
        }
        catch {
            // Can't read state.json — trust the CB file as-is
        }
        // Reconstruct with defaults for any missing fields
        return {
            state: raw.state,
            last_change: raw.last_change || new Date().toISOString(),
            consecutive_no_progress: Number(raw.consecutive_no_progress) || 0,
            consecutive_same_error: Number(raw.consecutive_same_error) || 0,
            last_error_signature: raw.last_error_signature ?? null,
            last_known_head: raw.last_known_head || '',
            last_known_step: raw.last_known_step ?? null,
            last_known_ticket: raw.last_known_ticket ?? null,
            last_progress_iteration: Number(raw.last_progress_iteration) || 0,
            total_opens: Number(raw.total_opens) || 0,
            reason: raw.reason || '',
            opened_at: raw.opened_at ?? null,
            history: Array.isArray(raw.history) ? raw.history : [],
        };
    }
    catch {
        // Corrupted or missing — start fresh
        return freshState();
    }
}
export function canExecute(state) {
    return state.state !== 'OPEN';
}
export function detectProgress(workingDir, lastKnownHead, prevStep, currentStep, prevTicket, currentTicket) {
    const stepChanged = prevStep !== null && prevStep !== currentStep;
    const ticketChanged = prevTicket !== null && prevTicket !== currentTicket;
    // Verify git availability
    const isGit = runCmd(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: workingDir, check: false });
    if (isGit !== 'true') {
        if (!warned) {
            warned = true;
            console.error('[circuit-breaker] Working directory is not a git repo — assuming progress');
        }
        return { hasProgress: true, currentHead: '', filesChanged: 0, stepChanged, ticketChanged };
    }
    const currentHead = runCmd(['git', 'rev-parse', 'HEAD'], { cwd: workingDir, check: false });
    // First-iteration warm-up: no baseline to compare against.
    // Compute currentHead above so subsequent iterations have a baseline.
    if (lastKnownHead === '') {
        return { hasProgress: true, currentHead, filesChanged: 0, stepChanged, ticketChanged };
    }
    const diffOutput = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    const hasUncommittedChanges = diffOutput.length > 0;
    const stagedOutput = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
    const hasStagedChanges = stagedOutput.length > 0;
    const headChanged = currentHead !== lastKnownHead;
    return {
        hasProgress: hasUncommittedChanges || hasStagedChanges || headChanged || stepChanged || ticketChanged,
        currentHead,
        filesChanged: countFilesChanged(diffOutput),
        stepChanged,
        ticketChanged,
    };
}
export function extractErrorSignature(ndjsonOutput) {
    const lines = ndjsonOutput.split('\n').filter(l => l.trim());
    let lastAssistantText = '';
    let isErrorResult = false;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'assistant') {
                const msg = parsed.message;
                if (msg && Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block?.type === 'text' && typeof block.text === 'string') {
                            lastAssistantText = block.text;
                        }
                    }
                }
            }
            if (parsed.type === 'result' && typeof parsed.subtype === 'string') {
                isErrorResult = parsed.subtype.startsWith('error');
            }
        }
        catch {
            continue;
        }
    }
    if (!isErrorResult || !lastAssistantText)
        return null;
    return normalizeErrorSignature(lastAssistantText);
}
export function normalizeErrorSignature(errorLine) {
    let s = errorLine;
    // Rule 1: Replace Unix paths
    s = s.replace(/\/[\w.@/-]+/g, '<PATH>');
    // Rule 2: Replace line:column patterns :N:N
    s = s.replace(/:\d+:\d+/g, ':<N>:<N>');
    // Rule 3: Replace ISO 8601 timestamps
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>');
    // Rule 4: Replace UUIDs
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
    // Rule 5: Standalone numbers are preserved (exit codes matter)
    // Rule 6: Collapse consecutive whitespace
    s = s.replace(/\s+/g, ' ').trim();
    // Rule 7: Truncate to 200 chars
    if (s.length > 200)
        s = s.slice(0, 200);
    return s;
}
export function recordIterationResult(state, result, iteration, settings) {
    const newState = {
        ...state,
        history: [...state.history],
    };
    // 1. Error tracking (independent of progress)
    if (result.errorSignature !== null) {
        if (result.errorSignature === state.last_error_signature) {
            newState.consecutive_same_error++;
        }
        else {
            newState.consecutive_same_error = 1;
            newState.last_error_signature = result.errorSignature;
        }
    }
    else {
        newState.consecutive_same_error = 0;
        newState.last_error_signature = null;
    }
    // 2. Progress tracking
    if (result.hasProgress) {
        newState.consecutive_no_progress = 0;
        newState.last_progress_iteration = iteration;
        // Recovery: HALF_OPEN -> CLOSED (error counters NOT reset)
        if (state.state === 'HALF_OPEN') {
            transition(newState, 'CLOSED', 'Progress detected', iteration);
        }
    }
    else {
        newState.consecutive_no_progress++;
    }
    // 3. State transitions (error check first — errors are unambiguous)
    if (newState.consecutive_same_error >= settings.sameErrorThreshold) {
        transition(newState, 'OPEN', `Same error repeated ${newState.consecutive_same_error} times`, iteration);
    }
    else if (newState.consecutive_no_progress >= settings.noProgressThreshold) {
        transition(newState, 'OPEN', `No progress in ${newState.consecutive_no_progress} iterations`, iteration);
    }
    else if (newState.consecutive_no_progress >= settings.halfOpenAfter
        && newState.state === 'CLOSED') {
        transition(newState, 'HALF_OPEN', `No progress in ${newState.consecutive_no_progress} iterations`, iteration);
    }
    return newState;
}
export function resetCircuitBreaker(sessionDir, reason) {
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    let current;
    try {
        current = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
    }
    catch {
        console.error('[circuit-breaker] No circuit_breaker.json found — nothing to reset');
        return;
    }
    if (current.state === 'CLOSED') {
        console.error('[circuit-breaker] Already CLOSED — no reset needed');
        return;
    }
    const resetState = freshState();
    // Preserve history for audit trail
    resetState.history = Array.isArray(current.history) ? [...current.history] : [];
    resetState.history.push({
        timestamp: new Date().toISOString(),
        iteration: 0,
        from: current.state,
        to: 'CLOSED',
        reason: `Manual reset: ${reason}`,
    });
    try {
        writeStateFile(cbPath, resetState);
        console.error(`[circuit-breaker] Reset from ${current.state} to CLOSED: ${reason}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[circuit-breaker] Failed to write reset state: ${msg}`);
    }
}
export function countFilesChanged(diffStatOutput) {
    const match = diffStatOutput.match(/(\d+) files? changed/);
    return match ? parseInt(match[1], 10) : 0;
}
