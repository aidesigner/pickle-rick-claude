import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './state-manager.js';
import { safeErrorMessage } from './pickle-utils.js';
const sm = new StateManager();
const MICROVERSE_FILE = 'microverse.json';
export function compareMetric(current, previous, tolerance, direction) {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(tolerance)) {
        return 'held';
    }
    if ((direction ?? 'higher') === 'lower') {
        if (current < previous - tolerance)
            return 'improved';
        if (current > previous + tolerance)
            return 'regressed';
        return 'held';
    }
    if (current > previous + tolerance)
        return 'improved';
    if (current < previous - tolerance)
        return 'regressed';
    return 'held';
}
export function createMicroverseState(prdPath, metric, stallLimit) {
    if (!Number.isInteger(stallLimit) || stallLimit < 1) {
        throw new Error(`stall_limit must be a positive integer, got ${stallLimit}`);
    }
    if (!Number.isFinite(metric.tolerance) || metric.tolerance < 0) {
        throw new Error(`tolerance must be a non-negative number, got ${metric.tolerance}`);
    }
    return {
        status: 'gap_analysis',
        prd_path: prdPath,
        key_metric: { ...metric, direction: metric.direction ?? 'higher' },
        convergence: {
            stall_limit: stallLimit,
            stall_counter: 0,
            history: [],
        },
        gap_analysis_path: '',
        failed_approaches: [],
        baseline_score: 0,
    };
}
/**
 * Record a scored iteration (agent made commits and metric was measured).
 * Stall counter resets on accepted improvements, increments otherwise.
 *
 * The optional `classification` parameter allows the caller to pass the
 * already-computed compareMetric result, avoiding a redundant (and
 * potentially inconsistent) re-classification inside this function.
 */
export function recordIteration(state, entry, classification) {
    const history = [...state.convergence.history, entry];
    if (!classification) {
        const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');
        const previousScore = lastAccepted ? lastAccepted.score : state.baseline_score;
        classification = compareMetric(entry.score, previousScore, state.key_metric.tolerance, state.key_metric.direction);
    }
    const stallCounter = entry.action === 'accept' && classification === 'improved'
        ? 0
        : state.convergence.stall_counter + 1;
    return {
        ...state,
        convergence: {
            ...state.convergence,
            history,
            stall_counter: stallCounter,
        },
    };
}
/**
 * Record a stall (no commits or metric unmeasurable). Increments stall_counter
 * without adding a history entry. This is the ONLY place stall_counter is
 * incremented outside of recordIteration — centralizing stall logic.
 */
export function recordStall(state) {
    return {
        ...state,
        convergence: {
            ...state.convergence,
            stall_counter: state.convergence.stall_counter + 1,
        },
    };
}
export function recordFailedApproach(state, description) {
    const approaches = [...state.failed_approaches, description];
    if (approaches.length > 100)
        approaches.shift();
    return {
        ...state,
        failed_approaches: approaches,
    };
}
export function isConverged(state) {
    return state.convergence.stall_counter >= state.convergence.stall_limit;
}
export function writeMicroverseState(sessionDir, state) {
    // microverse.json is not a State file but uses atomic writes for consistency.
    // Uses forceWrite to avoid lock overhead — microverse state is single-writer.
    sm.forceWrite(path.join(sessionDir, MICROVERSE_FILE), state);
}
export function readMicroverseState(sessionDir) {
    const filePath = path.join(sessionDir, MICROVERSE_FILE);
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        const msg = safeErrorMessage(err);
        console.error(`[microverse-state] Failed to read ${filePath}: ${msg}`);
        return null;
    }
}
