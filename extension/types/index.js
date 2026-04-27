/**
 * Threshold for consecutive false EPIC_COMPLETED emissions on the same ticket
 * before mux-runner gives up and exits with MANAGER_PERSISTENT_HALLUCINATION.
 * Recovery is the default; this guards against a manager stuck in a permanent
 * hallucination loop.
 */
export const FALSE_EPIC_THRESHOLD = 3;
export const BACKENDS = ['claude', 'codex'];
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
export { PROMISE_TOKENS } from '../services/promise-tokens.js';
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
// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES = {
    implementation: ['research', 'plan', 'conformance', 'code_review'],
    review: ['review_scope', 'review_findings', 'spec_conformance'],
};
/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Matches exact `${prefix}.md` (e.g. `review_scope.md`) or `${prefix}_*.md`
 * (e.g. `research_2026-04-18.md`, `plan_review.md`). Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files, role) {
    const prefixes = ARTIFACT_PREFIXES[role];
    return files.some(f => prefixes.some(p => f === `${p}.md` || f.startsWith(`${p}_`)));
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
    'pending_tickets_on_completion',
    'manager_false_epic_completed',
    'manager_persistent_hallucination',
    'gate_baseline_captured',
    'gate_run_complete',
    'gate_skipped',
    'gate_unsafe_test_command_blocked',
    'gate_remediation_complete',
    'gate_remediation_aborted_unverified_production_change',
    'gate_autofix_reverted',
    'gate_workingdir_drift_detected',
    'gate_lock_acquired',
    'gate_lock_timeout',
    'gate_diff_scope_fallback',
    'gate_preexisting_tests_baselined',
    'iteration_left_regression',
    'gate_regression_threshold_warning',
    'gate_out_of_scope_failures_present',
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
