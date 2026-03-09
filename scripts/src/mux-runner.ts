import * as fs from 'fs';
import * as path from 'path';
import type {
  State,
  CompletionClassification,
  SessionExitReason,
  IterationExitResult,
  RateLimitInfo,
  SpawnResult,
} from './types/index.js';
import { PromiseTokens, hasToken } from './types/index.js';
import { spawnManager } from './spawn-worker.js';
import { loadConfig } from './services/config.js';
import { isDegenerate, extractTail } from './services/degenerate-detector.js';
export { isDegenerate } from './services/degenerate-detector.js';

// ---------------------------------------------------------------------------
// Inline helpers (will be replaced by pickle-utils when ticket fb281903 lands)
// ---------------------------------------------------------------------------

function writeStateFile(filePath: string, state: object): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}

function readStateFile(filePath: string): State {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as State;
}

function buildHandoffSummary(state: Partial<State>, sessionDir: string, iteration: number): string {
  const lines = [
    `# Handoff Summary (iteration ${iteration})`,
    '',
    `Step: ${state.step || 'unknown'}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Working dir: ${state.working_dir || 'unknown'}`,
  ];
  if (state.history && state.history.length > 0) {
    const last = state.history[state.history.length - 1];
    lines.push(`Last action: ${last.step} at ${last.timestamp}`);
  }
  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Token Classification
// ---------------------------------------------------------------------------

const RATE_LIMIT_TEXT_PATTERNS = [
  /5.*hour.*limit/i,
  /limit.*reached.*try.*back/i,
  /usage.*limit.*reached/i,
  /rate limit/i,
  /out of (extra )?usage/i,
];

/**
 * Classifies iteration output into a completion result.
 * Checks tokens in priority order per PRD table.
 * WORKER_DONE and ANALYSIS_DONE are NOT scanned.
 */
export function classifyCompletion(output: string, state?: Partial<State>): CompletionClassification {
  if (hasToken(output, PromiseTokens.EPIC_COMPLETED)) return 'task_completed';
  if (hasToken(output, PromiseTokens.EXISTENCE_IS_PAIN)) return 'review_clean';
  if (hasToken(output, PromiseTokens.THE_CITADEL_APPROVES)) return 'review_clean';
  if (hasToken(output, PromiseTokens.TASK_COMPLETED)) return 'task_completed';
  if (hasToken(output, PromiseTokens.PRD_COMPLETE)) return 'continue';
  if (hasToken(output, PromiseTokens.TICKET_SELECTED)) return 'continue';

  if (state?.completion_promise && hasToken(output, state.completion_promise)) {
    return 'task_completed';
  }

  return 'continue';
}

/**
 * Classifies iteration exit based on raw spawn result.
 * Rate limit detection runs first to prevent circuit breaker poisoning.
 */
export function classifyIterationExit(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
): IterationExitResult {
  const combined = stdout + '\n' + stderr;

  // Rate limit detection (runs BEFORE error classification)
  const rateLimitInfo = detectRateLimit(combined);
  if (rateLimitInfo.limited) {
    return { type: 'api_limit', rateLimitInfo };
  }
  if (RATE_LIMIT_TEXT_PATTERNS.some(p => p.test(combined))) {
    return { type: 'api_limit' };
  }

  // Error exit (non-zero, non-timeout)
  if (exitCode !== null && exitCode !== 0 && !timedOut) {
    return { type: 'error' };
  }

  // Timeout
  if (timedOut) {
    return { type: 'error' };
  }

  return { type: 'success' };
}

function detectRateLimit(text: string): RateLimitInfo {
  const result: RateLimitInfo = { limited: false };
  const lines = text.split('\n');
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'rate_limit_event') continue;
      const info = parsed.rate_limit_info ?? parsed;
      if (info.status === 'rejected') {
        result.limited = true;
        if (typeof info.resetsAt === 'number') result.resetsAt = info.resetsAt;
        if (typeof info.rateLimitType === 'string') result.rateLimitType = info.rateLimitType;
      }
    } catch {
      // Not JSON — skip
    }
  }
  return result;
}

/**
 * Validates command template name — rejects path traversal.
 */
export function validateCommandTemplate(template: string): void {
  if (/[/\\]|\.\./.test(template)) {
    throw new Error("Invalid command template: must not contain path separators or '..'");
  }
}

