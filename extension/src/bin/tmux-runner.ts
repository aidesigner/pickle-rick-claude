#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary } from '../services/pickle-utils.js';
import { State as PickleState, PromiseTokens, hasToken, VALID_STEPS } from '../types/index.js';
import { writeStateFile } from '../hooks/resolve-state.js';

async function runIteration(sessionDir: string, iterationNum: number, extensionRoot: string): Promise<string> {
  const statePath = path.join(sessionDir, 'state.json');
  let state: PickleState;
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

  const logStream = fs.createWriteStream(logFile, { flags: 'w' });
  logStream.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.YELLOW}⚠️  Log stream error: ${msg}${Style.RESET}`);
  });

  return new Promise((resolve) => {
    let settled = false;

    const proc = spawn('claude', cmdArgs, {
      cwd: state.working_dir || process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // Use { end: false } so that when stdout ends first it doesn't call
    // logStream.end(), which would discard any stderr data still in-flight.
    // logStream.end() is called explicitly in the 'close' handler.
    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    proc.stdout?.pipe(process.stdout, { end: false });
    proc.stderr?.pipe(process.stderr, { end: false });

    proc.on('close', () => {
      if (settled) return;
      settled = true;

      let finalized = false;
      function finalize() {
        if (finalized) return;
        finalized = true;
        let output = '';
        try { output = fs.readFileSync(logFile, 'utf-8'); } catch { /* missing/unreadable log */ }
        if (hasToken(output, PromiseTokens.EPIC_COMPLETED) ||
            hasToken(output, PromiseTokens.TASK_COMPLETED) ||
            hasToken(output, PromiseTokens.EXISTENCE_IS_PAIN)) {
          resolve('completed');
        } else {
          resolve('continue');
        }
      }

      // Register finish listener BEFORE calling end() to avoid missing synchronous completion
      const flushTimeout = setTimeout(() => {
        console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
        finalize();
      }, 5000);

      logStream.on('finish', () => {
        clearTimeout(flushTimeout);
        finalize();
      });

      logStream.end();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${Style.RED}Failed to spawn claude: ${msg}${Style.RESET}`);
      logStream.end();
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
  let ownerState: PickleState;
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
    let state: PickleState;
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

    if (result === 'completed') {
      let curState: PickleState;
      try {
        curState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: Cannot read state.json after completion: ${msg}. Treating as completed.`);
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
        log('Completed. Exiting loop.');
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
    const finalState: PickleState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
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
