import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionPath } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
const ALLOW = JSON.stringify({ decision: 'approve' });
const sm = new StateManager();
function sameWorkingDir(a, b) {
    return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}
function readLookupState(stateFile) {
    try {
        const state = sm.read(stateFile);
        return { active: state.active, working_dir: state.working_dir };
    }
    catch {
        return null;
    }
}
function resolveMatchingStateFile(stateFile, cwd) {
    if (!fs.existsSync(stateFile))
        return null;
    const state = readLookupState(stateFile);
    if (!state || !sameWorkingDir(state.working_dir, cwd))
        return null;
    return { stateFile, active: state.active };
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
    let inactiveMatch = null;
    for (const entry of entries) {
        const stateFile = path.join(sessionsDir, entry, 'state.json');
        const state = readLookupState(stateFile);
        if (!state || !sameWorkingDir(state.working_dir, process.cwd()))
            continue;
        if (state.active === true)
            return stateFile;
        if (!inactiveMatch)
            inactiveMatch = stateFile;
    }
    return inactiveMatch;
}
/**
 * Resolves the state file path from env or the sessions map.
 * `dataDir` is where current_sessions.json lives (pickle data root, not the
 * extension install dir). Returns null if no matching state file is found.
 */
export function resolveStateFile(dataDir) {
    const cwd = process.cwd();
    let fallbackStateFile = null;
    const envStateFile = process.env.PICKLE_STATE_FILE;
    if (envStateFile) {
        const envMatch = resolveMatchingStateFile(envStateFile, cwd);
        if (envMatch) {
            if (envMatch.active === true)
                return envMatch.stateFile;
            fallbackStateFile = envMatch.stateFile;
        }
    }
    const sessionsMapPath = path.join(dataDir, 'current_sessions.json');
    if (fs.existsSync(sessionsMapPath)) {
        try {
            const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
            const sessionPath = resolveSessionPath(map[cwd]);
            if (sessionPath) {
                const mappedStateFile = path.join(sessionPath, 'state.json');
                const mappedMatch = resolveMatchingStateFile(mappedStateFile, cwd);
                if (mappedMatch) {
                    if (mappedMatch.active === true)
                        return mappedMatch.stateFile;
                    if (!fallbackStateFile)
                        fallbackStateFile = mappedMatch.stateFile;
                }
            }
        }
        catch {
            /* corrupt sessions map — fall through to state scan below */
        }
    }
    const scannedStateFile = resolveStateFileFromSessionsDir(dataDir);
    if (scannedStateFile)
        return scannedStateFile;
    return fallbackStateFile;
}
/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile) {
    try {
        const state = sm.read(stateFile);
        if (state.working_dir != null && state.working_dir !== '' && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
            return null;
        }
        if (state.active !== true)
            return null;
        return state;
    }
    catch {
        return null;
    }
}
/** Prints the "approve" decision to stdout. */
export function approve() {
    console.log(ALLOW);
}