/**
 * Transitions session from ticket-execution to Meeseeks review mode.
 * Pure function — returns new state.
 */
export function transitionToMeeseeks(state: State): State {
  const config = loadConfig();
  return {
    ...state,
    chain_meeseeks: false,
    command_template: 'meeseeks.md',
    min_iterations: config.defaults.meeseeks_min_passes,
    max_iterations: config.defaults.meeseeks_max_passes,
    iteration: 0,
    step: 'review',
    current_ticket: null,
  };
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sessionDir = process.argv[2];
  if (!sessionDir || sessionDir.startsWith('--')) {
    console.error('Usage: node mux-runner.js <session-dir> [--max-iterations N] [--resume]');
    process.exit(1);
  }

  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    console.error(`state.json not found in ${sessionDir}`);
    process.exit(1);
  }

  const config = loadConfig();
  const startTime = Date.now();
  let iteration = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let consecutiveRateLimits = 0;
  let exitReason: SessionExitReason = 'error';

  // CLI overrides
  const maxIterIdx = process.argv.indexOf('--max-iterations');
  const cliMaxIter = maxIterIdx !== -1 ? Number(process.argv[maxIterIdx + 1]) : undefined;

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.error(line);
    try {
      fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), line + '\n');
    } catch { /* best effort */ }
  };

  log('mux-runner started');

  // Graceful shutdown
  const handleShutdown = (signal: string) => {
    log(`Received ${signal} — deactivating session`);
    try {
      const state = readStateFile(statePath);
      state.active = false;
      writeStateFile(statePath, state);
    } catch {
      try { writeStateFile(statePath, { active: false }); } catch { /* nothing we can do */ }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  while (true) {
    // Read state
    let state: State;
    try {
      state = readStateFile(statePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: Cannot read state.json: ${msg}. Exiting.`);
      exitReason = 'error';
      break;
    }

    // Check active
    if (state.active !== true) {
      log('Session inactive. Exiting.');
      exitReason = 'cancelled';
      break;
    }

    // Check max_iterations
    const maxIter = cliMaxIter ?? (Number.isFinite(state.max_iterations) ? state.max_iterations : 0);
    if (maxIter > 0 && state.iteration >= maxIter) {
      log(`Max iterations reached (${state.iteration}/${maxIter}). Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'limit';
      break;
    }

    // Check max_time_minutes
    const startEpoch = Number.isFinite(state.start_time_epoch) ? state.start_time_epoch : 0;
    const maxTimeMins = Number.isFinite(state.max_time_minutes) ? state.max_time_minutes : 0;
    if (maxTimeMins > 0 && startEpoch > 0) {
      const elapsed = Math.floor(Date.now() / 1000) - startEpoch;
      if (elapsed >= maxTimeMins * 60) {
        log(`Time limit reached (${elapsed}s). Exiting.`);
        state.active = false;
        writeStateFile(statePath, state);
        exitReason = 'limit';
        break;
      }
    }

    // Stall detection: 3 iterations without state.iteration change
    const curIter = Number.isFinite(state.iteration) ? state.iteration : 0;
    if (curIter === lastStateIteration) {
      stallCount++;
      if (stallCount >= 3) {
        log(`Stall detected: state.iteration stuck at ${state.iteration} for 3 iterations. Exiting.`);
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

    // Validate command template
    const templateName = state.command_template || 'pickle.md';
    try {
      validateCommandTemplate(templateName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}. Exiting.`);
      exitReason = 'error';
      break;
    }

    // Handoff: consume handoff.txt or generate summary
    let handoffContent = '';
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
      try {
        handoffContent = fs.readFileSync(handoffPath, 'utf-8');
        fs.unlinkSync(handoffPath);
      } catch { /* consumed — prevent stale re-reads */ }
    } else {
      handoffContent = buildHandoffSummary(state, sessionDir, iteration);
    }

    // Build prompt
    const prompt = handoffContent;

    // Spawn manager
    const logFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
    const timeout = Number.isFinite(state.worker_timeout_seconds)
      ? state.worker_timeout_seconds
      : config.defaults.worker_timeout_seconds;

    let spawnResult: SpawnResult;
    try {
      spawnResult = await spawnManager({
        prompt,
        runtime: config.primary_cli,
        cwd: state.working_dir || process.cwd(),
        logFile,
        timeout,
        sessionDir,
        extensionRoot: process.env['EXTENSION_DIR'] || sessionDir,
        maxTurns: config.defaults.tmux_max_turns,
        model: templateName === 'meeseeks.md' ? config.defaults.meeseeks_model : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Spawn error: ${msg}. Exiting.`);
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'error';
      break;
    }

    // Classify iteration exit (rate limit runs BEFORE circuit breaker)
    let exitResult = classifyIterationExit(
      spawnResult.exitCode,
      spawnResult.stdout,
      spawnResult.stderr,
      spawnResult.timedOut,
    );

    if (exitResult.type === 'api_limit') {
      consecutiveRateLimits++;
      log(`API rate limit (consecutive: ${consecutiveRateLimits}/${config.defaults.max_rate_limit_retries})`);
      if (consecutiveRateLimits >= config.defaults.max_rate_limit_retries) {
        exitReason = 'rate_limit_exhausted';
        state.active = false;
        writeStateFile(statePath, state);
        break;
      }
      await sleep(config.defaults.rate_limit_poll_ms);
      continue;
    }
    if (exitResult.type === 'success') consecutiveRateLimits = 0;

    // Degenerate output → reclassify success as error for CB recording
    if (exitResult.type === 'success') {
      const tailOutput = extractTail(spawnResult.stdout);
      const degResult = isDegenerate(tailOutput);
      if (degResult.degenerate) {
        log(`Degenerate output detected: ${degResult.reason} (${spawnResult.stdout.trim().length} chars). Reclassifying as error.`);
        exitResult = { type: 'error' };
      }
    }

    if (exitResult.type === 'error') {
      log('Subprocess error. Exiting.');
      state.active = false;
      writeStateFile(statePath, state);
      exitReason = 'error';
      break;
    }

    // Classify completion tokens
    const completion = classifyCompletion(spawnResult.stdout, state);

    if (completion === 'task_completed') {
      // Re-read state for chain_meeseeks check
      let curState: State;
      try {
        curState = readStateFile(statePath);
      } catch {
        exitReason = 'success';
        break;
      }

      if (curState.chain_meeseeks === true) {
        const newState = transitionToMeeseeks(curState);
        writeStateFile(statePath, newState);
        lastStateIteration = -1;
        stallCount = 0;
        log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing.');
        continue;
      }

      log('Task completed. Exiting.');
      curState.active = false;
      writeStateFile(statePath, curState);
      exitReason = 'success';
      break;
    }

    if (completion === 'review_clean') {
      let curState: State;
      try {
        curState = readStateFile(statePath);
      } catch {
        exitReason = 'success';
        break;
      }

      const minIter = Number.isFinite(curState.min_iterations) ? (curState.min_iterations ?? 0) : 0;
      const curIterNow = Number.isFinite(curState.iteration) ? curState.iteration : 0;
      if (minIter > 0 && curIterNow < minIter) {
        log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
      } else {
        log('Review clean. Exiting.');
        curState.active = false;
        writeStateFile(statePath, curState);
        exitReason = 'success';
        break;
      }
    }

    // Update state: iteration++, history push
    try {
      const updatedState = readStateFile(statePath);
      updatedState.iteration = (updatedState.iteration || 0) + 1;
      updatedState.history = updatedState.history || [];
      updatedState.history.push({
        step: updatedState.step,
        ticket: updatedState.current_ticket || undefined,
        timestamp: new Date().toISOString(),
      });
      writeStateFile(statePath, updatedState);
    } catch { /* state update failed — continue */ }

    // Write handoff for next iteration
    try {
      const latestState = readStateFile(statePath);
      const handoff = buildHandoffSummary(latestState, sessionDir, iteration + 1);
      const handoffTmp = `${handoffPath}.tmp.${process.pid}`;
      fs.writeFileSync(handoffTmp, handoff);
      fs.renameSync(handoffTmp, handoffPath);
    } catch { /* handoff write failed — non-fatal */ }

    await sleep(1000);
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  log(`mux-runner finished. ${iteration} iterations, ${totalElapsed}s. Exit: ${exitReason}`);
  console.log(exitReason);
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (process.argv[1] && path.basename(process.argv[1]) === 'mux-runner.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FATAL] ${msg}`);
    process.exit(1);
  });
}
