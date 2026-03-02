#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getExtensionRoot, withSessionMapLock, writeStateFile } from '../services/pickle-utils.js';
export function cancelSession(cwd) {
    const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');
    if (!fs.existsSync(SESSIONS_MAP)) {
        console.log('No active sessions map found.');
        return;
    }
    let map;
    try {
        map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
    }
    catch {
        console.log('Sessions map is unreadable.');
        return;
    }
    const sessionPath = map[cwd];
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
            let state;
            try {
                state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            }
            catch {
                console.log('State file is unreadable.');
                return;
            }
            state.active = false;
            writeStateFile(statePath, state);
            cancelled = true;
            // Remove stale entry from the sessions map
            let freshMap = {};
            try {
                freshMap = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
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
    catch {
        // Fallback: deactivate state without lock if lock acquisition fails
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            state.active = false;
            writeStateFile(statePath, state);
            cancelled = true;
        }
        catch { /* session already deactivated or unreadable */ }
    }
    if (cancelled) {
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
