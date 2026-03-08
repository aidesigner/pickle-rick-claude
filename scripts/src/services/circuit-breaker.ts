import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type { State } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  noProgressThreshold: 5,
  sameErrorThreshold: 5,
  halfOpenAfter: 2,
};

// ---------------------------------------------------------------------------
// Private Helpers
// ---------------------------------------------------------------------------

function freshState(): CircuitBreakerState {
  return {
    state: 'CLOSED',
    last_change: new Date().toISOString(),
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: '',
    last_known_step: null,
    last_known_ticket: null,
    last_progress_iteration: 0,
    total_opens: 0,
    reason: '',
    opened_at: null,
    history: [],
  };
}

function transition(
  cbState: CircuitBreakerState,
  to: CircuitState,
  reason: string,
): void {
  const from = cbState.state;
  if (from === to) return;
  const now = new Date().toISOString();
  cbState.history.push({ from, to, timestamp: now, reason });
  cbState.state = to;
  cbState.last_change = now;
  cbState.reason = to === 'CLOSED' ? '' : reason;
  if (to === 'OPEN') {
    cbState.total_opens++;
    cbState.opened_at = now;
  }
  if (to === 'CLOSED') {
    cbState.opened_at = null;
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function gitExec(args: string[], cwd: string): string {
  try {
    return execSync(['git', ...args].join(' '), {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

export function normalizeErrorSignature(error: string): string {
  let s = error;

  // Rule 1: Replace absolute paths
  s = s.replace(/\/[\w.@/-]+/g, '<PATH>');

  // Rule 2: Replace ISO timestamps (before line:col to avoid partial match)
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TIME>');

  // Rule 3: Replace UUIDs (before line:col to avoid partial match)
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');

  // Rule 4: Replace line:column patterns
  s = s.replace(/\d+:\d+/g, '<LOC>');

  // Rule 5: Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Rule 6: Truncate to 200 characters
  if (s.length > 200) s = s.slice(0, 200);

  // Rule 7: Lowercase
  s = s.toLowerCase();

  return s;
}

export function checkProgress(current: State, cbState: CircuitBreakerState): boolean {
  // First-iteration warm-up: no baseline to compare against
  if (cbState.last_known_head === '' && cbState.last_known_step === null) {
    return true;
  }

  // Signal 1: Git HEAD changed
  const currentHead = gitExec(['rev-parse', 'HEAD'], current.working_dir);
  if (currentHead && currentHead !== cbState.last_known_head) return true;

  // Signal 2: Uncommitted changes differ
  const uncommitted = gitExec(['diff', '--stat'], current.working_dir);
  if (uncommitted.length > 0) return true;

  // Signal 3: Staged changes differ
  const staged = gitExec(['diff', '--stat', '--cached'], current.working_dir);
  if (staged.length > 0) return true;

  // Signal 4: Step changed
  if (current.step !== cbState.last_known_step) return true;

  // Signal 5: Current ticket changed
  if (current.current_ticket !== cbState.last_known_ticket) return true;

  return false;
}

export function validateCBConfig(config: CircuitBreakerConfig): void {
  if (config.noProgressThreshold < 2) {
    throw new Error('CB threshold validation: noProgressThreshold must be >= 2');
  }
  if (config.sameErrorThreshold < 2) {
    throw new Error('CB threshold validation: sameErrorThreshold must be >= 2');
  }
  if (config.halfOpenAfter >= config.noProgressThreshold) {
    throw new Error('CB threshold validation: halfOpenAfter must be < noProgressThreshold');
  }
}

export function loadCBState(sessionDir: string): CircuitBreakerState {
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');
  const raw = readJsonSafe<Record<string, unknown>>(cbPath, {});

  if (!raw.state || !['CLOSED', 'HALF_OPEN', 'OPEN'].includes(raw.state as string)) {
    return freshState();
  }

  return {
    state: raw.state as CircuitState,
    last_change: (raw.last_change as string) || new Date().toISOString(),
    consecutive_no_progress: Number(raw.consecutive_no_progress) || 0,
    consecutive_same_error: Number(raw.consecutive_same_error) || 0,
    last_error_signature: (raw.last_error_signature as string) ?? null,
    last_known_head: (raw.last_known_head as string) || '',
    last_known_step: (raw.last_known_step as string) ?? null,
    last_known_ticket: (raw.last_known_ticket as string) ?? null,
    last_progress_iteration: Number(raw.last_progress_iteration) || 0,
    total_opens: Number(raw.total_opens) || 0,
    reason: (raw.reason as string) || '',
    opened_at: (raw.opened_at as string) ?? null,
    history: Array.isArray(raw.history) ? (raw.history as CircuitTransition[]) : [],
  };
}

export function saveCBState(sessionDir: string, cbState: CircuitBreakerState): void {
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');
  atomicWriteJson(cbPath, cbState);
}

export function recordIteration(
  sessionDir: string,
  state: State,
  error?: string,
): CircuitBreakerState {
  const configPath = path.join(sessionDir, '..', 'config.json');
  const rawConfig = readJsonSafe<Record<string, unknown>>(configPath, {});
  const config: CircuitBreakerConfig = { ...DEFAULT_CONFIG };

  if (typeof rawConfig.cb_enabled === 'boolean') config.enabled = rawConfig.cb_enabled;
  if (typeof rawConfig.cb_no_progress_threshold === 'number') config.noProgressThreshold = rawConfig.cb_no_progress_threshold;
  if (typeof rawConfig.cb_same_error_threshold === 'number') config.sameErrorThreshold = rawConfig.cb_same_error_threshold;
  if (typeof rawConfig.cb_half_open_after === 'number') config.halfOpenAfter = rawConfig.cb_half_open_after;

  if (!config.enabled) {
    return loadCBState(sessionDir);
  }

  // Validate (clamp, don't throw — runtime should be forgiving)
  if (config.noProgressThreshold < 2) config.noProgressThreshold = 2;
  if (config.sameErrorThreshold < 2) config.sameErrorThreshold = 2;
  if (config.halfOpenAfter >= config.noProgressThreshold) {
    config.halfOpenAfter = config.noProgressThreshold - 1;
  }

  const cbState = loadCBState(sessionDir);

  // Already OPEN — terminal state
  if (cbState.state === 'OPEN') {
    saveCBState(sessionDir, cbState);
    return cbState;
  }

  const hasProgress = checkProgress(state, cbState);

  // Update snapshot fields
  const currentHead = gitExec(['rev-parse', 'HEAD'], state.working_dir);
  if (currentHead) cbState.last_known_head = currentHead;
  cbState.last_known_step = state.step;
  cbState.last_known_ticket = state.current_ticket;

  // Error tracking (independent of progress)
  if (error) {
    const sig = normalizeErrorSignature(error);
    if (sig === cbState.last_error_signature) {
      cbState.consecutive_same_error++;
    } else {
      cbState.consecutive_same_error = 1;
      cbState.last_error_signature = sig;
    }
  } else {
    cbState.consecutive_same_error = 0;
    cbState.last_error_signature = null;
  }

  // Progress tracking
  if (hasProgress) {
    cbState.consecutive_no_progress = 0;
    cbState.last_progress_iteration = state.iteration;
    if (cbState.state === 'HALF_OPEN') {
      transition(cbState, 'CLOSED', 'Progress detected');
    }
  } else {
    cbState.consecutive_no_progress++;
  }

  // State transitions — error threshold first
  if (cbState.consecutive_same_error >= config.sameErrorThreshold) {
    transition(cbState, 'OPEN', `Same error repeated ${cbState.consecutive_same_error} times`);
  } else if (cbState.consecutive_no_progress >= config.noProgressThreshold) {
    transition(cbState, 'OPEN', `No progress in ${cbState.consecutive_no_progress} iterations`);
  } else if (cbState.consecutive_no_progress >= config.halfOpenAfter && cbState.state === 'CLOSED') {
    transition(cbState, 'HALF_OPEN', `No progress in ${cbState.consecutive_no_progress} iterations`);
  }

  saveCBState(sessionDir, cbState);
  return cbState;
}
