#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, withSessionMapLock, pruneOldSessions, safeErrorMessage, resolveSessionPath } from '../services/pickle-utils.js';
import { Defaults, LockError } from '../types/index.js';
import { StateManager } from '../services/state-manager.js';
import { logActivity, pruneActivity } from '../services/activity-logger.js';
const sm = new StateManager();
function die(message) {
    console.error(`${Style.RED}❌ Error: ${message}${Style.RESET}`);
    process.exit(1);
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const DATA_DIR = getDataRoot();
    const SESSIONS_ROOT = path.join(DATA_DIR, 'sessions');
    const JAR_ROOT = path.join(DATA_DIR, 'jar');
    const WORKTREES_ROOT = path.join(DATA_DIR, 'worktrees');
    const SESSIONS_MAP = path.join(DATA_DIR, 'current_sessions.json');
    const updateSessionMap = (cwd, sessionPath) => {
        withSessionMapLock(SESSIONS_MAP + '.lock', () => {
            let map = {};
            if (fs.existsSync(SESSIONS_MAP)) {
                try {
                    map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
                }
                catch {
                    /* ignore */
                }
            }
            map[cwd] = { sessionPath, pid: process.pid };
            const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}.${Date.now()}`;
            try {
                fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
                fs.renameSync(tmpMap, SESSIONS_MAP);
            }
            catch (err) {
                try {
                    fs.unlinkSync(tmpMap);
                }
                catch { /* cleanup best-effort */ }
                throw err;
            }
        });
    };
    // Ensure core directories exist
    [SESSIONS_ROOT, JAR_ROOT, WORKTREES_ROOT].forEach((dir) => {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    });
    // Silently prune sessions older than 7 days that are no longer active
    pruneOldSessions(SESSIONS_ROOT);
    // Defaults
    let loopLimit = 100;
    let timeLimit = 720;
    let workerTimeout = Defaults.WORKER_TIMEOUT_SECONDS;
    let promiseToken = null;
    let resumeMode = false;
    let resumePath = null;
    let resetMode = false;
    let pausedMode = false;
    let tmuxMode = false;
    let minIterations = 0;
    let commandTemplate = undefined;
    let chainMeeseeks = false;
    const taskArgs = [];
    const explicitFlags = new Set();
    const startEpoch = Math.floor(Date.now() / 1000);
    // Load Settings
    const settingsFile = path.join(ROOT_DIR, 'pickle_settings.json');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (fs.existsSync(settingsFile)) {
        try {
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
            if (typeof settings.default_max_iterations === 'number' && settings.default_max_iterations > 0)
                loopLimit = settings.default_max_iterations;
            if (typeof settings.default_max_time_minutes === 'number' && settings.default_max_time_minutes > 0)
                timeLimit = settings.default_max_time_minutes;
            if (typeof settings.default_worker_timeout_seconds === 'number' && settings.default_worker_timeout_seconds > 0)
                workerTimeout = settings.default_worker_timeout_seconds;
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            console.error(`Warning: could not parse pickle_settings.json — using defaults: ${msg}`);
        }
    }
    // Argument Parser
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--max-iterations') {
            const v = parseInt(args[++i], 10);
            if (isNaN(v) || v < 0)
                die(`--max-iterations requires a non-negative integer`);
            loopLimit = v;
            explicitFlags.add('max-iterations');
        }
        else if (arg === '--max-time') {
            const v = parseInt(args[++i], 10);
            if (isNaN(v) || v < 0)
                die(`--max-time requires a non-negative integer`);
            timeLimit = v;
            explicitFlags.add('max-time');
        }
        else if (arg === '--worker-timeout') {
            const v = parseInt(args[++i], 10);
            if (isNaN(v) || v <= 0)
                die(`--worker-timeout requires a positive integer`);
            workerTimeout = v;
            explicitFlags.add('worker-timeout');
        }
        else if (arg === '--completion-promise') {
            const v = args[++i];
            if (!v || v.startsWith('--'))
                die(`--completion-promise requires a non-empty value`);
            promiseToken = v;
        }
        else if (arg === '--resume') {
            resumeMode = true;
            if (args[i + 1] && !args[i + 1].startsWith('--')) {
                resumePath = args[++i];
            }
        }
        else if (arg === '--reset') {
            resetMode = true;
        }
        else if (arg === '--paused') {
            pausedMode = true;
        }
        else if (arg === '--tmux') {
            tmuxMode = true;
        }
        else if (arg === '--task') {
            if (i + 1 < args.length)
                taskArgs.push(args[++i]);
        }
        else if (arg === '--min-iterations') {
            const v = parseInt(args[++i], 10);
            if (isNaN(v) || v < 0)
                die('--min-iterations requires a non-negative integer');
            minIterations = v;
            explicitFlags.add('min-iterations');
        }
        else if (arg === '--command-template') {
            const v = args[++i];
            if (!v || v.startsWith('--'))
                die('--command-template requires a non-empty value');
            if (v.includes('/') || v.includes('\\') || v.includes('..'))
                die('--command-template must be a plain filename');
            commandTemplate = v;
            explicitFlags.add('command-template');
        }
        else if (arg === '--chain-meeseeks') {
            chainMeeseeks = true;
        }
        else if (arg === '-s' || arg === '--session-id') {
            // Ignore legacy session-id flag; consume the next arg if it's not a flag
            if (args[i + 1] && !args[i + 1].startsWith('--')) {
                i++;
            }
        }
        else {
            taskArgs.push(arg);
        }
    }
    let taskStr = taskArgs.join(' ').trim();
    let fullSessionPath = '';
    let currentIteration = 1;
    if (resumeMode) {
        if (resumePath) {
            fullSessionPath = resolvePath(resumePath);
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        }
        else if (fs.existsSync(SESSIONS_MAP)) {
            try {
                // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                const map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
                fullSessionPath = resolveSessionPath(map[process.cwd()]);
            }
            catch {
                /* corrupt map — no session path */
            }
        }
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        if (!fullSessionPath || !fs.existsSync(fullSessionPath)) {
            die(`No active session found or path invalid: ${fullSessionPath}`);
        }
        const statePath = path.join(fullSessionPath, 'state.json');
        let state;
        try {
            state = sm.update(statePath, s => {
                s.active = !pausedMode;
                if (resetMode) {
                    s.iteration = 0;
                    s.start_time_epoch = startEpoch;
                }
                // Only override limits that were explicitly passed on the command line;
                // otherwise preserve the values from the stored session state.
                if (explicitFlags.has('max-iterations'))
                    s.max_iterations = loopLimit;
                if (explicitFlags.has('max-time'))
                    s.max_time_minutes = timeLimit;
                if (explicitFlags.has('worker-timeout'))
                    s.worker_timeout_seconds = workerTimeout;
                if (promiseToken)
                    s.completion_promise = promiseToken;
                if (explicitFlags.has('min-iterations'))
                    s.min_iterations = minIterations;
                if (explicitFlags.has('command-template'))
                    s.command_template = commandTemplate;
                // Propagate tmux mode on resume — needed when transitioning a paused/non-tmux
                // session into tmux mode (e.g. /pickle-refine-prd --run).
                if (tmuxMode)
                    s.tmux_mode = true;
                if (chainMeeseeks)
                    s.chain_meeseeks = true;
            });
        }
        catch {
            die(`state.json is missing or corrupt in ${fullSessionPath}`);
        }
        // Sync local vars with (potentially preserved) state for display — coerce
        // to Number to guard against string-typed values from external edits / old state.
        // Use Number.isFinite so that 0 (meaning infinite) is preserved rather than
        // falling back to the settings default via `|| loopLimit`.
        const rawLoopLimit = Number(state.max_iterations);
        loopLimit = Number.isFinite(rawLoopLimit) ? rawLoopLimit : loopLimit;
        const rawTimeLimit = Number(state.max_time_minutes);
        timeLimit = Number.isFinite(rawTimeLimit) ? rawTimeLimit : timeLimit;
        const rawWorkerTimeout = Number(state.worker_timeout_seconds);
        workerTimeout = Number.isFinite(rawWorkerTimeout) && rawWorkerTimeout > 0 ? rawWorkerTimeout : workerTimeout;
        const rawMinIter = Number(state.min_iterations);
        minIterations = Number.isFinite(rawMinIter) ? rawMinIter : 0;
        commandTemplate = state.command_template;
        chainMeeseeks = state.chain_meeseeks === true;
        currentIteration = (Number(state.iteration) || 0) + 1;
        promiseToken = state.completion_promise;
        // Only overwrite the validated fullSessionPath if the stored path exists on disk
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        if (state.session_dir && fs.existsSync(state.session_dir)) {
            fullSessionPath = state.session_dir;
        }
    }
    else {
        if (!taskStr && !pausedMode)
            die('No task specified. Run /pickle --help for usage.');
        if (!taskStr)
            taskStr = 'PRD Interview (task to be determined via interview)';
        const today = new Date().toISOString().split('T')[0];
        const hash = crypto.randomBytes(4).toString('hex');
        const sessionId = `${today}-${hash}`;
        fullSessionPath = path.join(SESSIONS_ROOT, sessionId);
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        if (!fs.existsSync(fullSessionPath))
            fs.mkdirSync(fullSessionPath, { recursive: true });
        const state = {
            // tmux mode: start inactive so the main Claude window's stop hook never fires.
            // tmux-runner.ts takes ownership by setting active: true before its loop begins.
            active: !pausedMode && !tmuxMode,
            working_dir: process.cwd(),
            step: 'prd',
            iteration: 0,
            max_iterations: loopLimit,
            max_time_minutes: timeLimit,
            worker_timeout_seconds: workerTimeout,
            start_time_epoch: startEpoch,
            completion_promise: promiseToken,
            original_prompt: taskStr,
            current_ticket: null,
            history: [],
            started_at: new Date().toISOString(),
            session_dir: fullSessionPath,
            tmux_mode: tmuxMode,
            min_iterations: minIterations,
            command_template: commandTemplate,
            chain_meeseeks: chainMeeseeks,
        };
        // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
        sm.forceWrite(path.join(fullSessionPath, 'state.json'), state);
        try {
            pruneActivity();
        }
        catch { /* must not block session start */ }
        logActivity({ event: 'session_start', source: 'pickle', session: sessionId, mode: tmuxMode ? 'tmux' : 'inline', original_prompt: taskStr });
    }
    try {
        updateSessionMap(process.cwd(), fullSessionPath);
    }
    catch (err) {
        if (err instanceof LockError) {
            console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
        }
        else {
            throw err;
        }
    }
    printMinimalPanel('Pickle Rick Activated!', {
        Iteration: currentIteration,
        Limit: loopLimit > 0 ? loopLimit : '∞',
        'Max Time': timeLimit > 0 ? `${timeLimit}m` : '∞',
        'Worker TO': `${workerTimeout}s`,
        Promise: promiseToken || 'None',
        ...(minIterations > 0 ? { 'Min Passes': minIterations } : {}),
        ...(commandTemplate ? { Template: commandTemplate } : {}),
        ...(chainMeeseeks ? { 'Chain Meeseeks': 'Yes' } : {}),
        Extension: ROOT_DIR,
        Data: DATA_DIR,
        Path: fullSessionPath,
    }, 'GREEN', '🥒');
    // Machine-readable line for reliable parsing even when ANSI codes are present
    process.stdout.write(`SESSION_ROOT=${fullSessionPath}\n`);
    if (promiseToken) {
        console.log(`
${Style.YELLOW}⚠️  STRICT EXIT CONDITION ACTIVE${Style.RESET}`);
        console.log(`   You must output: <promise>${promiseToken}</promise>
`);
    }
}
function resolvePath(p) {
    if (p.startsWith('~'))
        return path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'setup.js') {
    main().catch((err) => die(safeErrorMessage(err)));
}
