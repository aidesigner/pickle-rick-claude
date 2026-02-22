import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const ALLOW = JSON.stringify({ decision: 'approve' });
export function getExtensionDir() {
    return process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
}
/**
 * Resolves the state file path from env or the sessions map.
 * Returns null if no active state file is found.
 */
export function resolveStateFile(extensionDir) {
    let stateFile = process.env.PICKLE_STATE_FILE;
    if (!stateFile) {
        const sessionsMapPath = path.join(extensionDir, 'current_sessions.json');
        if (fs.existsSync(sessionsMapPath)) {
            const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
            const sessionPath = map[process.cwd()];
            if (sessionPath)
                stateFile = path.join(sessionPath, 'state.json');
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
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
        return null;
    }
    if (!state.active)
        return null;
    return state;
}
/** Prints the "allow" decision to stdout. */
export function allow() {
    console.log(ALLOW);
}
