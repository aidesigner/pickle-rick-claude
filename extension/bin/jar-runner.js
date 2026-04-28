#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, writeStateFile, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager, safeDeactivate } from '../services/state-manager.js';
import { Defaults } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { buildManagerInvocation, resolveBackend, backendEnvOverrides } from '../services/backend-spawn.js';
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
/**
 * Best-effort synchronous load of a task's state.json for peek-ahead lookups
 * (e.g. "what backend would the next queued task use?"). Returns null if the
 * file is missing or unreadable; callers fall through to resolveBackend's
 * standard fallback chain.
 */
function readTaskState(sessionDir) {
    try {
        return sm.read(path.join(sessionDir, 'state.json'));
    }
    catch {
        return null;
    }
}
async function runTask(sessionDir, repoCwd, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = sm.read(statePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        throw new Error(`Failed to read state.json for ${path.basename(sessionDir)}: ${msg}`);
    }
    state = sm.update(statePath, s => {
        s.active = true;
        s.pid = process.pid;
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
    // Resolve the backend from THIS task's session state — jar batches are
    // heterogeneous: each task carries its own backend (claude or codex) stored
    // at jar-time. Resolving from the already-parsed state object avoids a second
    // disk read + JSON.parse of the same file (the separate read could race a
    // concurrent rewrite and silently default to 'claude' on parse failure, even
    // when the first parse above succeeded).
    const backend = resolveBackend(state);
    printMinimalPanel(`Running Jarred Task`, {
        Session: path.basename(sessionDir),
        Repo: repoCwd,
        Backend: backend,
        MaxTurns: managerMaxTurns,
        Timeout: `${taskTimeout}s`,
    }, 'MAGENTA', '🥒');
    const invocation = buildManagerInvocation(backend, {
        prompt,
        addDirs: [extensionRoot, getDataRoot(), sessionDir],
        maxTurns: managerMaxTurns,
        noSessionPersistence: true,
    });
    const env = {
        ...process.env,
        ...backendEnvOverrides(backend),
        PICKLE_STATE_FILE: statePath,
        PYTHONUNBUFFERED: '1',
    };
    delete env['CLAUDECODE'];
    delete env['PICKLE_ROLE'];
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(invocation.cmd, invocation.args, { cwd: repoCwd, env, stdio: 'inherit' });
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
            resolve({ ok: false, backend });
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
            resolve({ ok: code === 0, backend });
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
            const errCode = err?.code;
            if (errCode === 'ENOENT') {
                // Infrastructure error — the backend CLI is not installed. Do NOT
                // permanently fail the task: leave its status untouched so a future
                // jar-open run succeeds once the CLI is installed. Print a clear
                // install hint routed to the backend that was attempted.
                const hint = backend === 'codex'
                    ? `codex CLI not found on PATH — install codex and re-run /pickle-jar-open, or re-jar these tasks with --backend claude`
                    : `claude CLI not found on PATH — install claude and re-run /pickle-jar-open`;
                console.error(`${Style.RED}${hint}${Style.RESET}`);
                resolve({ ok: false, enoent: true, backend });
                return;
            }
            console.error(`${Style.RED}Failed to spawn '${invocation.cmd}' (backend=${backend}): ${safeErrorMessage(err)}${Style.RESET}`);
            resolve({ ok: false, backend });
        });
    });
}
export function discoverMarinatingTasks(jarRoot) {
    const tasks = [];
    for (const day of fs.readdirSync(jarRoot).sort()) {
        const dayPath = path.join(jarRoot, day);
        let dayIsDir;
        try {
            dayIsDir = fs.lstatSync(dayPath).isDirectory();
        }
        catch {
            continue;
        }
        if (!dayIsDir)
            continue;
        for (const taskId of fs.readdirSync(dayPath).sort()) {
            const metaPath = path.join(dayPath, taskId, 'meta.json');
            if (!fs.existsSync(metaPath))
                continue;
            let meta;
            try {
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
    return tasks;
}
function markTaskFailed(task, message) {
    console.error(message);
    task.meta.status = 'failed';
    writeStateFile(task.metaPath, task.meta);
}
function verifyJarredPrd(task) {
    if (typeof task.meta.prd_hash !== 'string' || task.meta.prd_hash.length === 0) {
        return true;
    }
    const taskDir = path.dirname(task.metaPath);
    const rawPrdRel = typeof task.meta.prd_path === 'string' ? task.meta.prd_path : 'prd.md';
    const prdPath = path.resolve(taskDir, rawPrdRel);
    if (!prdPath.startsWith(taskDir + path.sep) && prdPath !== taskDir) {
        markTaskFailed(task, `${Style.RED}⚠️  Skipping ${task.taskId}: prd_path escapes task directory${Style.RESET}`);
        return false;
    }
    try {
        const prdContent = fs.readFileSync(prdPath, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(prdContent).digest('hex');
        if (currentHash === task.meta.prd_hash)
            return true;
    }
    catch {
        markTaskFailed(task, `${Style.RED}⚠️  Skipping ${task.taskId}: cannot read jarred PRD for integrity check${Style.RESET}`);
        return false;
    }
    markTaskFailed(task, `${Style.RED}⚠️  Skipping ${task.taskId}: PRD integrity check failed (content modified since jarring)${Style.RESET}`);
    return false;
}
function resolveTaskExecution(task, sessionsRoot) {
    const sessionDir = path.join(sessionsRoot, task.taskId);
    if (!fs.existsSync(sessionDir)) {
        markTaskFailed(task, `${Style.RED}⚠️  Session dir not found for ${task.taskId}${Style.RESET}`);
        return null;
    }
    if (typeof task.meta.repo_path !== 'string') {
        markTaskFailed(task, `${Style.RED}⚠️  Skipping ${task.taskId}: meta.repo_path is missing or not a string${Style.RESET}`);
        return null;
    }
    if (!verifyJarredPrd(task)) {
        return null;
    }
    return { sessionDir, repoPath: task.meta.repo_path };
}
function deactivateTaskSession(sessionDir) {
    try {
        const taskStatePath = path.join(sessionDir, 'state.json');
        sm.update(taskStatePath, s => { s.active = false; });
    }
    catch { /* best-effort */ }
}
function countRemainingQueuedBackendTasks(tasks, currentIndex, sessionsRoot, backend) {
    let count = 0;
    for (const task of tasks.slice(currentIndex + 1)) {
        if (task.meta.status !== 'marinating')
            continue;
        const taskState = readTaskState(path.join(sessionsRoot, task.taskId));
        if (resolveBackend(taskState) === backend)
            count++;
    }
    return count;
}
function installShutdownHandlers() {
    const handleShutdownSignal = (signal) => {
        console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — deactivating current task session${Style.RESET}`);
        if (activeTaskSessionDir) {
            safeDeactivate(path.join(activeTaskSessionDir, 'state.json'));
        }
        if (activeTaskProc && !activeTaskProc.killed) {
            activeTaskProc.kill('SIGTERM');
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}
async function processJarTask(task, currentIndex, tasks, sessionsRoot, extensionRoot) {
    const execution = resolveTaskExecution(task, sessionsRoot);
    if (!execution) {
        return { succeededDelta: 0, failedDelta: 1, stop: false };
    }
    let result;
    try {
        result = await runTask(execution.sessionDir, execution.repoPath, extensionRoot);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}⚠️  runTask error for ${task.taskId}: ${msg}${Style.RESET}`);
        result = { ok: false, backend: 'claude' };
    }
    deactivateTaskSession(execution.sessionDir);
    if (result.enoent) {
        console.log(`\n${Style.YELLOW}⏸️  Task ${task.taskId} skipped (backend ${result.backend} CLI missing) — status left as '${task.meta.status}' for future retry${Style.RESET}`);
        if (result.backend === 'codex') {
            const skipped = countRemainingQueuedBackendTasks(tasks, currentIndex, sessionsRoot, result.backend);
            if (skipped > 0) {
                console.log(`${Style.YELLOW}⏸️  ${skipped} additional codex task(s) remain queued — install codex CLI and re-run /pickle-jar-open${Style.RESET}`);
                return { succeededDelta: 0, failedDelta: 0, stop: true };
            }
        }
        return { succeededDelta: 0, failedDelta: 0, stop: false };
    }
    task.meta.status = result.ok ? 'consumed' : 'failed';
    writeStateFile(task.metaPath, task.meta);
    if (result.ok) {
        console.log(`\n${Style.GREEN}✅ Task ${task.taskId} complete${Style.RESET}`);
        return { succeededDelta: 1, failedDelta: 0, stop: false };
    }
    console.log(`\n${Style.RED}❌ Task ${task.taskId} failed${Style.RESET}`);
    return { succeededDelta: 0, failedDelta: 1, stop: false };
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const DATA_DIR = getDataRoot();
    const JAR_ROOT = path.join(DATA_DIR, 'jar');
    const SESSIONS_ROOT = path.join(DATA_DIR, 'sessions');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(JAR_ROOT)) {
        console.log('🥒 Pickle Jar is empty. No tasks to run.');
        console.log('Signal: Jar Complete');
        return;
    }
    const tasks = discoverMarinatingTasks(JAR_ROOT);
    if (tasks.length === 0) {
        console.log('🥒 No marinating tasks in the Jar.');
        console.log('Signal: Jar Complete');
        return;
    }
    installShutdownHandlers();
    console.log(`\n🥒 Pickle Jar Night Shift — ${tasks.length} task(s) queued\n`);
    logActivity({ event: 'jar_start', source: 'pickle' });
    let succeeded = 0;
    let failed = 0;
    for (const [index, task] of tasks.entries()) {
        const outcome = await processJarTask(task, index, tasks, SESSIONS_ROOT, ROOT_DIR);
        succeeded += outcome.succeededDelta;
        failed += outcome.failedDelta;
        if (outcome.stop)
            break;
    }
    console.log(`\n🥒 Jar complete. ${succeeded} succeeded, ${failed} failed.`);
    logActivity({ event: 'jar_end', source: 'pickle' });
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
if (process.argv[1] && path.basename(process.argv[1]) === 'jar-runner.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}Error: ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
