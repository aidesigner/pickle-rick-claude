/**
 * Degenerate output detection service.
 * Detects whitespace-only, ultra-short, and no-op phrase outputs from workers.
 */
export const NO_OP_PATTERNS = [
    'acknowledged',
    'ok',
    'done',
    'understood',
    'noted',
    'continuing',
    'ready',
    'got it',
    'will do',
    'roger',
];
/**
 * Extract the last N lines from output.
 */
export function extractTail(output, lines = 100) {
    if (output == null)
        return '';
    const split = output.split('\n');
    if (split.length <= lines)
        return output;
    return split.slice(-lines).join('\n');
}
/**
 * Detect degenerate (no-op) output from workers.
 * Null/undefined input treated as whitespace-only.
 */
export function isDegenerate(output) {
    if (output == null)
        return { degenerate: true, reason: 'whitespace_only' };
    const trimmed = output.trim();
    if (trimmed.length === 0) {
        return { degenerate: true, reason: 'whitespace_only' };
    }
    const normalized = trimmed.length <= 100
        ? trimmed.replace(/\.$/, '').toLowerCase()
        : '';
    if (normalized && NO_OP_PATTERNS.includes(normalized)) {
        return { degenerate: true, reason: 'no_op_phrase' };
    }
    if (trimmed.length <= 10) {
        return { degenerate: true, reason: 'ultra_short' };
    }
    return { degenerate: false };
}
