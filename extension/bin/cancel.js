#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { printMinimalPanel, getDataRoot, withRetryLock, findSessionPathForCwd, safeErrorMessage } from '../services/pickle-utils.js';
import { lookupCommandForPid } from '../services/git-utils.js';
import { StateManager } from '../services/state-manager.js';
import { LockError } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { logActivity } from '../services/activity-logger.js';
const sm = new StateManager();
const STALE_LOCK_WINDOW_MS = 5 * 60 * 1000;
/**
 * R-PIWG-4: clean up an orphaned `.git/index.lock` in the session's
 * working_dir when (a) it predates the session's last activity by less
 * than STALE_LOCK_WINDOW_MS (so it's plausibly ours, not external) and
 * (b) no live process holds it. Three outcomes:
 *   - External lock (mtime > stateMtime + window): preserved, no event.
 *   - Live-holder lock: preserved, emits `stale_index_lock_held_by_live_process`.
 *   - Cleanly removable lock: deleted, emits `stale_index_lock_cleaned`.
 */
export function cleanupStaleIndexLock(ctx) {
    const lockPath = path.join(ctx.workingDir, '.git', 'index.lock');
    let lockStat;
    try {
        lockStat = fs.statSync(lockPath);
    }
    catch {
        return;
    }
    if (!lockStat.isFile())
        return;
    const lockMtimeMs = lockStat.mtimeMs;
    const ageSeconds = Math.max(0, Math.round((Date.now() - lockMtimeMs) / 1000));
    if (lockMtimeMs > ctx.stateMtimeMs + STALE_LOCK_WINDOW_MS) {
        // Lock is newer than the session's activity window — external, not ours.
        return;
    }
    // Probe for a live process holding the lock.
    const holder = probeLockHolder(lockPath);
    if (holder !== null) {
        process.stderr.write(`[pickle] WARNING: ${lockPath} is held by PID ${holder.pid} (${holder.command}). Refusing to clean up. Wait for that process to finish or kill it manually.\n`);
        try {
            logActivity({
                event: 'stale_index_lock_held_by_live_process',
                source: 'pickle',
                session: path.basename(ctx.sessionDir),
                gate_payload: {
                    path: lockPath,
                    mtime: new Date(lockMtimeMs).toISOString(),
                    age_seconds: ageSeconds,
                    holder_pid: holder.pid,
                    holder_command: holder.command,
                },
            });
        }
        catch { /* best-effort */ }
        return;
    }
    try {
        fs.unlinkSync(lockPath);
    }
    catch (err) {
        process.stderr.write(`[pickle] WARNING: could not remove ${lockPath}: ${safeErrorMessage(err)}\n`);
        return;
    }
    try {
        logActivity({
            event: 'stale_index_lock_cleaned',
            source: 'pickle',
            session: path.basename(ctx.sessionDir),
            gate_payload: {
                path: lockPath,
                mtime: new Date(lockMtimeMs).toISOString(),
                age_seconds: ageSeconds,
            },
        });
    }
    catch { /* best-effort */ }
}
/**
 * Probe whether a live process holds the given path. Returns null only
 * when a probe tool confidently reports no holder (lsof or pgrep exit
 * with a clear "unheld" status). When neither tool answers confidently
 * (both unavailable, both errored), returns a synthetic
 * `{ pid: -1, command: 'probe-unavailable' }` so the caller refuses to
 * remove the lock conservatively.
 *
 * Strategy:
 *   1. `lsof -t <path>` — POSIX standard, returns PID list on stdout.
 *   2. Fall back to `pgrep -f 'git -C <repo>'` — looser match.
 *   3. If neither tool answers confidently, return a synthetic holder
 *      so the caller refuses to remove the lock (conservative).
 */
