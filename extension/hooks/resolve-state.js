import * as fs from 'fs';
import * as path from 'path';
const ALLOW = JSON.stringify({ decision: 'approve' });
/**
 * Resolves the state file path from env or the sessions map.
 * Returns null if no active state file is found.
 */
export function resolveStateFile(extensionDir) {
    let stateFile = process.env.PICKLE_STATE_FILE;
    if (!stateFile) {
        const sessionsMapPath = path.join(extensionDir, 'current_sessions.json');
        if (fs.existsSync(sessionsMapPath)) {
            try {
                const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
                const sessionPath = map[process.cwd()];
                if (sessionPath)
                    stateFile = path.join(sessionPath, 'state.json');
            }
            catch {
                /* corrupt sessions map — treat as no active session */
            }
        }
    }
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
