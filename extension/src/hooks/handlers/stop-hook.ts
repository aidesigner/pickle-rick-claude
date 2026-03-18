import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { State, HookInput, PromiseTokens, hasToken } from '../../types/index.js';
import { resolveStateFile, approve } from '../resolve-state.js';
import { getExtensionRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { StateManager } from '../../services/state-manager.js';
import { logActivity } from '../../services/activity-logger.js';

const sm = new StateManager();

function maybeSpawnUpdateCheck(extensionDir: string, log: (msg: string) => void): void {
  const checkUpdatePath = path.join(extensionDir, 'extension', 'bin', 'check-update.js');
  if (!fs.existsSync(checkUpdatePath)) {
    log('check-update.js not found, skipping update check');
    return;
  }
  try {
    const settingsPath = path.join(extensionDir, 'pickle_settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (raw.auto_update_enabled === false) {
      log('Auto-update disabled in settings, skipping');
      return;
    }
  } catch {
    // Settings missing/corrupted — default to enabled
  }
  log('Spawning detached check-update process');
  const child = spawn('node', [checkUpdatePath], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log(`check-update spawn error: ${safeErrorMessage(err)}`);
  });
  child.unref();
}

async function main() {
  const extensionDir = getExtensionRoot();
  const globalDebugLog = path.join(extensionDir, 'debug.log');
  let sessionHooksLog: string | null = null;

  // 0. Check disabled marker — /disable-pickle creates this file to globally suppress the hook
  const disabledMarker = path.join(extensionDir, 'disabled');
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (fs.existsSync(disabledMarker)) {
    approve();
    return;
  }

  const log = (msg: string) => {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] [StopHookJS] ${msg}\n`;
    try { fs.appendFileSync(globalDebugLog, formatted); } catch { /* ignore */ }
    if (sessionHooksLog) {
      try { fs.appendFileSync(sessionHooksLog, formatted); } catch { /* ignore */ }
    }
  };

  // 1. Read Input
  let inputData: string;
  try {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    inputData = fs.readFileSync(0, 'utf8');
  } catch {
    log('Failed to read stdin');
    approve();
    return;
  }

  // Empty stdin: approve silently — normal when hook runs outside active session
  if (!inputData.trim()) {
    approve();
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(inputData);
  } catch {
    const preview = inputData.slice(0, 100);
    const ellipsis = inputData.length > 100 ? '...' : '';
    log(`WARN: corrupted hook input, approving fail-open. First 100 chars: "${preview}"${ellipsis}`);
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
  let state: State;
  try {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
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
  const responseText = input.last_assistant_message || input.prompt_response || '';
  log(`Agent response received (${responseText.length} chars)`);

  // 6a. Rate limit detection — approve exit so mux-runner can handle backoff.
  // Rate limit responses are short synthetic messages from Claude Code.
  // The length guard (<500 chars) prevents false positives from normal conversation
  // that merely mentions rate limits.
  const RATE_LIMIT_PATTERNS = [
    /out of (extra )?usage/i,
    /rate limit/i,
    /usage.*limit.*reached/i,
    /limit.*reached.*try.*back/i,
    /hour.*limit/i,
  ];

  if (responseText.length > 0 && responseText.length < 500 &&
      RATE_LIMIT_PATTERNS.some(p => p.test(responseText))) {
    log('Decision: APPROVE (Rate limit detected — handing off to runner for backoff)');
    approve();
    return;
  }

  const hasPromise =
    !!state.completion_promise && hasToken(responseText, state.completion_promise);

  // Stop Tokens (Full Exit — approve exit, deactivate if applicable)
  const isEpicDone = hasToken(responseText, PromiseTokens.EPIC_COMPLETED);
  const isTaskFinished = hasToken(responseText, PromiseTokens.TASK_COMPLETED);
  const isRefinementWorker = role === 'refinement-worker';
  const isAnalysisDone = isRefinementWorker && hasToken(responseText, PromiseTokens.ANALYSIS_DONE);
  const isExistenceIsPain = hasToken(responseText, PromiseTokens.EXISTENCE_IS_PAIN) || hasToken(responseText, PromiseTokens.THE_CITADEL_APPROVES);
  const isWorkerDone = isWorker && hasToken(responseText, PromiseTokens.WORKER_DONE);

  // Checkpoint Tokens (block exit in inline mode, approve in tmux mode for respawn)
  const isPrdDone = !isWorker && hasToken(responseText, PromiseTokens.PRD_COMPLETE);
  const isTicketSelected = !isWorker && hasToken(responseText, PromiseTokens.TICKET_SELECTED);

  log(
    `Promises: hasPromise=${hasPromise}, isEpicDone=${isEpicDone}, isTaskFinished=${isTaskFinished}, isWorkerDone=${isWorkerDone}, isAnalysisDone=${isAnalysisDone}, isExistenceIsPain=${isExistenceIsPain}, isPrdDone=${isPrdDone}, isTicketSelected=${isTicketSelected}`
  );

  // EXIT CONDITIONS: Full Exit
  if (hasPromise || isEpicDone || isTaskFinished || isWorkerDone || isAnalysisDone || isExistenceIsPain) {
    // min_iterations gate: applies to review-clean tokens (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES)
    if (isExistenceIsPain) {
      const rawMinIter = Number(state.min_iterations);
      const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
      const rawCurIter2 = Number(state.iteration);
      const curIter2 = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
      if (minIter > 0 && curIter2 < minIter) {
        if (state.tmux_mode === true) {
          // tmux mode: approve exit — tmux-runner handles respawn
          log(`Decision: APPROVE (review_clean at ${curIter2}/${minIter} — below min, runner continues)`);
          approve();
          return;
        }
        // non-tmux mode: block to continue the inline loop
        log(`Decision: BLOCK (review_clean at ${curIter2}/${minIter} — below min, continuing inline loop)`);
        console.log(JSON.stringify({ decision: 'block', reason: `🥒 Clean pass ${curIter2}/${minIter} — continuing review` }));
        return;
      }
    }
    log(`Decision: APPROVE (Task/Worker complete)`);
    // In tmux mode, tmux-runner owns the active flag — don't deactivate here.
    // The runner reads classifyCompletion output and manages state transitions itself.
    if (!isWorker && !isRefinementWorker && state.tmux_mode !== true) {
      try { sm.update(stateFile, s => { s.active = false; }); } catch { /* fail-open */ }
    }
    maybeSpawnUpdateCheck(extensionDir, log);
    approve();
    const sessionId = path.basename(path.dirname(stateFile));
    if (isExistenceIsPain) {
      logActivity({ event: 'meeseeks_pass', source: 'pickle', session: sessionId, pass: Number(state.iteration) || undefined });
    } else if (isEpicDone) {
      logActivity({ event: 'epic_completed', source: 'pickle', session: sessionId, epic: state.original_prompt || undefined });
    } else if (isTaskFinished && !isWorker) {
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
    if (isPrdDone) feedback += 'PRD finished, moving to breakdown...';
    else if (isTicketSelected) feedback += 'Ticket selected, starting research...';

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
    if (state.tmux_mode !== true) {
      try { sm.update(stateFile, s => { s.active = false; }); } catch { /* fail-open */ }
    }
    approve();
    if (state.tmux_mode !== true) {
      const durationMin = startEpoch > 0 ? Math.round(elapsedSeconds / 60) : undefined;
      logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(stateFile)), duration_min: durationMin, mode: 'inline' });
    }
    return;
  }

  if (maxTimeMins > 0 && startEpoch > 0 && elapsedSeconds >= maxTimeSeconds) {
    log(`Decision: APPROVE (Time limit reached: ${elapsedSeconds}/${maxTimeSeconds}s)`);
    if (state.tmux_mode !== true) {
      try { sm.update(stateFile, s => { s.active = false; }); } catch { /* fail-open */ }
    }
    approve();
    if (state.tmux_mode !== true) {
      logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(stateFile)), duration_min: Math.round(elapsedSeconds / 60), mode: 'inline' });
    }
    return;
  }

  // 7a. No-op / degenerate response detection.
  // If the agent tries to exit with an empty, whitespace-only, or very short
  // response it's stuck in a degenerate loop. Approve exit so mux-runner can
  // respawn a fresh iteration with full context (tmux) or the session ends
  // cleanly (inline). Without this, the default BLOCK traps the inner Claude
  // in an infinite 2-char-response loop that never advances.
  const trimmed = responseText.trim();
  const DEGENERATE_MAX_LENGTH = 10;
  const NO_OP_MAX_LENGTH = 100;
  const NO_OP_PATTERNS = [
    /^acknowledged\.?$/i,
    /^ok\.?$/i,
    /^done\.?$/i,
    /^understood\.?$/i,
    /^noted\.?$/i,
    /^continuing\.?$/i,
    /^ready\.?$/i,
    /^got it\.?$/i,
    /^will do\.?$/i,
    /^roger\.?$/i,
  ];

  const isDegenerateResponse = (
    (responseText.length > 0 && trimmed.length === 0) ||
    (trimmed.length > 0 && trimmed.length <= DEGENERATE_MAX_LENGTH) ||
    (trimmed.length > 0 && trimmed.length <= NO_OP_MAX_LENGTH && NO_OP_PATTERNS.some(p => p.test(trimmed)))
  );

  if (isDegenerateResponse) {
    const reason = trimmed.length === 0
      ? `Whitespace-only response — ${responseText.length} raw chars`
      : trimmed.length <= DEGENERATE_MAX_LENGTH
        ? `Degenerate short response: "${trimmed}" — ${trimmed.length} chars`
        : `No-op response detected: "${trimmed}" — breaking ack loop`;
    log(`Decision: APPROVE (${reason})`);
    if (!isWorker && !isRefinementWorker && state.tmux_mode !== true) {
      try { sm.update(stateFile, s => { s.active = false; }); } catch { /* fail-open */ }
    }
    approve();
    return;
  }

  // 8. Default: Continue Loop (Prevent Exit)
  log('Decision: BLOCK (Default continuation)');

  const iterSuffix = maxIter > 0 ? ` of ${maxIter}` : '';
  const defaultFeedback = `🥒 **Pickle Rick Loop Active** (Iteration ${curIter}${iterSuffix})`;

  console.log(JSON.stringify({ decision: 'block', reason: defaultFeedback }));
}

main().catch((err) => {
  try {
    const extensionDir = getExtensionRoot();
    const debugLog = path.join(extensionDir, 'debug.log');
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    fs.appendFileSync(debugLog, `[FATAL] ${detail}\n`);
  } catch {
    /* ignore */
  }
  approve();
});
