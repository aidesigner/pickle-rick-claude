/**
 * Degenerate output detection service.
 * Detects whitespace-only, ultra-short, and no-op phrase outputs from workers.
 */
export declare const NO_OP_PATTERNS: string[];
export interface DegenerateResult {
    degenerate: boolean;
    reason?: 'whitespace_only' | 'ultra_short' | 'no_op_phrase';
}
/**
 * Extract the last N lines from output.
 */
export declare function extractTail(output: string, lines?: number): string;
/**
 * Detect degenerate (no-op) output from workers.
 * Null/undefined input treated as whitespace-only.
 */
export declare function isDegenerate(output: string): DegenerateResult;
