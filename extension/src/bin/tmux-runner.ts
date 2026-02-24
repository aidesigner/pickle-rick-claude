#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary } from '../services/pickle-utils.js';
import { State as PickleState, PromiseTokens, hasToken } from '../types/index.js';
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

  if (!state.active) return 'inactive';

  const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
  if (!fs.existsSync(picklePromptPath)) {
    throw new Error(`pickle.md not found at ${picklePromptPath}. Run install.sh first.`);
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
    maxTurns = settings.default_tmux_max_turns ?? settings.default_manager_max_turns ?? 50;
  } catch { /* use default */ }

  const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
  const cmdArgs = [
    '--dangerously-skip-permissions',
    '--add-dir', sessionDir,
    '--no-session-persistence',
    '--max-turns', String(maxTurns),
    '-p', managerPrompt,
  ];

  const env: NodeJS.ProcessEnv = { ...process.env, PICKLE_STATE_FILE: statePath };
  // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
  // inside another Claude Code session (which would alter its behavior).
  delete env['CLAUDECODE'];

  const logStream = fs.createWriteStream(logFile, { flags: 'w' });

  return new Promise((resolve) => {
    const proc = spawn('claude', cmdArgs, {
      cwd: state.working_dir || process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);

    proc.on('close', () => {
      logStream.end();

      let finalized = false;
      function finalize() {
        if (finalized) return;
        finalized = true;
        const output = fs.readFileSync(logFile, 'utf-8');
        if (hasToken(output, PromiseTokens.EPIC_COMPLETED) ||
            hasToken(output, PromiseTokens.TASK_COMPLETED)) {
          resolve('completed');
        } else {
          resolve('continue');
        }
      }

      // Guard against logStream.finish never firing (e.g., disk I/O failure)
      const flushTimeout = setTimeout(() => {
        console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
        finalize();
      }, 5000);

      logStream.on('finish', () => {
        clearTimeout(flushTimeout);
        finalize();
      });
    });

    proc.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${Style.RED}Failed to spawn claude: ${msg}${Style.RESET}`);
      resolve('error');
    });
  });
}

async function main() {
  const sessionDir = process.argv[2];
  if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
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
  if (!ownerState.active) {
    ownerState.active = true;
    writeStateFile(statePath, ownerState);
    log('Session ownership taken (active: false → true)');
  }

  const startTime = Date.now();
  let iteration = 0;
  let lastStateIteration = -1;
  let stallCount = 0;

  while (true) {
    let state: PickleState;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
      break;
    }

    if (!state.active) {
      log('Session inactive. Exiting.');
      break;
    }

    if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
      log(`Max iterations reached (${state.iteration}/${state.max_iterations}). Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      break;
    }

    const startEpoch = Number(state.start_time_epoch) || 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    if (state.max_time_minutes > 0 && startEpoch > 0 && elapsed >= state.max_time_minutes * 60) {
      log(`Time limit reached (${elapsed}s). Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      break;
    }

    // Stall detection: if state.iteration hasn't advanced in 3 outer-loop iterations,
    // something is broken (stop hook not firing, subprocess crashing, etc.)
    if (state.iteration === lastStateIteration) {
      stallCount++;
      if (stallCount >= 3) {
        log(`WARNING: state.iteration has not advanced in 3 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
        state.active = false;
        writeStateFile(statePath, state);
        break;
      }
    } else {
      stallCount = 0;
    }
    lastStateIteration = state.iteration;

    iteration++;
    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);

    const result = await runIteration(sessionDir, iteration, extensionRoot);

    if (result === 'completed') { log('Epic/Task completed. Exiting loop.'); break; }
    if (result === 'inactive') { log('Session deactivated. Exiting loop.'); break; }
    if (result === 'error') { log('Subprocess error. Exiting loop.'); break; }

    await new Promise(r => setTimeout(r, 1000));
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  let finalStep = 'unknown';
  let finalActive = 'unknown';
  try {
    const finalState: PickleState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    finalStep = finalState.step || 'unknown';
    finalActive = String(finalState.active);
  } catch { /* use fallback values */ }

  printMinimalPanel('tmux-runner Complete', {
    Iterations: iteration,
    Elapsed: formatTime(totalElapsed),
    FinalPhase: finalStep,
    Active: finalActive,
  }, 'GREEN', '🥒');

  log(`tmux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
  process.exit(1);
});