function probeLockHolder(lockPath) {
    // Try lsof first.
    const lsof = spawnSync('lsof', ['-t', lockPath], { encoding: 'utf-8', timeout: 5_000 });
    if (lsof.status === 0 && typeof lsof.stdout === 'string') {
        const pids = lsof.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        if (pids.length > 0) {
            const pidNum = Number.parseInt(pids[0], 10);
            if (Number.isFinite(pidNum)) {
                return { pid: pidNum, command: lookupCommandForPid(pidNum) ?? 'unknown' };
            }
        }
        // lsof exited 0 with empty stdout → no holder
        return null;
    }
    if (lsof.status === 1) {
        // lsof exits 1 when no process holds the file — unheld
        return null;
    }
    // lsof unavailable or errored — fall back to pgrep.
    const repoRoot = path.dirname(path.dirname(lockPath)); // parent of .git/
    const pgrep = spawnSync('pgrep', ['-f', `git -C ${repoRoot}`], { encoding: 'utf-8', timeout: 5_000 });
    if (pgrep.status === 0 && typeof pgrep.stdout === 'string') {
        const pid = Number.parseInt(pgrep.stdout.split('\n')[0]?.trim() ?? '', 10);
        if (Number.isFinite(pid)) {
            return { pid, command: lookupCommandForPid(pid) ?? 'unknown' };
        }
    }
    if (pgrep.status === 1) {
        // pgrep exits 1 when no matches — unheld
        return null;
    }
    // Neither tool answered confidently. Refuse cleanup conservatively.
    return { pid: -1, command: 'probe-unavailable' };
}
export function cancelSession(cwd) {
    const SESSIONS_MAP = path.join(getDataRoot(), 'current_sessions.json');
    const sessionPath = findSessionPathForCwd(cwd);
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.log('No active session found for this directory.');
        return;
    }
    const statePath = path.join(sessionPath, 'state.json');
    const recoveredState = readRecoverableJsonObject(statePath);
    if (!fs.existsSync(statePath) && !recoveredState) {
        console.log('State file not found.');
        return;
    }
    let stateMtimeMs = Date.now();
    let workingDir;
    try {
        const stateSnapshot = sm.read(statePath);
        if (stateSnapshot.active !== true) {
            console.log('No active session found for this directory.');
            return;
        }
        workingDir = typeof stateSnapshot.working_dir === 'string' && stateSnapshot.working_dir
            ? stateSnapshot.working_dir
            : cwd;
        try {
            stateMtimeMs = fs.statSync(statePath).mtimeMs;
        }
        catch { /* keep Date.now() fallback */ }
    }
    catch {
        console.log('State file is unreadable.');
        return;
    }
    // Deactivate state AND remove map entry inside one lock to prevent inconsistent state
    // if the process crashes between the two operations.
    let cancelled = false;
    try {
        withRetryLock(SESSIONS_MAP + '.lock', () => {
            // Deactivate state.json
            try {
                sm.update(statePath, s => { s.active = false; });
            }
            catch {
                console.log('State file is unreadable.');
                return;
            }
            cancelled = true;
            // Remove stale entry from the sessions map
            let freshMap = {};
            try {
                freshMap = (readRecoverableJsonObject(SESSIONS_MAP) || {});
            }
            catch { /* ignore */ }
            delete freshMap[cwd];
            const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}`;
            try {
                fs.writeFileSync(tmpMap, JSON.stringify(freshMap, null, 2));
                fs.renameSync(tmpMap, SESSIONS_MAP);
            }
            catch (writeErr) {
                try {
                    fs.unlinkSync(tmpMap);
                }
                catch { /* ignore cleanup failure */ }
                throw writeErr;
            }
        });
    }
    catch (err) {
        if (err instanceof LockError) {
            // Lock exhausted — deactivate state without map consistency guarantee
            console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
            try {
                sm.update(statePath, s => { s.active = false; });
                cancelled = true;
            }
            catch { /* session already deactivated or unreadable */ }
        }
        else {
            throw err;
        }
    }
    if (cancelled) {
        // R-PIWG-4: best-effort cleanup of orphaned .git/index.lock if one exists
        // in the session's working_dir and the lock is plausibly ours.
        try {
            cleanupStaleIndexLock({ sessionDir: sessionPath, workingDir, stateMtimeMs });
        }
        catch { /* best-effort */ }
        printMinimalPanel('Loop Cancelled', {
            Session: path.basename(sessionPath),
            Status: 'Inactive',
        }, 'RED', '🛑');
    }
    else {
        console.log('Failed to cancel session — state file unreadable.');
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
    cancelSession(process.cwd());
}
