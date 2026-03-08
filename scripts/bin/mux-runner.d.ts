import type { State, CompletionClassification, IterationExitResult } from './types/index.js';
/**
 * Classifies iteration output into a completion result.
 * Checks tokens in priority order per PRD table.
 * WORKER_DONE and ANALYSIS_DONE are NOT scanned.
 */
export declare function classifyCompletion(output: string, state?: Partial<State>): CompletionClassification;
/**
 * Detects degenerate (no-op) output from workers.
 * Whitespace-only, ultra-short, or no-op phrases.
 */
export declare function isDegenerate(output: string): boolean;
/**
 * Classifies iteration exit based on raw spawn result.
 * Rate limit detection runs first to prevent circuit breaker poisoning.
 */
export declare function classifyIterationExit(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean): IterationExitResult;
/**
 * Validates command template name — rejects path traversal.
 */
export declare function validateCommandTemplate(template: string): void;
/**
 * Transitions session from ticket-execution to Meeseeks review mode.
 * Pure function — returns new state.
 */
export declare function transitionToMeeseeks(state: State): State;
