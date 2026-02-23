#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, } from '../services/pickle-utils.js';
import { spawn } from 'child_process';
import { PromiseTokens, hasToken } from '../types/index.js';
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.log('Usage: node spawn-morty.js <task> --ticket-id <id> --ticket-path <path> [--timeout <sec>] [--output-format <fmt>]');
        process.exit(1);
    }
    const task = args[0];
    const ticketIdIndex = args.indexOf('--ticket-id');
    const ticketPathIndex = args.indexOf('--ticket-path');
    const ticketFileIndex = args.indexOf('--ticket-file');
    const timeoutIndex = args.indexOf('--timeout');
    const formatIndex = args.indexOf('--output-format');
    if (ticketIdIndex === -1 || ticketPathIndex === -1) {
        console.log('Error: --ticket-id and --ticket-path are required.');
        process.exit(1);
    }
    const ticketId = args[ticketIdIndex + 1];
    let ticketPath = args[ticketPathIndex + 1];
    if (!ticketId || ticketId.startsWith('--') || !ticketPath || ticketPath.startsWith('--')) {
        console.log('Error: --ticket-id and --ticket-path require non-empty values.');
        process.exit(1);
    }
    const rawTimeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1], 10) : NaN;
    const timeout = !isNaN(rawTimeout) && rawTimeout > 0 ? rawTimeout : 1200;
    const outputFormat = formatIndex !== -1 ? args[formatIndex + 1] : 'text';
    // Read ticket content if provided
    let ticketContent = '';
    if (ticketFileIndex !== -1) {
        const ticketFilePath = args[ticketFileIndex + 1];
        if (fs.existsSync(ticketFilePath)) {
            ticketContent = fs.readFileSync(ticketFilePath, 'utf-8');
        }
    }
    // Normalize path
    if (ticketPath.endsWith('.md') ||
        (fs.existsSync(ticketPath) && fs.statSync(ticketPath).isFile())) {
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
    }
    else if (fs.existsSync(workerState)) {
        timeoutStatePath = workerState;
    }
    if (timeoutStatePath) {
        try {
            const state = JSON.parse(fs.readFileSync(timeoutStatePath, 'utf-8'));
            const maxMins = state.max_time_minutes || 0;
            const startEpoch = state.start_time_epoch || 0;
            if (maxMins > 0 && startEpoch > 0) {
                const remaining = Math.floor(maxMins * 60 - (Math.floor(Date.now() / 1000) - startEpoch));
                if (remaining <= 0) {
                    // Session wall-clock already elapsed; stop-hook will handle the limit on next turn
                    console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
                }
                else if (remaining < effectiveTimeout) {
                    effectiveTimeout = remaining;
                    console.log(`${Style.YELLOW}⚠️  Worker timeout clamped: ${effectiveTimeout}s${Style.RESET}`);
                }
            }
        }
        catch (e) {
            // Ignore
        }
    }
    printMinimalPanel('Spawning Morty Worker', {
        Request: task,
        Ticket: ticketId,
        Format: outputFormat,
        Timeout: `${effectiveTimeout}s (Req: ${timeout}s)`,
        PID: process.pid,
    }, 'CYAN', '🥒');
    const extensionRoot = getExtensionRoot();
    const includes = [extensionRoot, path.join(extensionRoot, 'skills'), ticketPath];
    const cmdArgs = ['-s', '-y'];
    for (const p of includes) {
        if (fs.existsSync(p)) {
            cmdArgs.push('--include-directories', p);
        }
    }
    if (outputFormat !== 'text') {
        cmdArgs.push('-o', outputFormat);
    }
    // Prompt Construction — the /send-to-morty.md slash command is loaded by
    // Claude Code's own command system, not parsed here. Workers spawned via
    // `claude -p` get a self-contained prompt with all necessary instructions.
    let workerPrompt = `# **TASK REQUEST**\n${task}\n\nYou are a Morty Worker (Pickle Rick's assistant). Implement the request above.`;
    // Inject Ticket Context
    workerPrompt += `\n\n# TARGET TICKET CONTENT\n${ticketContent || 'N/A'}`;
    workerPrompt += `\n\n# EXECUTION CONTEXT\n- SESSION_ROOT: ${sessionRoot}\n- TICKET_ID: ${ticketId}\n- TICKET_DIR: ${ticketPath}`;
    workerPrompt +=
        '\n\n**IMPORTANT**: You are a localized worker. You are FORBIDDEN from working on ANY other tickets. Once you output `<promise>I AM DONE</promise>`, you MUST STOP and let the manager take over.';
    cmdArgs.push('-p', workerPrompt);
    const logStream = fs.createWriteStream(sessionLog, { flags: 'w' });
    const env = {
        ...process.env,
        PICKLE_STATE_FILE: timeoutStatePath || workerState,
        PICKLE_ROLE: 'worker',
        PYTHONUNBUFFERED: '1',
    };
    const proc = spawn('claude', cmdArgs, {
        cwd: process.cwd(),
        env,
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let idx = 0;
    const startTime = Date.now();
    const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const spinChar = spinner[idx % spinner.length];
        process.stdout.write(`\r   ${Style.CYAN}${spinChar}${Style.RESET} Worker Active... ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`);
        idx++;
    }, 100);
    const timeoutHandle = setTimeout(() => {
        proc.kill();
        console.log(`\n${Style.RED}❌ Worker timed out after ${effectiveTimeout}s${Style.RESET}`);
    }, effectiveTimeout * 1000);
    return new Promise((resolve) => {
        proc.on('close', (code) => {
            clearInterval(interval);
            clearTimeout(timeoutHandle);
            process.stdout.write('\r\x1b[K');
            // End the write stream and wait for flush before reading the log.
            // Without this, pipe buffers may not have drained to disk yet and
            // the WORKER_DONE token could be missed — causing a false failure.
            logStream.end();
            logStream.on('finish', () => {
                const logContent = fs.readFileSync(sessionLog, 'utf-8');
                const isSuccess = hasToken(logContent, PromiseTokens.WORKER_DONE);
                printMinimalPanel('Worker Report', {
                    status: `exit:${code}`,
                    validation: isSuccess ? 'successful' : 'failed',
                }, isSuccess ? 'GREEN' : 'RED', '🥒');
                if (!isSuccess)
                    process.exit(1);
                resolve();
            });
        });
    });
}
main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}${msg}${Style.RESET}`);
    process.exit(1);
});
