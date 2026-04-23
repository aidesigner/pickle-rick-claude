/**
 * StateManager — atomic, lock-protected state file operations.
 *
 * Provides read (with schema migration + recovery), update (with file-based
 * lock), multi-file transaction (with rollback), and forceWrite (best-effort,
 * no lock — for signal/crash handlers).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_MANAGER_DEFAULTS, StateError, LockError, TransactionError, } from '../types/index.js';
import { writeStateFile, safeErrorMessage } from './pickle-utils.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function lockPath(statePath) {
    return `${statePath}.lock`;
}
// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep that yields to the OS scheduler instead of busy-waiting. */
function sleepSync(ms) {
    Atomics.wait(_sleepBuf, 0, 0, ms);
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------
export class StateManager {
    opts;
    constructor(opts = {}) {
        this.opts = { ...STATE_MANAGER_DEFAULTS, ...opts };
    }
    // -----------------------------------------------------------------------
    // read — parse, migrate schema, run recovery protocol
    // -----------------------------------------------------------------------
    read(statePath) {
        if (!fs.existsSync(statePath)) {
            throw new StateError('MISSING', `State file not found: ${statePath}`);
        }
        let raw;
        try {
            raw = fs.readFileSync(statePath, 'utf-8');
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            throw new StateError('MISSING', `Cannot read state file: ${msg}`);
        }
        let state;
        try {
            state = JSON.parse(raw);
        }
        catch (err) {
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
            try {
                writeStateFile(statePath, state);
            }
            catch { /* migration write failed, non-fatal */ }
        }
        // Future schema versions cannot be safely read by older code — throw.
        // Past schema versions (state < current) are tolerated: unknown fields are ignored.
        if (state.schema_version > this.opts.schemaVersion) {
            throw new StateError('SCHEMA_MISMATCH', `State file schema_version ${state.schema_version} is newer than supported version ${this.opts.schemaVersion}`);
        }
        // --- Recovery protocol ---
        this.recoverOrphanTmpFiles(statePath, state);
        this.recoverStaleActiveFlag(statePath, state);
        return state;
    }
    // -----------------------------------------------------------------------
    // update — lock, read, mutate, write, unlock
    // -----------------------------------------------------------------------
    update(statePath, mutator) {
        this.acquireLock(statePath);
        try {
            const state = this.read(statePath);
            mutator(state);
            writeStateFile(statePath, state);
            return state;
        }
        finally {
            this.releaseLock(statePath);
        }
    }
    // -----------------------------------------------------------------------
    // transaction — lock all paths, read all, mutate, write all (with rollback)
    // -----------------------------------------------------------------------
    transaction(paths, mutator) {
        const sorted = [...paths].sort(); // consistent order prevents cross-tx deadlock
        const lockedPaths = this.acquireAllLocks(sorted);
        try {
            const states = sorted.map(p => this.read(p));
            mutator(states);
            this.writeAllWithRollback(sorted, states);
            return paths.map(p => states[sorted.indexOf(p)]);
        }
        finally {
            for (const p of lockedPaths)
                this.releaseLock(p);
        }
    }
    acquireAllLocks(sorted) {
        const locked = [];
        try {
            for (const p of sorted) {
                this.acquireLock(p);
                locked.push(p);
            }
            return locked;
        }
        catch (err) {
            for (const p of locked)
                this.releaseLock(p);
            throw err;
        }
    }
    writeAllWithRollback(sorted, states) {
        const originals = sorted.map(p => ({ path: p, backup: fs.readFileSync(p, 'utf-8') }));
        const written = [];
        try {
            for (let i = 0; i < sorted.length; i++) {
                writeStateFile(sorted[i], states[i]);
                written.push(sorted[i]);
            }
        }
        catch (writeErr) {
            const rollbackErrors = [];
            for (const wp of written) {
                const orig = originals.find(o => o.path === wp);
                if (!orig)
                    continue;
                try {
                    writeStateFile(wp, JSON.parse(orig.backup));
                }
                catch (rbErr) {
                    rollbackErrors.push(rbErr instanceof Error ? rbErr : new Error(String(rbErr)));
                }
            }
            throw new TransactionError(`Transaction write failed: ${safeErrorMessage(writeErr)}`, rollbackErrors);
        }
    }
    // -----------------------------------------------------------------------
    // forceWrite — best-effort, no lock, never throws
    // -----------------------------------------------------------------------
    forceWrite(statePath, state) {
        try {
            writeStateFile(statePath, state);
        }
        catch {
            // Best-effort — swallow all errors
        }
    }
    // -----------------------------------------------------------------------
    // Lock acquisition with exponential backoff + jitter
    // -----------------------------------------------------------------------
    acquireLock(statePath) {
        const lp = lockPath(statePath);
        let steals = 0;
        const maxSteals = 3; // Cap stale-steal retries to prevent unbounded loops
        for (let attempt = 0; attempt <= this.opts.maxLockRetries; attempt++) {
            try {
                // O_CREAT | O_EXCL — fails if file already exists (atomic)
                const fd = fs.openSync(lp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
                // Write PID + timestamp for stale detection
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
                fs.closeSync(fd);
                return;
            }
            catch {
                // Check if existing lock is stale (bounded steal attempts)
                if (steals < maxSteals && this.tryStealStaleLock(lp)) {
                    steals++;
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
    releaseLock(statePath) {
        try {
            fs.unlinkSync(lockPath(statePath));
        }
        catch {
            // Lock file already gone — harmless
        }
    }
    tryStealStaleLock(lp) {
        let raw;
        try {
            raw = fs.readFileSync(lp, 'utf-8');
        }
        catch {
            // Can't read lock file — might have been removed by holder
            return false;
        }
        const shouldSteal = (() => {
            try {
                const lock = JSON.parse(raw);
                const lockPid = Number(lock.pid);
                const lockTs = Number(lock.ts);
                if (!Number.isFinite(lockPid) || !Number.isFinite(lockTs))
                    return true;
                return !isProcessAlive(lockPid) || (Date.now() - lockTs > this.opts.staleLockTimeoutMs);
            }
            catch {
                // Corrupt JSON — safe to steal
                return true;
            }
        })();
        if (!shouldSteal)
            return false;
        // Atomic steal: rename to a unique tombstone, then delete. This prevents
        // two processes from both unlinking the same lock and both believing they
        // stole it (the classic TOCTOU race with unlink).
        const tombstone = `${lp}.tomb.${process.pid}.${Date.now()}`;
        try {
            fs.renameSync(lp, tombstone);
            // We won the rename — lock is ours to clean up
            try {
                fs.unlinkSync(tombstone);
            }
            catch { /* best-effort */ }
            return true;
        }
        catch {
            // Another process already renamed/removed it — we lost the race
            try {
                fs.unlinkSync(tombstone);
            }
            catch { /* might not exist */ }
            return false;
        }
    }
    // -----------------------------------------------------------------------
    // Recovery: orphan tmp files
    // -----------------------------------------------------------------------
    recoverOrphanTmpFiles(statePath, _state) {
        const dir = path.dirname(statePath);
        const base = path.basename(statePath);
        let entries;
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            return;
        }
        const tmpPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)$`);
        for (const entry of entries) {
            const match = entry.match(tmpPattern);
            if (!match)
                continue;
            const tmpPath = path.join(dir, entry);
            const tmpPid = Number(match[1]);
            // If owning process is still alive, leave it alone
            if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid))
                continue;
            // Check if tmpfile contains valid JSON
            try {
                const raw = fs.readFileSync(tmpPath, 'utf-8');
                const tmpState = JSON.parse(raw);
                // Promote if tmpfile has a higher iteration (crash during write)
                const tmpIter = Number(tmpState.iteration);
                const curIter = Number(_state.iteration);
                if (Number.isFinite(tmpIter) && Number.isFinite(curIter) && tmpIter > curIter) {
                    fs.renameSync(tmpPath, statePath);
                    // Re-read promoted state into _state
                    Object.assign(_state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
                }
                else {
                    fs.unlinkSync(tmpPath);
                }
            }
            catch {
                // Invalid tmpfile — delete it
                try {
                    fs.unlinkSync(tmpPath);
                }
                catch { /* ignore */ }
            }
        }
    }
    // -----------------------------------------------------------------------
    // Recovery: stale active flag
    // -----------------------------------------------------------------------
    recoverStaleActiveFlag(statePath, state) {
        if (state.active !== true)
            return;
        if (state.pid === undefined || state.pid === null)
            return;
        const pid = Number(state.pid);
        if (!Number.isFinite(pid) || pid <= 0)
            return;
        if (!isProcessAlive(pid)) {
            state.active = false;
            try {
                writeStateFile(statePath, state);
            }
            catch { /* best-effort */ }
        }
    }
}
// ---------------------------------------------------------------------------
// Module-level singleton for standalone helpers
// ---------------------------------------------------------------------------
const _sm = new StateManager();
/**
 * Try `_sm.update` (locked); on failure, fall back to read-then-forceWrite. If the
 * read/parse also fails and `fallbackFactory` is provided, forceWrite that seed;
 * otherwise no write occurs. Never throws.
 */
function forceWriteMutate(statePath, mutator, fallbackFactory) {
    try {
        _sm.update(statePath, mutator);
        return;
    }
    catch { /* fall through to best-effort path */ }
    let seed = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        mutator(parsed);
        seed = parsed;
    }
    catch {
        if (fallbackFactory)
            seed = fallbackFactory();
    }
    if (seed !== null)
        _sm.forceWrite(statePath, seed);
}
/** Deactivate with retry-then-forceWrite: try update, fall back to read-then-forceWrite. Never throws. */
export function safeDeactivate(statePath) {
    forceWriteMutate(statePath, s => { s.active = false; }, () => ({ active: false }));
}
/**
 * Append a single activity entry to `state.json.activity` (creating the array if missing).
 * Best-effort: primary path uses locked sm.update; on lock failure falls back to
 * read-modify-forceWrite. Never throws — halt paths must not fail on logging.
 */
export function writeActivityEntry(statePath, entry) {
    forceWriteMutate(statePath, s => {
        const existing = Array.isArray(s.activity) ? s.activity : [];
        s.activity = [...existing, entry];
    }, null);
}
/**
 * Write a TASK_NOTES.md stub at sessionDir/TASK_NOTES.md when the file is absent
 * or empty (FR-B8). Non-empty content — whether Morty-written or a prior stub — is
 * never overwritten (FR-B9). Writes atomically via tmp+rename. Never throws.
 */
export function writeTimeoutStub(sessionDir, meta) {
    const stubPath = path.join(sessionDir, 'TASK_NOTES.md');
    if (fs.existsSync(stubPath)) {
        try {
            const existing = fs.readFileSync(stubPath, 'utf-8');
            if (existing.trim().length > 0)
                return;
        }
        catch {
            return;
        }
    }
    let lastLogLine = '(no log output)';
    try {
        const logContent = fs.readFileSync(meta.logFile, 'utf-8');
        const lines = logContent.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 0)
            lastLogLine = lines[lines.length - 1];
    }
    catch { /* log missing — use placeholder */ }
    const stub = [
        '<!-- pickle-rick: timeout-stub v1 -->',
        '# TASK_NOTES.md (synthesized stub)',
        '',
        '## Progress',
        `Iteration ${meta.iteration} SIGTERM'd at ${Math.round(meta.wallSeconds)}s of ${meta.workerTimeoutSeconds}s budget.`,
        `Ticket: ${meta.ticketId ?? '(unknown)'}`,
        `Attempt: ${meta.timeoutCount}`,
        '',
        '## Dead Ends',
        `Previous iteration did not complete within ${meta.workerTimeoutSeconds}s. Do not repeat the same approach without optimization.`,
        '',
        '## Key Discoveries',
        `Last log line: ${lastLogLine}`,
        '',
        '## Next',
        `Next iteration must finish within ${meta.workerTimeoutSeconds}s or the runner will halt after 2 consecutive timeouts.`,
    ].join('\n');
    const tmpPath = `${stubPath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpPath, stub);
        fs.renameSync(tmpPath, stubPath);
    }
    catch {
        try {
            fs.writeFileSync(stubPath, stub);
        }
        catch { /* best-effort */ }
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* cleanup */ }
    }
}
