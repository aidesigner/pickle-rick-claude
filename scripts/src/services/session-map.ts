import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getExtensionRoot } from './config.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getSessionsMapPath(): string {
  return path.join(getExtensionRoot(), 'current_sessions.json');
}

function getSessionsRoot(): string {
  return path.join(getExtensionRoot(), 'sessions');
}

// ---------------------------------------------------------------------------
// Inline I/O helpers (will be replaced by pickle-utils when fb281903 lands)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// File Lock
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withSessionMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = getSessionsMapPath() + '.lock';
  const MAX_WAIT_MS = 3000;
  const RETRY_MS = 50;
  const STALE_MS = 5000;
  const deadline = Date.now() + MAX_WAIT_MS;
  let acquired = false;

  while (!acquired) {
    let stale = false;
    try {
      const stats = fs.statSync(lockPath);
      stale = Date.now() - stats.mtimeMs > STALE_MS;
    } catch { /* lock doesn't exist */ }

    if (stale) {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }

    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        console.error(`[session-map] WARNING: lock acquisition timed out, proceeding without lock`);
        break;
      }
      await sleep(Math.min(RETRY_MS, deadline - Date.now()));
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Session Map Operations
// ---------------------------------------------------------------------------

export async function updateSessionMap(cwd: string, sessionPath: string): Promise<void> {
  await withSessionMapLock(async () => {
    const mapPath = getSessionsMapPath();
    const map = readJsonSafe<Record<string, string>>(mapPath, {});
    map[cwd] = sessionPath;
    atomicWriteJson(mapPath, map);
  });
}

export async function removeFromSessionMap(cwd: string): Promise<void> {
  await withSessionMapLock(async () => {
    const mapPath = getSessionsMapPath();
    const map = readJsonSafe<Record<string, string>>(mapPath, {});
    delete map[cwd];
    atomicWriteJson(mapPath, map);
  });
}

export async function getSessionForCwd(cwd: string): Promise<string | null> {
  const mapPath = getSessionsMapPath();
  const map = readJsonSafe<Record<string, string>>(mapPath, {});
  const sessionPath = map[cwd];
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  return sessionPath;
}

export async function listSessions(): Promise<Array<{ cwd: string; sessionDir: string }>> {
  const mapPath = getSessionsMapPath();
  const map = readJsonSafe<Record<string, string>>(mapPath, {});
  return Object.entries(map).map(([cwd, sessionDir]) => ({ cwd, sessionDir }));
}

// ---------------------------------------------------------------------------
// Session Pruning (map entries only — no directory deletion)
// ---------------------------------------------------------------------------

export async function pruneSessionMap(maxAgeDays = 7): Promise<void> {
  const sessionsRoot = getSessionsRoot();
  if (!fs.existsSync(sessionsRoot)) return;

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  await withSessionMapLock(async () => {
    const mapPath = getSessionsMapPath();
    const map = readJsonSafe<Record<string, string>>(mapPath, {});
    let changed = false;

    for (const [cwd, sessionDir] of Object.entries(map)) {
      const statePath = path.join(sessionDir, 'state.json');
      try {
        if (!fs.existsSync(statePath)) {
          delete map[cwd];
          changed = true;
          continue;
        }
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (state.active === true) continue;

        const rawMs = state.started_at ? new Date(state.started_at).getTime() : NaN;
        const startedMs = Number.isFinite(rawMs)
          ? rawMs
          : fs.statSync(sessionDir).mtimeMs;

        if (startedMs < cutoffMs) {
          delete map[cwd];
          changed = true;
        }
      } catch {
        delete map[cwd];
        changed = true;
      }
    }

    if (changed) {
      atomicWriteJson(mapPath, map);
    }
  });
}

// ---------------------------------------------------------------------------
// Scan sessions directory (for --last flag)
// ---------------------------------------------------------------------------

export async function findLastSessionForCwd(
  targetCwd: string,
): Promise<string | null> {
  const sessionsRoot = getSessionsRoot();
  if (!fs.existsSync(sessionsRoot)) return null;

  let bestDir: string | null = null;
  let bestTime = 0;

  for (const entry of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, entry);
    const statePath = path.join(sessionDir, 'state.json');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.working_dir !== targetCwd) continue;

      const rawMs = state.started_at ? new Date(state.started_at).getTime() : 0;
      const startedMs = Number.isFinite(rawMs) ? rawMs : 0;

      if (startedMs > bestTime) {
        bestTime = startedMs;
        bestDir = sessionDir;
      }
    } catch { /* skip unreadable */ }
  }

  if (bestDir) {
    await updateSessionMap(targetCwd, bestDir);
  }

  return bestDir;
}
