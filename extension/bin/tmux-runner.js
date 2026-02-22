#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, buildHandoffSummary } from '../services/pickle-utils.js';

async function runIteration(sessionDir, iterationNum, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

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
    } else {
        managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir);
    }

    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let maxTurns = 50;
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        maxTurns = settings.default_tmux_max_turns || settings.default_manager_max_turns || 50;
    } catch { /* use default */ }

    const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
    const cmdArgs = [
        '--dangerously-skip-permissions',
        '--add-dir', sessionDir,
        '--no-session-persistence',
        '--max-turns', String(maxTurns),
        '-p', managerPrompt,
    ];

    const env = { ...process.env, PICKLE_STATE_FILE: statePath };
    delete env.CLAUDECODE;

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
            const output = fs.readFileSync(logFile, 'utf-8');
            if (output.includes('<promise>EPIC_COMPLETED</promise>') ||
                output.includes('<promise>TASK_COMPLETED</promise>')) {
                resolve('completed');
            } else {
                resolve('continue');
            }
        });

        proc.on('error', (err) => {
            console.error(`${Style.RED}Failed to spawn claude: ${err.message}${Style.RESET}`);
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

    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        console.log(msg);
    };

    log('tmux-runner started');
    const startTime = Date.now();
    let iteration = 0;
    let lastStateIteration = -1;
    let stallCount = 0;

    while (true) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

        if (!state.active) {
            log('Session inactive. Exiting.');
            break;
        }

        if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
            log(`Max iterations reached (${state.iteration}/${state.max_iterations}). Exiting.`);
            break;
        }

        const elapsed = Math.floor(Date.now() / 1000) - state.start_time_epoch;
        if (state.max_time_minutes > 0 && elapsed >= state.max_time_minutes * 60) {
            log(`Time limit reached (${elapsed}s). Exiting.`);
            break;
        }

        // Stall detection: if state.iteration hasn't advanced in 3 outer-loop iterations,
        // something is broken (stop hook not firing, subprocess crashing, etc.)
        if (state.iteration === lastStateIteration) {
            stallCount++;
            if (stallCount >= 3) {
                log(`WARNING: state.iteration has not advanced in 3 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
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
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    printMinimalPanel('tmux-runner Complete', {
        Iterations: iteration,
        Elapsed: formatTime(totalElapsed),
        FinalPhase: finalState.step || 'unknown',
        Active: String(finalState.active),
    }, 'GREEN', '🥒');

    log(`tmux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);
}

main().catch((err) => {
    console.error(`${Style.RED}[FATAL] ${err.message}${Style.RESET}`);
    process.exit(1);
});
