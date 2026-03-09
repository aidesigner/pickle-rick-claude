import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  getSessionForCwd,
  withSessionMapLock,
} from './services/session-map.js';
import { getExtensionRoot } from './services/config.js';

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

export async function cancelSession(cwd: string): Promise<boolean> {
  const sessionPath = await getSessionForCwd(cwd);
  if (!sessionPath) {
    console.log('No active session found for this directory.');
    return false;
  }

  const statePath = path.join(sessionPath, 'state.json');
  if (!fs.existsSync(statePath)) {
    console.log('State file not found.');
    return false;
  }

  const mapPath = path.join(getExtensionRoot(), 'current_sessions.json');
  let cancelled = false;

  try {
    await withSessionMapLock(async () => {
      // Deactivate state.json
      const state = readJsonSafe<Record<string, unknown>>(statePath, {});
      state.active = false;
      atomicWriteJson(statePath, state);
      cancelled = true;

      // Remove from session map
      const map = readJsonSafe<Record<string, string>>(mapPath, {});
      delete map[cwd];
      atomicWriteJson(mapPath, map);
    });
  } catch {
    // Fallback: deactivate without lock
    try {
      const state = readJsonSafe<Record<string, unknown>>(statePath, {});
      state.active = false;
      atomicWriteJson(statePath, state);
      cancelled = true;
    } catch { /* unreadable */ }
  }

  if (cancelled) {
    console.log(`Session cancelled: ${path.basename(sessionPath)}`);
  } else {
    console.log('Failed to cancel session.');
  }

  return cancelled;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
  let cwd = process.cwd();
  const cwdIdx = process.argv.indexOf('--cwd');
  if (cwdIdx !== -1 && process.argv[cwdIdx + 1]) {
    cwd = process.argv[cwdIdx + 1];
  }
  cancelSession(cwd).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
