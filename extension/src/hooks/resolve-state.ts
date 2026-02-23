import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { State } from '../types/index.js';

const ALLOW = JSON.stringify({ decision: 'approve' });

export function getExtensionDir(): string {
  return process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
}

/**
 * Resolves the state file path from env or the sessions map.
 * Returns null if no active state file is found.
 */
export function resolveStateFile(extensionDir: string): string | null {
  let stateFile = process.env.PICKLE_STATE_FILE;
  if (!stateFile) {
    const sessionsMapPath = path.join(extensionDir, 'current_sessions.json');
    if (fs.existsSync(sessionsMapPath)) {
      try {
        const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
        const sessionPath = map[process.cwd()];
        if (sessionPath) stateFile = path.join(sessionPath, 'state.json');
      } catch {
        /* corrupt sessions map — treat as no active session */
      }
    }
  }
  if (!stateFile || !fs.existsSync(stateFile)) return null;
  return stateFile;
}

/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile: string): State | null {
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
  if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
    return null;
  }
  if (!state.active) return null;
  return state;
}

/** Prints the "approve" decision to stdout. */
export function approve(): void {
  console.log(ALLOW);
}

/**
 * Atomically writes `state` as pretty-printed JSON to `filePath`.
 * Writes to a `.tmp` sibling first, then renames — prevents partial reads.
 */
export function writeStateFile(filePath: string, state: object): void {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}
