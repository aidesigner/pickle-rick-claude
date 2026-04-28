#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, writeStateFile, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
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
            // eslint-disable-next-line pickle/no-raw-state-write -- crash-path bypass: signal handler cannot await lock
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
        let result;
        try {
            result = await runTask(sessionDir, repoPath, ROOT_DIR);
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            console.error(`${Style.RED}⚠️  runTask error for ${taskId}: ${msg}${Style.RESET}`);
            result = { ok: false, backend: 'claude' };
        }
        // Deactivate session after task completes (runTask sets active=true on start).
        // Runs regardless of outcome so an ENOENT-skipped task doesn't leave
        // state.active=true orphaning future resumes.
        try {
            const taskStatePath = path.join(sessionDir, 'state.json');
            sm.update(taskStatePath, s => { s.active = false; });
        }
        catch { /* best-effort */ }
        if (result.enoent) {
            // Infrastructure error (CLI not installed). Leave meta.status as-is so
            // the task stays queued for a future jar-open run. Don't count it as
            // succeeded or failed — it never ran.
            console.log(`\n${Style.YELLOW}⏸️  Task ${taskId} skipped (backend ${result.backend} CLI missing) — status left as '${meta.status}' for future retry${Style.RESET}`);
            if (result.backend === 'codex') {
                // Every remaining task that declares codex will ENOENT identically.
                // Count them as skipped and short-circuit.
                const remaining = tasks.slice(tasks.findIndex(t => t.taskId === taskId) + 1);
                let skipped = 0;
                for (const { taskId: rid, meta: rmeta } of remaining) {
                    const rstate = readTaskState(path.join(SESSIONS_ROOT, rid));
                    const rbackend = resolveBackend(rstate);
                    if (rbackend === 'codex' && rmeta.status === 'marinating')
                        skipped++;
                }
                if (skipped > 0) {
                    console.log(`${Style.YELLOW}⏸️  ${skipped} additional codex task(s) remain queued — install codex CLI and re-run /pickle-jar-open${Style.RESET}`);
                    break;
                }
            }
            continue;
        }
        meta.status = result.ok ? 'consumed' : 'failed';
        writeStateFile(metaPath, meta);
        if (result.ok) {
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
