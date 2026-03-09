import type { State, CompletionClassification, IterationExitResult } from './types/index.js';
export { isDegenerate } from './services/degenerate-detector.js';
/**
 * Classifies iteration output into a completion result.
 * Checks tokens in priority order per PRD table.
 * WORKER_DONE and ANALYSIS_DONE are NOT scanned.
 */
export declare function classifyCompletion(output: string, state?: Partial<State>): CompletionClassification;
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
