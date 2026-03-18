#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot, writeStateFile, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { Defaults } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
const sm = new StateManager();
// Tracks the currently-running task's session dir and subprocess so signal
// handlers can deactivate it and kill the child on shutdown.
let activeTaskSessionDir = null;
let activeTaskProc = null;
export function loadJarTaskTimeout(extensionRoot, state) {
    // Use worker_timeout_seconds from state if set, else fall back to settings, else default
    const stateTimeout = Number(state.worker_timeout_seconds);
    if (Number.isFinite(stateTimeout) && stateTimeout > 0)
        return stateTimeout;
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'pickle_settings.json'), 'utf-8'));
        const rawTimeout = Number(settings.default_worker_timeout_seconds);
        if (Number.isFinite(rawTimeout) && rawTimeout > 0)
            return rawTimeout;
    }
    catch { /* use default */ }
    return Defaults.WORKER_TIMEOUT_SECONDS;
}
async function runTask(sessionDir, repoCwd, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        throw new Error(`Failed to read state.json for ${path.basename(sessionDir)}: ${msg}`);
    }
    state = sm.update(statePath, s => {
        s.active = true;
        s.completion_promise = null;
    });
    activeTaskSessionDir = sessionDir;
    const taskTimeout = loadJarTaskTimeout(extensionRoot, state);
    const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
    let prompt = `You are Pickle Rick. Resume the session.\n\nRun:\nnode "${extensionRoot}/extension/bin/setup.js" --resume ${sessionDir}\n\nThen continue the manager lifecycle from the current phase.`;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        if (fs.existsSync(picklePromptPath)) {
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            prompt = fs.readFileSync(picklePromptPath, 'utf-8').replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);
        }
    }
    catch { /* use fallback */ }
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let managerMaxTurns = Defaults.MANAGER_MAX_TURNS;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (typeof settings.default_manager_max_turns === 'number' && settings.default_manager_max_turns > 0)
            managerMaxTurns = settings.default_manager_max_turns;
    }
    catch { /* ignore */ }
    printMinimalPanel(`Running Jarred Task`, {
        Session: path.basename(sessionDir),
        Repo: repoCwd,
        MaxTurns: managerMaxTurns,
        Timeout: `${taskTimeout}s`,
    }, 'MAGENTA', '🥒');
    const cmdArgs = [
        '--dangerously-skip-permissions',
        '--add-dir', extensionRoot,
        '--add-dir', sessionDir,
        '--no-session-persistence',
        '--max-turns', String(managerMaxTurns),
        '-p', prompt,
    ];
    const env = { ...process.env, PICKLE_STATE_FILE: statePath, PYTHONUNBUFFERED: '1' };
    delete env['CLAUDECODE'];
    delete env['PICKLE_ROLE'];
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn('claude', cmdArgs, { cwd: repoCwd, env, stdio: 'inherit' });
        activeTaskProc = proc;
        // Per-task timeout: SIGTERM first, escalate to SIGKILL after 2s
        let killEscalation = null;
        const timeoutHandle = setTimeout(() => {
            console.error(`\n${Style.YELLOW}⚠️  Jar task timed out after ${taskTimeout}s — killing${Style.RESET}`);
            try {
                proc.kill('SIGTERM');
            }
            catch { /* already dead */ }
            killEscalation = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                }
                catch { /* already dead */ }
            }, 2000);
        }, taskTimeout * 1000);
        // Hang guard: force-resolve if process doesn't exit within timeout + 30s
        const hangGuard = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            activeTaskSessionDir = null;
            activeTaskProc = null;
            console.error(`${Style.RED}❌ Jar task hang detected — forcing failure${Style.RESET}`);
            resolve(false);
        }, (taskTimeout + 30) * 1000);
        hangGuard.unref();
        proc.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            activeTaskSessionDir = null;
            activeTaskProc = null;
            resolve(code === 0);
        });
        proc.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            activeTaskSessionDir = null;
            activeTaskProc = null;
            console.error(`${Style.RED}Failed to spawn claude: ${safeErrorMessage(err)}${Style.RESET}`);
            resolve(false);
        });
    });
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const JAR_ROOT = path.join(ROOT_DIR, 'jar');
    const SESSIONS_ROOT = path.join(ROOT_DIR, 'sessions');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(JAR_ROOT)) {
        console.log('🥒 Pickle Jar is empty. No tasks to run.');
        console.log('Signal: Jar Complete');
        return;
    }
    const tasks = [];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    for (const day of fs.readdirSync(JAR_ROOT).sort()) {
        const dayPath = path.join(JAR_ROOT, day);
        let dayIsDir;
        try {
            dayIsDir = fs.lstatSync(dayPath).isDirectory();
        }
        catch {
            continue;
        }
        if (!dayIsDir)
            continue;
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        for (const taskId of fs.readdirSync(dayPath).sort()) {
            const metaPath = path.join(dayPath, taskId, 'meta.json');
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            if (!fs.existsSync(metaPath))
                continue;
            let meta;
            try {
                // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            }
            catch {
                console.error(`${Style.RED}⚠️  Skipping ${taskId}: meta.json is corrupt or unreadable${Style.RESET}`);
                continue;
            }
            if (meta.status === 'marinating')
                tasks.push({ taskId, metaPath, meta });
        }
    }
    if (tasks.length === 0) {
        console.log('🥒 No marinating tasks in the Jar.');
        console.log('Signal: Jar Complete');
        return;
    }
    // Graceful shutdown: deactivate the current task's session on SIGTERM/SIGINT
    // so it doesn't remain orphaned with active: true when the process is killed.
    const handleShutdownSignal = (signal) => {
        console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — deactivating current task session${Style.RESET}`);
        if (activeTaskSessionDir) {
            sm.forceWrite(path.join(activeTaskSessionDir, 'state.json'), (() => {
                try {
                    const s = JSON.parse(fs.readFileSync(path.join(activeTaskSessionDir, 'state.json'), 'utf-8'));
                    s.active = false;
                    return s;
                }
                catch {
                    return { active: false };
                }
            })());
        }
        if (activeTaskProc && !activeTaskProc.killed) {
            activeTaskProc.kill('SIGTERM');
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
    console.log(`\n🥒 Pickle Jar Night Shift — ${tasks.length} task(s) queued\n`);
    logActivity({ event: 'jar_start', source: 'pickle' });
    let succeeded = 0;
    let failed = 0;
    for (const { taskId, metaPath, meta } of tasks) {
        const sessionDir = path.join(SESSIONS_ROOT, taskId);
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        if (!fs.existsSync(sessionDir)) {
            console.error(`${Style.RED}⚠️  Session dir not found for ${taskId}${Style.RESET}`);
            meta.status = 'failed';
            writeStateFile(metaPath, meta);
            failed++;
            continue;
        }
        if (!meta.repo_path || typeof meta.repo_path !== 'string') {
            console.error(`${Style.RED}⚠️  Skipping ${taskId}: meta.repo_path is missing or not a string${Style.RESET}`);
            meta.status = 'failed';
            writeStateFile(metaPath, meta);
            failed++;
            continue;
        }
        const repoPath = meta.repo_path;
        // Integrity check: verify PRD content hasn't been tampered with since jarring
        if (typeof meta.prd_hash === 'string' && meta.prd_hash.length > 0) {
            const taskDir = path.dirname(metaPath);
            const rawPrdRel = typeof meta.prd_path === 'string' ? meta.prd_path : 'prd.md';
            const prdPath = path.resolve(taskDir, rawPrdRel);
            // Prevent path traversal — resolved prd_path must stay within the task directory
            if (!prdPath.startsWith(taskDir + path.sep) && prdPath !== taskDir) {
                console.error(`${Style.RED}⚠️  Skipping ${taskId}: prd_path escapes task directory${Style.RESET}`);
                meta.status = 'failed';
                writeStateFile(metaPath, meta);
                failed++;
                continue;
            }
            try {
                // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
                const prdContent = fs.readFileSync(prdPath, 'utf-8');
                const currentHash = crypto.createHash('sha256').update(prdContent).digest('hex');
                if (currentHash !== meta.prd_hash) {
                    console.error(`${Style.RED}⚠️  Skipping ${taskId}: PRD integrity check failed (content modified since jarring)${Style.RESET}`);
                    meta.status = 'failed';
                    writeStateFile(metaPath, meta);
                    failed++;
                    continue;
                }
            }
            catch {
                console.error(`${Style.RED}⚠️  Skipping ${taskId}: cannot read jarred PRD for integrity check${Style.RESET}`);
                meta.status = 'failed';
                writeStateFile(metaPath, meta);
                failed++;
                continue;
            }
        }
        let ok;
        try {
            ok = await runTask(sessionDir, repoPath, ROOT_DIR);
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            console.error(`${Style.RED}⚠️  runTask error for ${taskId}: ${msg}${Style.RESET}`);
            ok = false;
        }
        meta.status = ok ? 'consumed' : 'failed';
        writeStateFile(metaPath, meta);
        // Deactivate session after task completes (runTask sets active=true on start)
        try {
            const taskStatePath = path.join(sessionDir, 'state.json');
            sm.update(taskStatePath, s => { s.active = false; });
        }
        catch { /* best-effort */ }
        if (ok) {
            succeeded++;
            console.log(`\n${Style.GREEN}✅ Task ${taskId} complete${Style.RESET}`);
        }
        else {
            failed++;
            console.log(`\n${Style.RED}❌ Task ${taskId} failed${Style.RESET}`);
        }
    }
    console.log(`\n🥒 Jar complete. ${succeeded} succeeded, ${failed} failed.`);
    logActivity({ event: 'jar_end', source: 'pickle' });
    sendJarNotification(succeeded, failed);
    console.log('Signal: Jar Complete');
}
export function buildJarNotification(succeeded, failed) {
    const allFailed = succeeded === 0 && failed > 0;
    const title = allFailed ? '🥒 Pickle Jar Failed' : '🥒 Pickle Run Complete';
    const subtitle = 'Pickle Jar';
    const body = failed > 0
        ? `${succeeded} succeeded, ${failed} failed`
        : `${succeeded} task${succeeded === 1 ? '' : 's'} completed`;
    return { title, subtitle, body };
}
function sendJarNotification(succeeded, failed) {
    if (process.platform !== 'darwin')
        return;
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const { title, subtitle, body } = buildJarNotification(succeeded, failed);
    spawnSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`]);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'jar-runner.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}Error: ${msg}${Style.RESET}`);
        if (process.platform === 'darwin') {
            const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            spawnSync('osascript', ['-e', `display notification "${esc(msg.slice(0, 100))}" with title "🥒 Pickle Jar Failed" subtitle "Crash"`]);
        }
        process.exit(1);
    });
}
