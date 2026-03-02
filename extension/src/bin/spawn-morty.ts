#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  printMinimalPanel,
  Style,
  formatTime,
  getExtensionRoot,
} from '../services/pickle-utils.js';
import { spawn } from 'child_process';
import { PromiseTokens, hasToken, Defaults } from '../types/index.js';
import { updateTicketStatus } from '../services/git-utils.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      'Usage: node spawn-morty.js <task> --ticket-id <id> --ticket-path <path> [--timeout <sec>] [--output-format <fmt>]'
    );
    process.exit(1);
  }

  const task = args[0];
  const ticketIdIndex = args.indexOf('--ticket-id');
  const ticketPathIndex = args.indexOf('--ticket-path');
  const ticketFileIndex = args.indexOf('--ticket-file');
  const timeoutIndex = args.indexOf('--timeout');
  const formatIndex = args.indexOf('--output-format');
  const reviewFlagIndex = args.indexOf('--review');
  const isReviewTicket = reviewFlagIndex !== -1;

  if (ticketIdIndex === -1 || ticketPathIndex === -1) {
    console.error('Error: --ticket-id and --ticket-path are required.');
    process.exit(1);
  }

  const ticketId = args[ticketIdIndex + 1];
  let ticketPath = args[ticketPathIndex + 1];

  if (!ticketId || ticketId.startsWith('--') || !ticketPath || ticketPath.startsWith('--')) {
    console.error('Error: --ticket-id and --ticket-path require non-empty values.');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) {
    console.error('Error: --ticket-id contains invalid characters.');
    process.exit(1);
  }
  const rawTimeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1], 10) : NaN;
  const timeout = !isNaN(rawTimeout) && rawTimeout > 0 ? rawTimeout : Defaults.WORKER_TIMEOUT_SECONDS;
  const rawFormat = formatIndex !== -1 ? args[formatIndex + 1] : undefined;
  const outputFormat = rawFormat && !rawFormat.startsWith('--') ? rawFormat : 'text';

  // Read ticket content if provided
  let ticketContent = '';
  if (ticketFileIndex !== -1) {
    const ticketFilePath = args[ticketFileIndex + 1];
    if (ticketFilePath && !ticketFilePath.startsWith('--') && fs.existsSync(ticketFilePath)) {
      ticketContent = fs.readFileSync(ticketFilePath, 'utf-8');
    }
  }

  // Normalize path
  if (
    ticketPath.endsWith('.md') ||
    (fs.existsSync(ticketPath) && fs.statSync(ticketPath).isFile())
  ) {
    ticketPath = path.dirname(ticketPath);
  }

  fs.mkdirSync(ticketPath, { recursive: true });
  const sessionLog = path.join(ticketPath, `worker_session_${process.pid}.log`);

  // --- Timeout Logic ---
  let effectiveTimeout = timeout;
  const sessionRoot = path.dirname(ticketPath);
  const parentState = path.join(sessionRoot, 'state.json');
  const workerState = path.join(ticketPath, 'state.json');

  let timeoutStatePath = null;
  if (fs.existsSync(parentState)) {
    timeoutStatePath = parentState;
  } else if (fs.existsSync(workerState)) {
    timeoutStatePath = workerState;
  }

  if (timeoutStatePath) {
    try {
      const state = JSON.parse(fs.readFileSync(timeoutStatePath, 'utf-8'));
      const maxMins = Number(state.max_time_minutes);
      const startEpoch = Number(state.start_time_epoch);

      if (Number.isFinite(maxMins) && maxMins > 0 && Number.isFinite(startEpoch) && startEpoch > 0) {
        const remaining = Math.floor(maxMins * 60 - (Math.floor(Date.now() / 1000) - startEpoch));
        if (remaining <= 0) {
          // Session wall-clock already elapsed; stop-hook will handle the limit on next turn
          console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
        } else if (remaining < effectiveTimeout) {
          effectiveTimeout = remaining;
          console.log(
            `${Style.YELLOW}⚠️  Worker timeout clamped: ${effectiveTimeout}s${Style.RESET}`
          );
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  printMinimalPanel(
    isReviewTicket ? 'Spawning Review Worker' : 'Spawning Morty Worker',
    {
      Request: task,
      Ticket: ticketId,
      Type: isReviewTicket ? 'review' : 'implementation',
      Format: outputFormat,
      Timeout: `${effectiveTimeout}s (Req: ${timeout}s)`,
      PID: process.pid,
    },
    isReviewTicket ? 'MAGENTA' : 'CYAN',
    '🥒'
  );

  const extensionRoot = getExtensionRoot();
  const includes = [extensionRoot, ticketPath];

  const cmdArgs = ['--dangerously-skip-permissions'];
  for (const p of includes) {
    if (fs.existsSync(p)) {
      cmdArgs.push('--add-dir', p);
    }
  }
  if (outputFormat !== 'text') {
    cmdArgs.push('--output-format', outputFormat);
  }

  // Prompt Construction — read the appropriate lifecycle template.
  // Review workers get send-to-morty-review.md (3-phase), implementation workers get send-to-morty.md (7-phase).
  const promptFilename = isReviewTicket ? 'send-to-morty-review.md' : 'send-to-morty.md';
  const mortyPromptPath = path.join(os.homedir(), '.claude', 'commands', promptFilename);
  let workerPrompt: string;
  if (fs.existsSync(mortyPromptPath)) {
    workerPrompt = fs.readFileSync(mortyPromptPath, 'utf-8')
      .replace(/\$ARGUMENTS/g, task);
  } else {
    // Fallback if prompt template is not installed
    workerPrompt = isReviewTicket
      ? `# **REVIEW REQUEST**\n${task}\n\nYou are a Review Worker. Review the preceding implementation tickets for correctness, architecture, and code quality.`
      : `# **TASK REQUEST**\n${task}\n\nYou are a Morty Worker (Pickle Rick's assistant). Implement the request above.`;
  }

  // Inject Ticket Context
  workerPrompt += `\n\n# TARGET TICKET CONTENT\n${ticketContent || 'N/A'}`;
  workerPrompt += `\n\n# EXECUTION CONTEXT\n- SESSION_ROOT: ${sessionRoot}\n- TICKET_ID: ${ticketId}\n- TICKET_DIR: ${ticketPath}`;
  workerPrompt +=
    '\n\n**IMPORTANT**: You are a localized worker. You are FORBIDDEN from working on ANY other tickets. Once you output `<promise>I AM DONE</promise>`, you MUST STOP and let the manager take over.';

  cmdArgs.push('-p', workerPrompt);

  // Mark ticket as In Progress so the monitor shows [~]
  try { updateTicketStatus(ticketId, 'In Progress', sessionRoot); } catch { /* best-effort */ }

  const logStream = fs.createWriteStream(sessionLog, { flags: 'w' });
  logStream.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}❌ Log stream error: ${msg}${Style.RESET}`);
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PICKLE_STATE_FILE: timeoutStatePath || workerState,
    PICKLE_ROLE: 'worker',
    PYTHONUNBUFFERED: '1',
  };
  delete env['CLAUDECODE'];

  const proc = spawn('claude', cmdArgs, {
    cwd: process.cwd(),
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  // Use { end: false } so that when stdout ends first it doesn't call
  // logStream.end(), which would discard any stderr data still in-flight.
  // logStream.end() is called explicitly in the 'close' handler.
  proc.stdout?.pipe(logStream, { end: false });
  proc.stderr?.pipe(logStream, { end: false });

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  const startTime = Date.now();

  const isTTY = process.stdout.isTTY;
  const interval = setInterval(() => {
    if (!isTTY) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinChar = spinner[idx % spinner.length];
    process.stdout.write(
      `\r   ${Style.CYAN}${spinChar}${Style.RESET} Worker Active... ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`
    );
    idx++;
  }, 100);

  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | null = null;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    console.log(`\n${Style.RED}❌ Worker timed out after ${effectiveTimeout}s${Style.RESET}`);
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    killEscalation = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 2000);
  }, effectiveTimeout * 1000);

  // Safety net: if the Promise doesn't resolve within timeout + 30s, force exit.
  const hangGuard = setTimeout(() => {
    console.error(`${Style.RED}❌ Worker hang detected — forcing exit${Style.RESET}`);
    process.exit(1);
  }, (effectiveTimeout + 30) * 1000);
  hangGuard.unref(); // Don't keep the process alive just for the guard

  return new Promise<void>((resolve) => {
    // Handle spawn failure (e.g., ENOENT when claude binary not found).
    // Without this, 'close' may never fire on some Node versions, leaving
    // the Promise unresolved until the hangGuard force-exits (~timeout+30s).
    proc.on('error', () => {
      clearInterval(interval);
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      logStream.end();
      try { updateTicketStatus(ticketId, 'Failed', sessionRoot); } catch { /* best-effort */ }
      printMinimalPanel(
        'Worker Report',
        { status: 'spawn-error', validation: 'failed' },
        'RED',
        '🥒'
      );
      process.exit(1);
    });

    proc.on('close', (code) => {
      clearInterval(interval);
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');

      let finalized = false;

      // Register finish listener BEFORE calling end() to avoid missing synchronous completion.
      // Guard against logStream.finish never firing (e.g., disk I/O failure)
      const flushTimeout = setTimeout(() => {
        console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
        finalize(code);
      }, 5000);

      logStream.on('finish', () => {
        clearTimeout(flushTimeout);
        finalize(code);
      });

      // End the write stream and wait for flush before reading the log.
      // Without this, pipe buffers may not have drained to disk yet and
      // the WORKER_DONE token could be missed — causing a false failure.
      logStream.end();

      function finalize(exitCode: number | null) {
        if (finalized) return;
        finalized = true;
        let logContent = '';
        try { logContent = fs.readFileSync(sessionLog, 'utf-8'); } catch { /* missing log */ }
        const isSuccess = !timedOut && hasToken(logContent, PromiseTokens.WORKER_DONE);

        // Update ticket frontmatter so monitor/status reflect the outcome
        if (isSuccess) {
          try { updateTicketStatus(ticketId, 'Done', sessionRoot); } catch { /* best-effort */ }
        } else {
          try { updateTicketStatus(ticketId, 'Failed', sessionRoot); } catch { /* best-effort */ }
        }

        printMinimalPanel(
          'Worker Report',
          {
            status: timedOut ? 'timeout' : `exit:${exitCode}`,
            validation: isSuccess ? 'successful' : 'failed',
          },
          isSuccess ? 'GREEN' : 'RED',
          '🥒'
        );

        if (!isSuccess) process.exit(1);
        resolve();
      }
    });
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-morty.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}${msg}${Style.RESET}`);
    process.exit(1);
  });
}
