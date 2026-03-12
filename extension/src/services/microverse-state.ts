import * as fs from 'fs';
import * as path from 'path';
import type { MicroverseSessionState, MicroverseMetric, MicroverseHistoryEntry } from '../types/index.js';
import { writeStateFile } from './pickle-utils.js';

const MICROVERSE_FILE = 'microverse.json';

export function compareMetric(
  current: number,
  previous: number,
  tolerance: number,
  direction?: 'higher' | 'lower'
): 'improved' | 'held' | 'regressed' {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(tolerance)) {
    return 'held';
  }
  if ((direction ?? 'higher') === 'lower') {
    if (current < previous - tolerance) return 'improved';
    if (current > previous + tolerance) return 'regressed';
    return 'held';
  }
  if (current > previous + tolerance) return 'improved';
  if (current < previous - tolerance) return 'regressed';
  return 'held';
}

export function createMicroverseState(
  prdPath: string,
  metric: MicroverseMetric,
  stallLimit: number
): MicroverseSessionState {
  if (!Number.isInteger(stallLimit) || stallLimit < 1) {
    throw new Error(`stall_limit must be a positive integer, got ${stallLimit}`);
  }
  if (!Number.isFinite(metric.tolerance) || metric.tolerance < 0) {
    throw new Error(`tolerance must be a non-negative number, got ${metric.tolerance}`);
  }
  return {
    status: 'gap_analysis',
    prd_path: prdPath,
    key_metric: { ...metric, direction: metric.direction ?? 'higher' },
    convergence: {
      stall_limit: stallLimit,
      stall_counter: 0,
      history: [],
    },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 0,
  };
}

/**
 * Record a scored iteration (agent made commits and metric was measured).
 * Stall counter resets on accepted improvements, increments otherwise.
 */
export function recordIteration(
  state: MicroverseSessionState,
  entry: MicroverseHistoryEntry
): MicroverseSessionState {
  const history = [...state.convergence.history, entry];
  const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');
  const previousScore = lastAccepted ? lastAccepted.score : state.baseline_score;
  const classification = compareMetric(entry.score, previousScore, state.key_metric.tolerance, state.key_metric.direction);
  const stallCounter = entry.action === 'accept' && classification === 'improved'
    ? 0
    : state.convergence.stall_counter + 1;

  return {
    ...state,
    convergence: {
      ...state.convergence,
      history,
      stall_counter: stallCounter,
    },
  };
}

/**
 * Record a stall (no commits or metric unmeasurable). Increments stall_counter
 * without adding a history entry. This is the ONLY place stall_counter is
 * incremented outside of recordIteration — centralizing stall logic.
 */
export function recordStall(state: MicroverseSessionState): MicroverseSessionState {
  return {
    ...state,
    convergence: {
      ...state.convergence,
      stall_counter: state.convergence.stall_counter + 1,
    },
  };
}

export function recordFailedApproach(
  state: MicroverseSessionState,
  description: string
): MicroverseSessionState {
  return {
    ...state,
    failed_approaches: [...state.failed_approaches, description],
  };
}

export function isConverged(state: MicroverseSessionState): boolean {
  return state.convergence.stall_counter >= state.convergence.stall_limit;
}

export function writeMicroverseState(
  sessionDir: string,
  state: MicroverseSessionState
): void {
  writeStateFile(path.join(sessionDir, MICROVERSE_FILE), state);
}

export function readMicroverseState(
  sessionDir: string
): MicroverseSessionState | null {
  const filePath = path.join(sessionDir, MICROVERSE_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as MicroverseSessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[microverse-state] Failed to read ${filePath}: ${msg}`);
    return null;
  }
}
