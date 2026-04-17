export const STATE_MANAGER_DEFAULTS = {
    maxLockRetries: 10,
    baseLockDelayMs: 100,
    lockJitter: true,
    staleLockTimeoutMs: 30_000,
    schemaVersion: 2,
};
export class StateError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'StateError';
        this.code = code;
    }
}
export class LockError extends StateError {
    constructor(message) {
        super('LOCK_FAILED', message);
        this.name = 'LockError';
    }
}
export class TransactionError extends StateError {
    rollbackErrors;
    constructor(message, rollbackErrors = []) {
        super('WRITE_FAILED', message);
        this.name = 'TransactionError';
        this.rollbackErrors = rollbackErrors;
    }
}
// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------
export const Defaults = {
    WORKER_TIMEOUT_SECONDS: 1200,
    /** Absolute ceiling for a single iteration when per-iteration timeout is disabled (4h). */
    MAX_ITERATION_SECONDS: 14_400,
    MANAGER_MAX_TURNS: 50,
    RATE_LIMIT_POLL_MS: 10_000,
};
// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------
export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review'];
// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------
export const PromiseTokens = {
    EPIC_COMPLETED: 'EPIC_COMPLETED',
    TASK_COMPLETED: 'TASK_COMPLETED',
    WORKER_DONE: 'I AM DONE',
    PRD_COMPLETE: 'PRD_COMPLETE',
    TICKET_SELECTED: 'TICKET_SELECTED',
    ANALYSIS_DONE: 'ANALYSIS_DONE',
    EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
    THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
};
/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text, token) {
    if (!text || !token)
        return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}
/** Wraps `token` in promise XML tags. */
export function wrapToken(token) {
    return `<promise>${token}</promise>`;
}
// ---------------------------------------------------------------------------
// Activity Events
// ---------------------------------------------------------------------------
export const VALID_ACTIVITY_EVENTS = [
    'session_start', 'session_end', 'ticket_completed', 'epic_completed',
    'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
    'refactor', 'review', 'jar_start', 'jar_end',
    'circuit_open', 'circuit_recovery',
    'iteration_start', 'iteration_end',
    'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
    'multi_repo_warning',
    'meeseeks_model_select',
];
// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------
export { ATTRACTOR_SCHEMA_FALLBACK, ALL_ATTRS, lookupAttr, validateAttrType, validateAttrs, } from './attractor-schema.fallback.js';
export class BuildError extends Error {
    code;
    diagnostics;
    constructor(code, message, diagnostics = []) {
        super(message);
        this.name = 'BuildError';
        this.code = code;
        this.diagnostics = diagnostics;
    }
}
