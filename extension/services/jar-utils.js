import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { runCmd, Style, getExtensionRoot, writeStateFile } from './pickle-utils.js';
function getBranch(repoPath) {
    try {
        return runCmd(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    }
    catch {
        return 'unknown';
    }
}
export function addToJar(sessionDir) {
    // 1. Read state.json
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) {
        throw new Error(`state.json not found in ${sessionDir}`);
    }
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch {
        throw new Error(`state.json is corrupt or unreadable in ${sessionDir}`);
    }
    const repoPath = state.working_dir;
    if (!repoPath) {
        throw new Error('working_dir not found in state.json');
    }
    const branch = getBranch(repoPath);
    // 2. Check for prd.md
    const prdSrc = path.join(sessionDir, 'prd.md');
    if (!fs.existsSync(prdSrc)) {
        throw new Error(`prd.md not found in ${sessionDir}`);
    }
    // 3. Setup Jar storage
    const today = new Date().toISOString().split('T')[0];
    const sessionId = path.basename(sessionDir);
    const jarRoot = path.join(getExtensionRoot(), 'jar');
    const taskDir = path.join(jarRoot, today, sessionId);
    fs.mkdirSync(taskDir, { recursive: true });
    // 4. Copy PRD and compute integrity hash (atomic write)
    const prdContent = fs.readFileSync(prdSrc, 'utf-8');
    const prdDest = path.join(taskDir, 'prd.md');
    const prdTmp = `${prdDest}.tmp.${process.pid}`;
    fs.writeFileSync(prdTmp, prdContent);
    fs.renameSync(prdTmp, prdDest);
    const prdHash = crypto.createHash('sha256').update(prdContent).digest('hex');
    // 5. Write meta.json (atomic write — includes prd_hash for integrity verification at run time)
    const meta = {
        repo_path: repoPath,
        branch,
        prd_path: 'prd.md',
        prd_hash: prdHash,
        created_at: new Date().toISOString(),
        task_id: sessionId,
        status: 'marinating',
    };
    const metaDest = path.join(taskDir, 'meta.json');
    const metaTmp = `${metaDest}.tmp.${process.pid}`;
    fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2));
    fs.renameSync(metaTmp, metaDest);
    // 6. Re-read state to minimize race window with concurrent loop updates,
    //    then deactivate the session to prevent immediate execution.
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch { /* use previously read state if re-read fails */ }
    state.active = false;
    state.completion_promise = 'JARRED'; // Signal completion
    writeStateFile(statePath, state);
    return taskDir;
}
// CLI Support — process.exit() is intentional here: this block only runs when
// the file is invoked directly as a CLI script (guarded by process.argv[1] check),
// never when imported as a library module.
if (process.argv[1] && path.basename(process.argv[1]) === 'jar-utils.js') {
    const args = process.argv.slice(2);
    const sessionIndex = args.indexOf('--session');
    if (sessionIndex === -1) {
        console.log('Usage: node jar-utils.js add --session <path>');
        // eslint-disable-next-line pickle/no-process-exit-in-library
        process.exit(1);
    }
    const sessionDir = args[sessionIndex + 1];
    if (!sessionDir || sessionDir.startsWith('--')) {
        console.error('Error: --session requires a non-empty path value.');
        // eslint-disable-next-line pickle/no-process-exit-in-library
        process.exit(1);
    }
    try {
        const resultPath = addToJar(sessionDir);
        console.log(`Task successfully jarred at: ${resultPath}`);
    }
    catch (err) {
        console.error(`${Style.RED}Error: ${err instanceof Error ? err.message : String(err)}${Style.RESET}`);
        // eslint-disable-next-line pickle/no-process-exit-in-library
        process.exit(1);
    }
}
