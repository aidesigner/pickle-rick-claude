#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary, sleep } from '../services/pickle-utils.js';
import { State, PromiseTokens, hasToken, VALID_STEPS, type IterationExitType } from '../types/index.js';
import { writeStateFile } from '../hooks/resolve-state.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, type CircuitBreakerState } from '../services/circuit-breaker.js';

/**
 * Extracts text content from assistant messages in stream-json output.
 * Filters out tool_result / user / system lines so that promise tokens
 * embedded in reviewed source code (e.g. stop-hook.ts containing
 * `<promise>EPIC_COMPLETED</promise>`) do not cause false matches.
 *
 * For non-stream-json (plain text) output, every line fails JSON.parse
 * and is included as-is, preserving backward compatibility.
 */
export function extractAssistantContent(output: string): string {
  const lines = output.split('\n');
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              parts.push(block.text);
            }
          }
        } else if (typeof content === 'string') {
          parts.push(content);
        }
      } else if (parsed.type === 'result' && typeof parsed.result === 'string') {
        parts.push(parsed.result);
      }
      // Intentionally skip: user (tool_result), system, tool_use
    } catch {
      // Not valid JSON — include raw text for backward compat with plain-text output
      parts.push(line);
    }
  }
  return parts.join('\n');
}

/**
 * Classifies iteration output into a completion result.
 * EPIC_COMPLETED → 'task_completed' (exits the loop — all tickets done)
 * EXISTENCE_IS_PAIN → 'review_clean' (subject to min_iterations gate)
 * TASK_COMPLETED / anything else → 'continue' (single ticket done, loop continues)
 *
 * Only checks assistant message content (via extractAssistantContent) to avoid
 * false positives from promise tokens in reviewed source code.
 */
export function classifyCompletion(output: string): 'task_completed' | 'review_clean' | 'continue' {
  const content = extractAssistantContent(output);
  if (hasToken(content, PromiseTokens.EPIC_COMPLETED)) {
    return 'task_completed';
  }
  if (hasToken(content, PromiseTokens.EXISTENCE_IS_PAIN)) {
    return 'review_clean';
  }
  return 'continue';
}

/**
 * Transitions a session from ticket-execution mode to Meeseeks review mode.
 * Pure function — returns a new state object without side effects.
 */
export function transitionToMeeseeks(state: State, extensionRoot: string): State {
  let minPasses = 10;
  let maxPasses = 50;

  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const rawMin = Number(settings.default_meeseeks_min_passes);
    if (Number.isFinite(rawMin) && rawMin > 0) minPasses = rawMin;
    const rawMax = Number(settings.default_meeseeks_max_passes);
    if (Number.isFinite(rawMax) && rawMax > 0) maxPasses = rawMax;
  } catch { /* use defaults */ }

  return {
    ...state,
    chain_meeseeks: false,
    command_template: 'meeseeks.md',
    min_iterations: minPasses,
    max_iterations: maxPasses,
    iteration: 0,
    step: 'review',
    current_ticket: null,
  };
}

export function loadRateLimitSettings(extensionRoot: string): { waitMinutes: number; maxRetries: number } {
  let waitMinutes = 60;
  let maxRetries = 3;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'pickle_settings.json'), 'utf-8'));
    const rawWait = raw.default_rate_limit_wait_minutes;
    if (typeof rawWait === 'number' && rawWait >= 1) waitMinutes = rawWait;
    const rawRetries = raw.default_max_rate_limit_retries;
    if (typeof rawRetries === 'number' && rawRetries >= 1) maxRetries = rawRetries;
  } catch { /* use defaults */ }
  return { waitMinutes, maxRetries };
}

export function detectRateLimitInLog(logFile: string): boolean {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100);
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'rate_limit_event' && parsed.status === 'rejected') return true;
      } catch { /* not JSON */ }
    }
  } catch { /* file missing */ }
  return false;
}

export function detectRateLimitInText(logFile: string): boolean {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100);
    const filtered = tail.filter(l => !l.includes('"type":"user"') && !l.includes('"type":"tool_result"'));
    const text = filtered.join('\n');
    const patterns = [/5.*hour.*limit/i, /limit.*reached.*try.*back/i, /usage.*limit.*reached/i, /rate limit/i];
    return patterns.some(p => p.test(text));
  } catch { /* file missing */ }
  return false;
}

export function classifyIterationExit(
  completionResult: string,
  logFile: string,
): IterationExitType {
  if (completionResult === 'inactive') return 'inactive';
  if (completionResult === 'error') return 'error';
  if (completionResult === 'task_completed' || completionResult === 'review_clean') return 'success';
  if (detectRateLimitInLog(logFile)) return 'api_limit';
  if (detectRateLimitInText(logFile)) return 'api_limit';
  return 'success';
}

