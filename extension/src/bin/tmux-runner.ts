#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary } from '../services/pickle-utils.js';
import { State, PromiseTokens, hasToken, VALID_STEPS } from '../types/index.js';
import { writeStateFile } from '../hooks/resolve-state.js';

/**
 * Classifies iteration output into a completion result.
 * TASK_COMPLETED/EPIC_COMPLETED → 'task_completed' (no min_iterations gate)
 * EXISTENCE_IS_PAIN → 'review_clean' (subject to min_iterations gate)
 * Neither → 'continue'
 */
export function classifyCompletion(output: string): 'task_completed' | 'review_clean' | 'continue' {
  if (hasToken(output, PromiseTokens.EPIC_COMPLETED) ||
      hasToken(output, PromiseTokens.TASK_COMPLETED)) {
    return 'task_completed';
  }
  if (hasToken(output, PromiseTokens.EXISTENCE_IS_PAIN)) {
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
    managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir);
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
      process.stdout.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      writeToLog(chunk);
      process.stderr.write(chunk);
    });

    proc.on('close', () => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(logFd); } catch { /* already closed */ }
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
    console.log(msg);
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

  const startTime = Date.now();
  let iteration = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let exitReason: 'success' | 'cancelled' | 'error' | 'limit' | 'stall' = 'error';

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

    // Stall detection: if state.iteration hasn't advanced in 3 outer-loop iterations,
    // something is broken (stop hook not firing, subprocess crashing, etc.)
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

    iteration++;
    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);

    const result = await runIteration(sessionDir, iteration, extensionRoot);

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
        log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing loop.');
        continue;
      }
      log('Task completed. Exiting loop.');
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
        exitReason = 'success';
        break;
      }
    } else if (result === 'inactive') { log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break; }
    else if (result === 'error') { log('Subprocess error. Exiting loop.'); exitReason = 'error'; break; }

    await new Promise(r => setTimeout(r, 1000));
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
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
  const isFailure = exitReason === 'error' || exitReason === 'stall';
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
