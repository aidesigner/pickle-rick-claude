// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------
export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor'];
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