async function runIteration(sessionDir: string, iterationNum: number, extensionRoot: string): Promise<string> {
  const statePath = path.join(sessionDir, 'state.json');
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
  }

  if (state.active !== true) return 'inactive';

  const templateName = state.command_template || 'pickle.md';
  // Validate at read time (not just at setup.ts CLI parse time) — state.json could be tampered with
  if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
    throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
  }
  const picklePromptPath = path.join(os.homedir(), '.claude/commands', templateName);
  if (!fs.existsSync(picklePromptPath)) {
    throw new Error(`${templateName} not found at ${picklePromptPath}. Run install.sh first.`);
  }
  let managerPrompt = fs.readFileSync(picklePromptPath, 'utf-8')
    .replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);

  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (fs.existsSync(handoffPath)) {
    managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
    try { fs.unlinkSync(handoffPath); } catch { /* consumed — prevent stale re-reads */ }
  } else {
    managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir, iterationNum);
  }

  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  let maxTurns = 50;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (typeof settings.default_tmux_max_turns === 'number' && settings.default_tmux_max_turns > 0) {
      maxTurns = settings.default_tmux_max_turns;
    } else if (typeof settings.default_manager_max_turns === 'number' && settings.default_manager_max_turns > 0) {
      maxTurns = settings.default_manager_max_turns;
    }
  } catch { /* use default */ }

  const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
  const cmdArgs = [
    '--dangerously-skip-permissions',
    '--add-dir', extensionRoot,
    '--add-dir', sessionDir,
    '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns),
    '-p', managerPrompt,
  ];

  const env: NodeJS.ProcessEnv = { ...process.env, PICKLE_STATE_FILE: statePath, PYTHONUNBUFFERED: '1' };
  // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
  // inside another Claude Code session (which would alter its behavior).
  delete env['CLAUDECODE'];
  // Remove PICKLE_ROLE so manager subprocesses aren't misidentified as workers
  // by the stop-hook (tmux-runner spawns managers, not workers).
  delete env['PICKLE_ROLE'];

  // Use a raw file descriptor with synchronous writes so every chunk hits
  // the disk immediately. Node's WriteStream buffers up to 16KB internally,
  // which starves log-watcher (it polls file size via statSync).
  const logFd = fs.openSync(logFile, 'w');

  function writeToLog(chunk: Buffer) {
    try { fs.writeSync(logFd, chunk); } catch { /* fd closed — ignore late writes */ }
  }

  return new Promise((resolve) => {
    let settled = false;

    const proc = spawn('claude', cmdArgs, {
      cwd: state.working_dir || process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // Direct data handlers: write each chunk to both the log file (sync,
    // no buffering) and the terminal (for the tmux-runner pane).
    proc.stdout?.on('data', (chunk: Buffer) => {
      writeToLog(chunk);
      process.stderr.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      writeToLog(chunk);
      process.stderr.write(chunk);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      const exitCodeFile = logFile.replace('.log', '.exitcode');
      try { fs.writeFileSync(exitCodeFile, String(code ?? -1)); } catch { /* best effort */ }
      let output = '';
      try { output = fs.readFileSync(logFile, 'utf-8'); } catch { /* missing/unreadable log */ }
      resolve(classifyCompletion(output));
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${Style.RED}Failed to spawn claude: ${msg}${Style.RESET}`);
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve('error');
    });
  });
}

async function main() {
  const sessionDir = process.argv[2];
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
    console.error('Usage: node tmux-runner.js <session-dir>');
    process.exit(1);
  }

  const extensionRoot = getExtensionRoot();
  const statePath = path.join(sessionDir, 'state.json');
  const runnerLog = path.join(sessionDir, 'tmux-runner.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(runnerLog, line);
    process.stderr.write(line);
  };

  log('tmux-runner started');

  // Take ownership: setup.js writes active: false in tmux mode so the main
  // Claude window's stop hook is released immediately. We set active: true here
  // before entering the loop so workers and state readers see a live session.
  let ownerState: State;
  try {
    ownerState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read initial state.json: ${msg}`);
  }
  if (ownerState.active !== true) {
    ownerState.active = true;
    writeStateFile(statePath, ownerState);
    log('Session ownership taken (active: false → true)');
  }

  // Clean up stale rate_limit_wait.json from a previous crashed session
  try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }

  const cbSettings = loadSettings(extensionRoot);
  const cbEnabled = cbSettings.enabled;
  let cbState: CircuitBreakerState | null = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');

  const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);

  const startTime = Date.now();
  let iteration = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let consecutiveRateLimits = 0;
  let exitReason: 'success' | 'cancelled' | 'error' | 'limit' | 'stall' | 'circuit_open' | 'rate_limit_exhausted' = 'error';

  while (true) {
    let state: State;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
      exitReason = 'error';
      break;
    }

    if (state.active !== true) {
      log('Session inactive. Exiting.');
      exitReason = 'cancelled';
      break;
    }

    const rawMaxIter = Number(state.max_iterations);
    const maxIter = Number.isFinite(rawMaxIter) ? rawMaxIter : 0;
    const rawCurIter = Number(state.iteration);
    const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
    if (maxIter > 0 && curIter >= maxIter) {
      log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'limit';
      break;
    }

    const rawStartEpoch = Number(state.start_time_epoch);
    const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
    const rawMaxTimeMins = Number(state.max_time_minutes);
    const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
      log(`Time limit reached (${elapsed}s). Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'limit';
      break;
    }

    // Circuit breaker gate: if CB is OPEN, exit immediately
    if (cbEnabled && cbState && !canExecute(cbState)) {
      log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'circuit_open';
      break;
    }

    // Stall detection fallback (only when CB is disabled)
    if (!cbEnabled) {
      if (curIter === lastStateIteration) {
        stallCount++;
        if (stallCount >= 3) {
          log(`WARNING: state.iteration has not advanced in 3 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
          state.active = false;
          writeStateFile(statePath, state);
          exitReason = 'stall';
          break;
        }
      } else {
        stallCount = 0;
      }
      lastStateIteration = curIter;
    }

    iteration++;
    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);

    const result = await runIteration(sessionDir, iteration, extensionRoot);

    // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
    const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
    const exitType = classifyIterationExit(result, iterLogFile);

    if (exitType === 'api_limit') {
      consecutiveRateLimits++;
      log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
      if (consecutiveRateLimits >= maxRateLimitRetries) {
        exitReason = 'rate_limit_exhausted';
        logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
          session: path.basename(sessionDir), error: `max retries (${maxRateLimitRetries}) exceeded` });
        state.active = false;
        writeStateFile(statePath, state);
        break;
      }
      logActivity({ event: 'rate_limit_wait', source: 'pickle',
        session: path.basename(sessionDir), duration_min: rateLimitWaitMinutes });
      writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
        waiting: true, reason: 'API rate limit',
        started_at: new Date().toISOString(),
        wait_until: new Date(Date.now() + rateLimitWaitMinutes * 60 * 1000).toISOString(),
        consecutive_waits: consecutiveRateLimits,
      });

      // Pre-wait time check
      const rawEpoch = Number(state.start_time_epoch);
      const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
      const rawMax = Number(state.max_time_minutes);
      const maxMins = Number.isFinite(rawMax) ? rawMax : 0;
      let actualWaitMs = rateLimitWaitMinutes * 60 * 1000;
      if (maxMins > 0 && epoch > 0) {
        const elapsed = Math.floor(Date.now() / 1000) - epoch;
        const remaining = (maxMins * 60) - elapsed;
        if (remaining <= 0) { exitReason = 'limit'; state.active = false; writeStateFile(statePath, state); break; }
        actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
      }

      // Cancellable + time-limit-aware sleep loop
      const waitEnd = Date.now() + actualWaitMs;
      while (Date.now() < waitEnd) {
        await sleep(10_000);
        try {
          const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          if (ws.active !== true) { exitReason = 'cancelled'; break; }
        } catch { /* proceed */ }
        if (maxMins > 0 && epoch > 0) {
          const elapsed = Math.floor(Date.now() / 1000) - epoch;
          if (elapsed >= maxMins * 60) { exitReason = 'limit'; break; }
        }
      }
      if (exitReason === 'cancelled' || exitReason === 'limit') {
        state.active = false; writeStateFile(statePath, state); break;
      }

      // Wake: cleanup + handoff
      try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* ok */ }
      logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) });
      fs.writeFileSync(path.join(sessionDir, 'handoff.txt'), [
        buildHandoffSummary(state, sessionDir, iteration + 1), '',
        `NOTE: Resumed after ${rateLimitWaitMinutes}-minute API rate limit wait.`,
        'Resume from current phase — do not repeat the rate-limited iteration.',
      ].join('\n'));
      continue;  // Skip CB recording + result branching entirely
    }
    if (exitType === 'success') consecutiveRateLimits = 0;

    // === Existing CB recording — only reached for non-rate-limit ===

    // Circuit breaker: record iteration outcome (skip for subprocess failures)
    if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
      let postIterState: State;
      try {
        postIterState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      } catch {
        postIterState = state;
      }

      const progress = detectProgress(
        postIterState.working_dir || process.cwd(),
        cbState.last_known_head,
        cbState.last_known_step,
        postIterState.step,
        cbState.last_known_ticket,
        postIterState.current_ticket
      );

      let errorSig: string | null = null;
      try {
        const logContent = fs.readFileSync(iterLogFile, 'utf-8');
        errorSig = extractErrorSignature(logContent);
      } catch { /* log may not exist */ }

      const prevCBState = cbState.state;
      cbState = recordIterationResult(
        cbState,
        { hasProgress: progress.hasProgress, errorSignature: errorSig },
        iteration,
        cbSettings
      );
      cbState.last_known_head = progress.currentHead;
      cbState.last_known_step = postIterState.step;
      cbState.last_known_ticket = postIterState.current_ticket;
      writeStateFile(cbPath, cbState);

      if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
        log(`Circuit breaker tripped: ${cbState.reason}`);
        state.active = false;
        writeStateFile(statePath, state);
        exitReason = 'circuit_open';
        break;
      }

      if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
        logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(sessionDir) });
        log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
      }
    }

    if (result === 'task_completed') {
      // EPIC_COMPLETED / TASK_COMPLETED — check for meeseeks chain before exiting
      let curState: State;
      try {
        curState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
        exitReason = 'success';
        break;
      }
      if (curState.chain_meeseeks === true) {
        const newState = transitionToMeeseeks(curState, extensionRoot);
        writeStateFile(statePath, newState);
        lastStateIteration = -1;
        stallCount = 0;
        if (cbEnabled) {
          try { fs.unlinkSync(cbPath); } catch { /* may not exist */ }
          cbState = initCircuitBreaker(sessionDir, cbSettings);
        }
        log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing loop.');
        continue;
      }
      log('Task completed. Exiting loop.');
      curState.active = false;
      writeStateFile(statePath, curState);
      exitReason = 'success';
      break;
    } else if (result === 'review_clean') {
      // EXISTENCE_IS_PAIN — apply min_iterations gate (Meeseeks review pattern)
      let curState: State;
      try {
        curState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: Cannot read state.json after review_clean: ${msg}. Treating as completed.`);
        exitReason = 'success';
        break;
      }
      const rawMinIter = Number(curState.min_iterations);
      const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
      const rawCurIter2 = Number(curState.iteration);
      const curIterNow = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
      if (minIter > 0 && curIterNow < minIter) {
        log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
      } else {
        log('Review clean. Exiting loop.');
        curState.active = false;
        writeStateFile(statePath, curState);
        exitReason = 'success';
        break;
      }
    } else if (result === 'inactive') { log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break; }
    else if (result === 'error') {
      log('Subprocess error. Exiting loop.');
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'error';
      break;
    }

    await sleep(1000);
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), duration_min: Math.round(totalElapsed / 60), mode: 'tmux' });
  let finalStep = 'unknown';
  let finalActive = 'unknown';
  let finalMinIter = 0;
  try {
    const finalState: State = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const rawStep = finalState.step || 'unknown';
    finalStep = (VALID_STEPS as readonly string[]).includes(rawStep) ? rawStep : 'unknown';
    finalActive = String(finalState.active);
    const rawFinalMinIter = Number(finalState.min_iterations);
    finalMinIter = Number.isFinite(rawFinalMinIter) ? rawFinalMinIter : 0;
  } catch { /* use fallback values */ }

  printMinimalPanel('tmux-runner Complete', {
    Iterations: iteration,
    Elapsed: formatTime(totalElapsed),
    FinalPhase: finalStep,
    Active: finalActive,
    ...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
  }, 'GREEN', '🥒');

  log(`tmux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);

  const notif = buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed);
  if (process.platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawnSync('osascript', ['-e', `display notification "${esc(notif.body)}" with title "${esc(notif.title)}" subtitle "${esc(notif.subtitle)}"`]);
  }
}

export function buildTmuxNotification(exitReason: string, finalStep: string, iteration: number, totalElapsed: number) {
  const isFailure = exitReason === 'error' || exitReason === 'stall' || exitReason === 'circuit_open' || exitReason === 'rate_limit_exhausted';
  const title = isFailure
    ? '🥒 Pickle Run Failed'
    : '🥒 Pickle Run Complete';
  const subtitle = isFailure
    ? `Exit: ${exitReason} (phase: ${finalStep})`
    : exitReason === 'success'
      ? `Finished in ${formatTime(totalElapsed)}`
      : `Stopped: ${exitReason} (${formatTime(totalElapsed)})`;
  const body = `${iteration} iterations, ${formatTime(totalElapsed)}`;
  return { title, subtitle, body };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'tmux-runner.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
