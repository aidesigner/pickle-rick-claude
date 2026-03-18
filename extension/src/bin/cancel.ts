#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getExtensionRoot, withSessionMapLock, resolveSessionPath, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { LockError } from '../types/index.js';

const sm = new StateManager();

export function cancelSession(cwd: string) {
  const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');

  if (!fs.existsSync(SESSIONS_MAP)) {
    console.log('No active sessions map found.');
    return;
  }

  let map: Record<string, unknown>;
  try {
    map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
  } catch {
    console.log('Sessions map is unreadable.');
    return;
  }
  const sessionPath = resolveSessionPath(map[cwd]);

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.log('No active session found for this directory.');
    return;
  }

  const statePath = path.join(sessionPath, 'state.json');
  if (!fs.existsSync(statePath)) {
    console.log('State file not found.');
    return;
  }

  // Deactivate state AND remove map entry inside one lock to prevent inconsistent state
  // if the process crashes between the two operations.
  let cancelled = false;
  try {
    withSessionMapLock(SESSIONS_MAP + '.lock', () => {
      // Deactivate state.json
      try {
        sm.update(statePath, s => { s.active = false; });
      } catch {
        console.log('State file is unreadable.');
        return;
      }
      cancelled = true;

      // Remove stale entry from the sessions map
      let freshMap: Record<string, unknown> = {};
      try {
        freshMap = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
      } catch { /* ignore */ }
      delete freshMap[cwd];
      const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpMap, JSON.stringify(freshMap, null, 2));
        fs.renameSync(tmpMap, SESSIONS_MAP);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpMap); } catch { /* ignore cleanup failure */ }
        throw writeErr;
      }
    });
  } catch (err) {
    if (err instanceof LockError) {
      // Lock exhausted — deactivate state without map consistency guarantee
      console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
      try {
        sm.update(statePath, s => { s.active = false; });
        cancelled = true;
      } catch { /* session already deactivated or unreadable */ }
    } else {
      throw err;
    }
  }

  if (cancelled) {
    printMinimalPanel(
      'Loop Cancelled',
      {
        Session: path.basename(sessionPath),
        Status: 'Inactive',
      },
      'RED',
      '🛑'
    );
  } else {
    console.log('Failed to cancel session — state file unreadable.');
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
  cancelSession(process.cwd());
}
