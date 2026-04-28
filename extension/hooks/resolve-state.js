import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionPath } from '../services/pickle-utils.js';
const ALLOW = JSON.stringify({ decision: 'approve' });
function sameWorkingDir(a, b) {
    return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}
function resolveStateFileFromSessionsDir(dataDir) {
    const sessionsDir = path.join(dataDir, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    }
    catch {
        return null;
    }
    for (const entry of entries) {
        const stateFile = path.join(sessionsDir, entry, 'state.json');
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (sameWorkingDir(state.working_dir, process.cwd()))
                return stateFile;
        }
        catch {
            /* unreadable state — keep scanning */
        }
    }
    return null;
}
/**
 * Resolves the state file path from env or the sessions map.
 * `dataDir` is where current_sessions.json lives (pickle data root, not the
 * extension install dir). Returns null if no active state file is found.
 */
export function resolveStateFile(dataDir) {
    let stateFile = process.env.PICKLE_STATE_FILE || null;
    if (!stateFile) {
        const sessionsMapPath = path.join(dataDir, 'current_sessions.json');
        if (fs.existsSync(sessionsMapPath)) {
            try {
                const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
                const sessionPath = resolveSessionPath(map[process.cwd()]);
                if (sessionPath)
                    stateFile = path.join(sessionPath, 'state.json');
            }
            catch {
                /* corrupt sessions map — fall through to state scan below */
            }
        }
    }
    if (!stateFile)
        stateFile = resolveStateFileFromSessionsDir(dataDir);
    if (!stateFile || !fs.existsSync(stateFile))
        return null;
    return stateFile;
}
/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile) {
    let state;
    try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    catch {
        return null;
    }
    if (state.working_dir != null && state.working_dir !== '' && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
        return null;
    }
    if (state.active !== true)
        return null;
    return state;
}
/** Prints the "approve" decision to stdout. */
export function approve() {
    console.log(ALLOW);
}
