import type { State } from '../types/index.js';
export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';
export interface CircuitTransition {
    from: CircuitState;
    to: CircuitState;
    timestamp: string;
    reason: string;
}
export interface CircuitBreakerState {
    state: CircuitState;
    last_change: string;
    consecutive_no_progress: number;
    consecutive_same_error: number;
    last_error_signature: string | null;
    last_known_head: string;
    last_known_step: string | null;
    last_known_ticket: string | null;
    last_progress_iteration: number;
    total_opens: number;
    reason: string;
    opened_at: string | null;
    history: CircuitTransition[];
}
export interface CircuitBreakerConfig {
    enabled: boolean;
    noProgressThreshold: number;
    sameErrorThreshold: number;
    halfOpenAfter: number;
}
export declare function normalizeErrorSignature(error: string): string;
export declare function checkProgress(current: State, cbState: CircuitBreakerState): boolean;
export declare function validateCBConfig(config: CircuitBreakerConfig): void;
export declare function loadCBState(sessionDir: string): CircuitBreakerState;
export declare function saveCBState(sessionDir: string, cbState: CircuitBreakerState): void;
export declare function recordIteration(sessionDir: string, state: State, error?: string): CircuitBreakerState;
