import * as path from 'path';
import { Defaults } from '../types/index.js';
import { logActivity } from './activity-logger.js';
import { resolveBackend } from './backend-spawn.js';
import { safeErrorMessage } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
const sm = new StateManager();
function currentRelaunchCount(state) {
    return Number(state.codex_manager_relaunch_count) || 0;
}
function ticketIsPending(ticket) {
    if (!ticket.id)
        return false;
    const status = (ticket.status || '').toLowerCase().replace(/["']/g, '').trim();
    return status !== 'done' && status !== 'skipped';
}
function evaluateSimpleCodexManagerRelaunch(state, hasPendingWork) {
    const currentCount = currentRelaunchCount(state);
    const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
    if (resolveBackend(state) !== 'codex') {
        return { should_relaunch: false, reason: 'wrong_backend', current_count: currentCount, cap };
    }
    if (!hasPendingWork) {
        return { should_relaunch: false, reason: 'no_pending_work', current_count: currentCount, cap };
    }
    if (currentCount >= cap) {
        return { should_relaunch: false, reason: 'at_cap', current_count: currentCount, cap };
    }
    return { should_relaunch: true, reason: 'below_cap', current_count: currentCount, cap };
}
export function evaluateCodexManagerRelaunch(state, pendingInput, cbState) {
    if (typeof pendingInput === 'boolean') {
        return evaluateSimpleCodexManagerRelaunch(state, pendingInput);
    }
    const backend = resolveBackend(state);
    if (backend !== 'codex') {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'not_codex' };
    }
    const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
    const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
    if (maxTimeMins > 0 && startEpoch > 0) {
        const elapsedSec = Math.max(0, Math.floor(Date.now() / 1000) - startEpoch);
        if (elapsedSec > maxTimeMins * 60) {
            return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'time_limit' };
        }
    }
    if (cbState && cbState.state === 'OPEN') {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'circuit_open' };
    }
    const pending = pendingInput.filter(ticketIsPending);
    if (pending.length === 0) {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'no_pending' };
    }
    const prior = currentRelaunchCount(state);
    const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
    if (prior >= cap) {
        return { shouldRelaunch: false, pendingCount: pending.length, nextRelaunchCount: prior, reason: 'cap_exceeded' };
    }
    return { shouldRelaunch: true, pendingCount: pending.length, nextRelaunchCount: prior + 1, reason: 'eligible' };
}
export function recordCodexManagerRelaunch(statePath, sessionDir, decision, iteration, log = () => { }) {
    try {
        sm.update(statePath, s => {
            s.codex_manager_relaunch_count = decision
                ? decision.nextRelaunchCount
                : currentRelaunchCount(s) + 1;
        });
    }
    catch (err) {
        log(`WARN: failed to persist codex_manager_relaunch_count: ${safeErrorMessage(err)}`);
    }
    if (sessionDir && iteration !== undefined) {
        logActivity({
            event: 'codex_manager_relaunch',
            source: 'pickle',
            session: path.basename(sessionDir),
            iteration,
        });
    }
}
