/**
 * StateManager — atomic, lock-protected state file operations.
 *
 * Provides read (with schema migration + recovery), update (with file-based
 * lock), multi-file transaction (with rollback), and forceWrite (best-effort,
 * no lock — for signal/crash handlers).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type State,
  type StateManagerOptions,
  STATE_MANAGER_DEFAULTS,
  StateError,
  LockError,
  TransactionError,
} from '../types/index.js';
import { writeStateFile, safeErrorMessage } from './pickle-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockPath(statePath: string): string {
  return `${statePath}.lock`;
}

/** Sleep with optional jitter. */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

export class StateManager {
  private readonly opts: StateManagerOptions;

  constructor(opts: Partial<StateManagerOptions> = {}) {
    this.opts = { ...STATE_MANAGER_DEFAULTS, ...opts };
  }

  // -----------------------------------------------------------------------
  // read — parse, migrate schema, run recovery protocol
  // -----------------------------------------------------------------------

  read(statePath: string): State {
    if (!fs.existsSync(statePath)) {
      throw new StateError('MISSING', `State file not found: ${statePath}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(statePath, 'utf-8');
    } catch (err) {
      const msg = safeErrorMessage(err);
      throw new StateError('MISSING', `Cannot read state file: ${msg}`);
    }

    let state: State;
    try {
      state = JSON.parse(raw) as State;
    } catch (err) {
      const msg = safeErrorMessage(err);
      throw new StateError('CORRUPT', `Invalid JSON in state file: ${msg}`);
    }

    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new StateError('CORRUPT', 'State file does not contain a JSON object');
    }

    // --- Schema migration ---
    if (state.schema_version === undefined) {
      state.schema_version = 1;
      process.stderr.write(`[state-manager] schema_version missing in ${statePath} — migrating to 1\n`);
      // Best-effort persist migration — don't throw if write fails
      try { writeStateFile(statePath, state); } catch { /* migration write failed, non-fatal */ }
    }

    // Future schema versions cannot be safely read by older code — throw.
    // Past schema versions (state < current) are tolerated: unknown fields are ignored.
    if (state.schema_version > this.opts.schemaVersion) {
      throw new StateError(
        'SCHEMA_MISMATCH',
        `State file schema_version ${state.schema_version} is newer than supported version ${this.opts.schemaVersion}`,
      );
    }

    // --- Recovery protocol ---
    this.recoverOrphanTmpFiles(statePath, state);
    this.recoverStaleActiveFlag(statePath, state);

    return state;
  }

  // -----------------------------------------------------------------------
  // update — lock, read, mutate, write, unlock
  // -----------------------------------------------------------------------

  update(statePath: string, mutator: (state: State) => void): State {
    this.acquireLock(statePath);
    try {
      const state = this.read(statePath);
      mutator(state);
      writeStateFile(statePath, state);
      return state;
    } finally {
      this.releaseLock(statePath);
    }
  }

  // -----------------------------------------------------------------------
  // transaction — lock all paths, read all, mutate, write all (with rollback)
  // -----------------------------------------------------------------------

  transaction(paths: string[], mutator: (states: State[]) => void): State[] {
    // Sort paths to prevent deadlock (consistent ordering)
    const sorted = [...paths].sort();

    // Acquire all locks
    const lockedPaths: string[] = [];
    try {
      for (const p of sorted) {
        this.acquireLock(p);
        lockedPaths.push(p);
      }
    } catch (err) {
      // Release any locks we already acquired
      for (const p of lockedPaths) {
        this.releaseLock(p);
      }
      throw err;
    }

    try {
      // Read all states
      const states = sorted.map(p => this.read(p));

      // Apply mutator
      mutator(states);

      // Write all — track originals for rollback
      const originals: Array<{ path: string; backup: string }> = [];
      const written: string[] = [];

      // Backup originals
      for (const p of sorted) {
        const backup = fs.readFileSync(p, 'utf-8');
        originals.push({ path: p, backup });
      }

      try {
        for (let i = 0; i < sorted.length; i++) {
          writeStateFile(sorted[i], states[i]);
          written.push(sorted[i]);
        }
      } catch (writeErr) {
        // Rollback previously written files
        const rollbackErrors: Error[] = [];
        for (const wp of written) {
          const orig = originals.find(o => o.path === wp);
          if (orig) {
            try {
              const parsed = JSON.parse(orig.backup);
              writeStateFile(wp, parsed);
            } catch (rbErr) {
              rollbackErrors.push(rbErr instanceof Error ? rbErr : new Error(String(rbErr)));
            }
          }
        }
        const msg = safeErrorMessage(writeErr);
        throw new TransactionError(
          `Transaction write failed: ${msg}`,
          rollbackErrors,
        );
      }

      // Re-map to original path order for return
      return paths.map(p => {
        const idx = sorted.indexOf(p);
        return states[idx];
      });
    } finally {
      for (const p of lockedPaths) {
        this.releaseLock(p);
      }
    }
  }

  // -----------------------------------------------------------------------
  // forceWrite — best-effort, no lock, never throws
  // -----------------------------------------------------------------------

  forceWrite(statePath: string, state: State | object): void {
    try {
      writeStateFile(statePath, state);
    } catch {
      // Best-effort — swallow all errors
    }
  }

  // -----------------------------------------------------------------------
  // Lock acquisition with exponential backoff + jitter
  // -----------------------------------------------------------------------

  private acquireLock(statePath: string): void {
    const lp = lockPath(statePath);

    for (let attempt = 0; attempt <= this.opts.maxLockRetries; attempt++) {
      try {
        // O_CREAT | O_EXCL — fails if file already exists (atomic)
        const fd = fs.openSync(lp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        // Write PID + timestamp for stale detection
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        return;
      } catch {
        // Check if existing lock is stale
        if (this.tryStealStaleLock(lp)) {
          // Stolen — retry immediately (don't count as attempt)
          attempt--;
          continue;
        }

        if (attempt < this.opts.maxLockRetries) {
          const base = this.opts.baseLockDelayMs * Math.pow(2, attempt);
          const jitter = this.opts.lockJitter ? Math.random() * this.opts.baseLockDelayMs : 0;
          sleepSync(Math.min(base + jitter, 5000));
        }
      }
    }

    throw new LockError(`Failed to acquire lock after ${this.opts.maxLockRetries} retries: ${lp}`);
  }

  private releaseLock(statePath: string): void {
    try {
      fs.unlinkSync(lockPath(statePath));
    } catch {
      // Lock file already gone — harmless
    }
  }

  private tryStealStaleLock(lp: string): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(lp, 'utf-8');
    } catch {
      // Can't read lock file — might have been removed by holder
      return false;
    }

    let lock: { pid: number; ts: number };
    try {
      lock = JSON.parse(raw) as { pid: number; ts: number };
    } catch {
      // Corrupt JSON in lock file — safe to steal
      try { fs.unlinkSync(lp); } catch { /* race */ }
      return true;
    }

    const lockPid = Number(lock.pid);
    const lockTs = Number(lock.ts);

    if (!Number.isFinite(lockPid) || !Number.isFinite(lockTs)) {
      // Invalid pid/ts — safe to steal
      try { fs.unlinkSync(lp); } catch { /* race */ }
      return true;
    }

    // Stale if process is dead OR lock is older than staleLockTimeoutMs
    const isStale = !isProcessAlive(lockPid) || (Date.now() - lockTs > this.opts.staleLockTimeoutMs);

    if (isStale) {
      try { fs.unlinkSync(lp); } catch { /* race */ }
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Recovery: orphan tmp files
  // -----------------------------------------------------------------------

  private recoverOrphanTmpFiles(statePath: string, _state: State): void {
    const dir = path.dirname(statePath);
    const base = path.basename(statePath);

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    const tmpPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)$`);

    for (const entry of entries) {
      const match = entry.match(tmpPattern);
      if (!match) continue;

      const tmpPath = path.join(dir, entry);
      const tmpPid = Number(match[1]);

      // If owning process is still alive, leave it alone
      if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid)) continue;

      // Check if tmpfile contains valid JSON
      try {
        const raw = fs.readFileSync(tmpPath, 'utf-8');
        const tmpState = JSON.parse(raw) as Record<string, unknown>;

        // Promote if tmpfile has a higher iteration (crash during write)
        const tmpIter = Number(tmpState.iteration);
        const curIter = Number(_state.iteration);
        if (Number.isFinite(tmpIter) && Number.isFinite(curIter) && tmpIter > curIter) {
          fs.renameSync(tmpPath, statePath);
          // Re-read promoted state into _state
          Object.assign(_state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
        } else {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Invalid tmpfile — delete it
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: stale active flag
  // -----------------------------------------------------------------------

  private recoverStaleActiveFlag(statePath: string, state: State): void {
    if (state.active !== true) return;
    if (state.pid === undefined || state.pid === null) return;

    const pid = Number(state.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;

    if (!isProcessAlive(pid)) {
      state.active = false;
      try { writeStateFile(statePath, state); } catch { /* best-effort */ }
    }
  }
}
