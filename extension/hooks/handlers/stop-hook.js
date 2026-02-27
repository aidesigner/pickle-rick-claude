import * as fs from 'fs';
import * as path from 'path';
import { PromiseTokens, hasToken } from '../../types/index.js';
import { resolveStateFile, approve, writeStateFile } from '../resolve-state.js';
import { getExtensionRoot } from '../../services/pickle-utils.js';
import { logActivity } from '../../services/activity-logger.js';
async function main() {
    const extensionDir = getExtensionRoot();
    const globalDebugLog = path.join(extensionDir, 'debug.log');
    let sessionHooksLog = null;
    // 0. Check disabled marker — /disable-pickle creates this file to globally suppress the hook
    const disabledMarker = path.join(extensionDir, 'disabled');
    if (fs.existsSync(disabledMarker)) {
        approve();
        return;
    }
    const log = (msg) => {
        const ts = new Date().toISOString();
        const formatted = `[${ts}] [StopHookJS] ${msg}\n`;
        try {
            fs.appendFileSync(globalDebugLog, formatted);
        }
        catch { /* ignore */ }
        if (sessionHooksLog) {
            try {
                fs.appendFileSync(sessionHooksLog, formatted);
            }
            catch { /* ignore */ }
        }
    };
    // 1. Read Input
    let inputData = '';
    try {
        inputData = fs.readFileSync(0, 'utf8');
    }
    catch {
        log('Failed to read stdin');
        approve();
        return;
    }
    let input;
    try {
        input = JSON.parse(inputData || '{}');
    }
    catch (e) {
        log(`Failed to parse input JSON: ${e instanceof Error ? e.message : String(e)}`);
        approve();
        return;
    }
    log(`Processing Stop hook. Input size: ${inputData.length}`);
    // 2. Determine State File
    const stateFile = resolveStateFile(extensionDir);
    if (!stateFile) {
        log(`No state file found.`);
        approve();
        return;
    }
    sessionHooksLog = path.join(path.dirname(stateFile), 'hooks.log');
    log(`State file found: ${stateFile}`);
    // 3. Read State
    let state;
    try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    catch {
        log('Failed to parse state.json');
        approve();
        return;
    }
    // 4. Check Context
    if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
        log(`CWD Mismatch: ${process.cwd()} !== ${state.working_dir}`);
        approve();
        return;
    }
    // 5. Bypass for Workers or Inactive loops
    const role = process.env.PICKLE_ROLE;
    const isWorker = role === 'worker';
    log(`State: active=${state.active}, iteration=${state.iteration}/${state.max_iterations}`);
    log(`Context: role=${role}, isWorker=${isWorker}, cwd=${process.cwd()}`);
    // 5a. In tmux mode, allow the main Claude window to exit freely.
    // tmux-runner sets PICKLE_STATE_FILE for its subprocesses; the main Claude window has
    // no such env var. We use this to distinguish the two — the early-exit must NOT fire
    // for tmux-runner subprocesses (they still need block/checkpoint handling to run phases).
    if (state.tmux_mode === true && !process.env.PICKLE_STATE_FILE) {
        log('Decision: APPROVE (tmux mode — main window defers to tmux-runner)');
        approve();
        return;
    }
    if (state.active !== true) {
        log('Decision: APPROVE (Session inactive)');
        approve();
        return;
    }
    // 6. Check Completion Promise
    const responseText = input.prompt_response || '';
    log(`Agent response received (${responseText.length} chars)`);
    const hasPromise = !!state.completion_promise && hasToken(responseText, state.completion_promise);
    // Stop Tokens (Full Exit)
    const isEpicDone = hasToken(responseText, PromiseTokens.EPIC_COMPLETED);
    const isTaskFinished = hasToken(responseText, PromiseTokens.TASK_COMPLETED);
    const isRefinementWorker = role === 'refinement-worker';
    const isAnalysisDone = isRefinementWorker && hasToken(responseText, PromiseTokens.ANALYSIS_DONE);
    const isExistenceIsPain = hasToken(responseText, PromiseTokens.EXISTENCE_IS_PAIN);
    // Continue Tokens (Checkpoint)
    const isWorkerDone = isWorker && hasToken(responseText, PromiseTokens.WORKER_DONE);
    const isPrdDone = !isWorker && hasToken(responseText, PromiseTokens.PRD_COMPLETE);
    const isTicketSelected = !isWorker && hasToken(responseText, PromiseTokens.TICKET_SELECTED);
    log(`Promises: hasPromise=${hasPromise}, isEpicDone=${isEpicDone}, isTaskFinished=${isTaskFinished}, isWorkerDone=${isWorkerDone}, isAnalysisDone=${isAnalysisDone}, isExistenceIsPain=${isExistenceIsPain}, isPrdDone=${isPrdDone}, isTicketSelected=${isTicketSelected}`);
    // EXIT CONDITIONS: Full Exit
    if (hasPromise || isEpicDone || isTaskFinished || isWorkerDone || isAnalysisDone || isExistenceIsPain) {
        // min_iterations gate: only applies to EXISTENCE_IS_PAIN token
        if (isExistenceIsPain) {
            const rawMinIter = Number(state.min_iterations);
            const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
            const rawCurIter2 = Number(state.iteration);
            const curIter2 = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
            if (minIter > 0 && curIter2 < minIter) {
                if (state.tmux_mode === true) {
                    // tmux mode: approve exit — tmux-runner handles respawn
                    log(`Decision: APPROVE (EXISTENCE_IS_PAIN at ${curIter2}/${minIter} — below min, runner continues)`);
                    approve();
                    return;
                }
                // non-tmux mode: block to continue the inline loop
                log(`Decision: BLOCK (EXISTENCE_IS_PAIN at ${curIter2}/${minIter} — below min, continuing inline loop)`);
                console.log(JSON.stringify({ decision: 'block', reason: `🥒 Clean pass ${curIter2}/${minIter} — continuing review` }));
                return;
            }
        }
        log(`Decision: APPROVE (Task/Worker complete)`);
        if (!isWorker && !isRefinementWorker) {
            state.active = false;
            writeStateFile(stateFile, state);
        }
        approve();
        const sessionId = path.basename(path.dirname(stateFile));
        if (isExistenceIsPain) {
            logActivity({ event: 'meeseeks_pass', source: 'pickle', session: sessionId, pass: Number(state.iteration) || undefined });
        }
        else if (isEpicDone) {
            logActivity({ event: 'epic_completed', source: 'pickle', session: sessionId, epic: state.original_prompt || undefined });
        }
        else if (isTaskFinished && !isWorker) {
            logActivity({ event: 'ticket_completed', source: 'pickle', session: sessionId, ticket: state.current_ticket || undefined, step: state.step });
        }
        // isWorkerDone, isAnalysisDone, hasPromise → no activity events
        return;
    }
    // CONTINUE CONDITIONS: Block exit to force next iteration
    if (isPrdDone || isTicketSelected) {
        // In tmux mode, allow exit at checkpoints — tmux-runner respawns a fresh instance
        // for each phase, giving it a full turn budget instead of sharing one session.
        if (state.tmux_mode === true) {
            log(`Decision: APPROVE (tmux mode checkpoint — runner will respawn for next phase)`);
            approve();
            return;
        }
        log(`Decision: BLOCK (Checkpoint reached)`);
        let feedback = '🥒 **Pickle Rick Loop Active** - ';
        if (isPrdDone)
            feedback += 'PRD finished, moving to breakdown...';
        else if (isTicketSelected)
            feedback += 'Ticket selected, starting research...';
        console.log(JSON.stringify({ decision: 'block', reason: feedback }));
        return;
    }
    // 7. Check Limits (Final Guard)
    const now = Math.floor(Date.now() / 1000);
    const rawStartEpoch = Number(state.start_time_epoch);
    const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
    const rawMaxTimeMins = Number(state.max_time_minutes);
    const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
    const rawMaxIter = Number(state.max_iterations);
    const maxIter = Number.isFinite(rawMaxIter) ? rawMaxIter : 0;
    const rawCurIter = Number(state.iteration);
    const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
    const elapsedSeconds = startEpoch > 0 ? Math.max(0, now - startEpoch) : 0;
    const maxTimeSeconds = maxTimeMins * 60;
    if (maxIter > 0 && curIter >= maxIter) {
        log(`Decision: APPROVE (Max iterations reached: ${curIter}/${maxIter})`);
        state.active = false;
        writeStateFile(stateFile, state);
        approve();
        if (state.tmux_mode !== true) {
            const durationMin = startEpoch > 0 ? Math.round(elapsedSeconds / 60) : undefined;
            logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(stateFile)), duration_min: durationMin, mode: 'inline' });
        }
        return;
    }
    if (maxTimeMins > 0 && startEpoch > 0 && elapsedSeconds >= maxTimeSeconds) {
        log(`Decision: APPROVE (Time limit reached: ${elapsedSeconds}/${maxTimeSeconds}s)`);
        state.active = false;
        writeStateFile(stateFile, state);
        approve();
        if (state.tmux_mode !== true) {
            logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(stateFile)), duration_min: Math.round(elapsedSeconds / 60), mode: 'inline' });
        }
        return;
    }
    // 8. Default: Continue Loop (Prevent Exit)
    log('Decision: BLOCK (Default continuation)');
    let defaultFeedback = `🥒 **Pickle Rick Loop Active** (Iteration ${curIter})`;
    if (maxIter > 0)
        defaultFeedback += ` of ${maxIter}`;
    console.log(JSON.stringify({ decision: 'block', reason: defaultFeedback }));
}
main().catch((err) => {
    try {
        const extensionDir = getExtensionRoot();
        const debugLog = path.join(extensionDir, 'debug.log');
        const detail = err instanceof Error ? err.stack || err.message : String(err);
        fs.appendFileSync(debugLog, `[FATAL] ${detail}\n`);
    }
    catch {
        /* ignore */
    }
    approve();
});
