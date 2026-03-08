// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------
export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review'];
// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------
export const Defaults = {
    WORKER_TIMEOUT_SECONDS: 1200,
    MANAGER_MAX_TURNS: 50,
    RATE_LIMIT_POLL_MS: 10_000,
};
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
export function hasToken(text, token) {
    if (!text || !token)
        return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}
