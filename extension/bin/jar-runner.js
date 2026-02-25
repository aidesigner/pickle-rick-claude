#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot } from '../services/pickle-utils.js';
import { writeStateFile } from '../hooks/resolve-state.js';
async function runTask(sessionDir, repoCwd, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read state.json for ${path.basename(sessionDir)}: ${msg}`);
    }
    state.active = true;
    state.completion_promise = null;
    writeStateFile(statePath, state);
    const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
    let prompt = `You are Pickle Rick. Resume the session.\n\nRun:\nnode "$HOME/.claude/pickle-rick/extension/bin/setup.js" --resume ${sessionDir}\n\nThen continue the manager lifecycle from the current phase.`;
    try {
        if (fs.existsSync(picklePromptPath)) {
            prompt = fs.readFileSync(picklePromptPath, 'utf-8').replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);
        }
    }
    catch { /* use fallback */ }
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let managerMaxTurns = 50;
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (typeof settings.default_manager_max_turns === 'number' && settings.default_manager_max_turns > 0)
            managerMaxTurns = settings.default_manager_max_turns;
    }
    catch { /* ignore */ }
    printMinimalPanel(`Running Jarred Task`, {
        Session: path.basename(sessionDir),
        Repo: repoCwd,
        MaxTurns: managerMaxTurns,
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
        const proc = spawn('claude', cmdArgs, { cwd: repoCwd, env, stdio: 'inherit' });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', (err) => {
            console.error(`${Style.RED}Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}${Style.RESET}`);
            resolve(false);
        });
    });
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const JAR_ROOT = path.join(ROOT_DIR, 'jar');
    const SESSIONS_ROOT = path.join(ROOT_DIR, 'sessions');
    if (!fs.existsSync(JAR_ROOT)) {
        console.log('🥒 Pickle Jar is empty. No tasks to run.');
        console.log('Signal: Jar Complete');
        return;
    }
    const tasks = [];
    for (const day of fs.readdirSync(JAR_ROOT).sort()) {
        const dayPath = path.join(JAR_ROOT, day);
        let dayIsDir;
        try {
            dayIsDir = fs.statSync(dayPath).isDirectory();
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
    if (tasks.length === 0) {
        console.log('🥒 No marinating tasks in the Jar.');
        console.log('Signal: Jar Complete');
        return;
    }
    console.log(`\n🥒 Pickle Jar Night Shift — ${tasks.length} task(s) queued\n`);
    let succeeded = 0;
    let failed = 0;
    for (const { taskId, metaPath, meta } of tasks) {
        const sessionDir = path.join(SESSIONS_ROOT, taskId);
        if (!fs.existsSync(sessionDir)) {
            console.error(`${Style.RED}⚠️  Session dir not found for ${taskId}${Style.RESET}`);
            meta.status = 'failed';
            {
                const tmp = metaPath + `.tmp.${process.pid}`;
                fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
                fs.renameSync(tmp, metaPath);
            }
            failed++;
            continue;
        }
        if (!meta.repo_path || typeof meta.repo_path !== 'string') {
            console.error(`${Style.RED}⚠️  Skipping ${taskId}: meta.repo_path is missing or not a string${Style.RESET}`);
            meta.status = 'failed';
            {
                const tmp = metaPath + `.tmp.${process.pid}`;
                fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
                fs.renameSync(tmp, metaPath);
            }
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
                {
                    const tmp = metaPath + `.tmp.${process.pid}`;
                    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
                    fs.renameSync(tmp, metaPath);
                }
                failed++;
                continue;
            }
            try {
                const prdContent = fs.readFileSync(prdPath, 'utf-8');
                const currentHash = crypto.createHash('sha256').update(prdContent).digest('hex');
                if (currentHash !== meta.prd_hash) {
                    console.error(`${Style.RED}⚠️  Skipping ${taskId}: PRD integrity check failed (content modified since jarring)${Style.RESET}`);
                    meta.status = 'failed';
                    {
                        const tmp = metaPath + `.tmp.${process.pid}`;
                        fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
                        fs.renameSync(tmp, metaPath);
                    }
                    failed++;
                    continue;
                }
            }
            catch {
                console.error(`${Style.RED}⚠️  Skipping ${taskId}: cannot read jarred PRD for integrity check${Style.RESET}`);
                meta.status = 'failed';
                {
                    const tmp = metaPath + `.tmp.${process.pid}`;
                    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
                    fs.renameSync(tmp, metaPath);
                }
                failed++;
                continue;
            }
        }
        let ok;
        try {
            ok = await runTask(sessionDir, repoPath, ROOT_DIR);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`${Style.RED}⚠️  runTask error for ${taskId}: ${msg}${Style.RESET}`);
            ok = false;
        }
        meta.status = ok ? 'consumed' : 'failed';
        {
            const tmp = metaPath + `.tmp.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
            fs.renameSync(tmp, metaPath);
        }
        // Deactivate session after task completes (runTask sets active=true on start)
        try {
            const taskStatePath = path.join(sessionDir, 'state.json');
            const taskState = JSON.parse(fs.readFileSync(taskStatePath, 'utf-8'));
            taskState.active = false;
            writeStateFile(taskStatePath, taskState);
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
    if (process.platform === 'darwin') {
        spawnSync('osascript', ['-e', `display notification "${succeeded} succeeded, ${failed} failed" with title "🥒 Pickle Rick" subtitle "Jar complete"`]);
    }
    console.log('Signal: Jar Complete');
}
if (process.argv[1] && path.basename(process.argv[1]) === 'jar-runner.js') {
    main().catch((err) => {
        console.error(`${Style.RED}Error: ${err instanceof Error ? err.message : String(err)}${Style.RESET}`);
        process.exit(1);
    });
}
