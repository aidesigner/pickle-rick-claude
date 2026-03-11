#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Defaults } from '../types/index.js';
import { readMicroverseState, writeMicroverseState, recordIteration as stateRecordIteration, recordFailedApproach, isConverged, compareMetric, } from '../microverse-state.js';
import { getHeadSha, resetToSha, isWorkingTreeDirty } from '../services/git-utils.js';
import { writeStateFile, getExtensionRoot, sleep, Style, formatTime, printMinimalPanel, } from '../services/pickle-utils.js';
import { runIteration, loadRateLimitSettings, classifyIterationExit, computeRateLimitAction, } from './mux-runner.js';
import { logActivity } from '../services/activity-logger.js';
export function measureMetric(validation, timeoutSeconds, cwd) {
    try {
        const output = execSync(validation, {
            cwd,
            timeout: timeoutSeconds * 1000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const lines = output.split('\n');
        const lastLine = lines[lines.length - 1].trim();
        const score = parseFloat(lastLine);
        if (!Number.isFinite(score))
            return null;
        return { raw: output, score };
    }
    catch {
        return null;
    }
}
export function buildMicroverseHandoff(mvState, iteration, workingDir) {
    const parts = [
        `# Microverse Iteration ${iteration}`,
        '',
        `## Metric: ${mvState.key_metric.description}`,
        `- Validation: \`${mvState.key_metric.validation}\``,
        `- Baseline score: ${mvState.baseline_score}`,
        `- Current stall counter: ${mvState.convergence.stall_counter}/${mvState.convergence.stall_limit}`,
        '',
    ];
    if (mvState.gap_analysis_path) {
        parts.push(`## Gap Analysis`);
        parts.push(`See: ${mvState.gap_analysis_path}`);
        parts.push('');
    }
    const history = mvState.convergence.history;
    if (history.length > 0) {
        parts.push('## Recent Metric History');
        const recent = history.slice(-5);
        for (const entry of recent) {
            parts.push(`- Iter ${entry.iteration}: score=${entry.score} action=${entry.action} — ${entry.description}`);
        }
        parts.push('');
    }
    if (mvState.failed_approaches.length > 0) {
        parts.push('## Failed Approaches (DO NOT RETRY)');
        for (const approach of mvState.failed_approaches) {
            parts.push(`- ${approach}`);
        }
        parts.push('');
    }
    parts.push(`## PRD: ${mvState.prd_path}`);
    parts.push(`## Working Directory: ${workingDir}`);
    parts.push('');
    parts.push('Focus on improving the metric. Make targeted changes and commit.');
    return parts.join('\n');
}
function writeFinalReport(sessionDir, mvState, exitReason, iterations, elapsedSeconds) {
    const history = mvState.convergence.history;
    const accepted = history.filter(h => h.action === 'accept').length;
    const reverted = history.filter(h => h.action === 'revert').length;
    const bestScore = history.length > 0
        ? Math.max(...history.filter(h => h.action === 'accept').map(h => h.score), mvState.baseline_score)
        : mvState.baseline_score;
    const report = [
        `# Microverse Final Report`,
        '',
        `- **Exit Reason**: ${exitReason}`,
        `- **Iterations**: ${iterations}`,
        `- **Elapsed**: ${formatTime(elapsedSeconds)}`,
        `- **Metric**: ${mvState.key_metric.description}`,
        `- **Baseline Score**: ${mvState.baseline_score}`,
        `- **Best Score**: ${bestScore}`,
        `- **Accepted**: ${accepted}`,
        `- **Reverted**: ${reverted}`,
        `- **Failed Approaches**: ${mvState.failed_approaches.length}`,
        '',
        '## Iteration History',
        '| Iter | Score | Action | Description |',
        '|------|-------|--------|-------------|',
        ...history.map(h => `| ${h.iteration} | ${h.score} | ${h.action} | ${h.description} |`),
        '',
    ].join('\n');
    const memoryDir = path.join(sessionDir, 'memory');
    try {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    catch { /* exists */ }
    const reportPath = path.join(memoryDir, `microverse_report_${new Date().toISOString().split('T')[0]}.md`);
    fs.writeFileSync(reportPath, report);
}
export async function main(sessionDir) {
    const extensionRoot = getExtensionRoot();
    const statePath = path.join(sessionDir, 'state.json');
    const runnerLog = path.join(sessionDir, 'microverse-runner.log');
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        process.stderr.write(line);
    };
    log('microverse-runner started');
    // Read initial state
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read state.json: ${msg}`);
    }
    const mvState = readMicroverseState(sessionDir);
    if (!mvState) {
        throw new Error('microverse.json not found — run setup first');
    }
    const workingDir = state.working_dir || process.cwd();
    // Pre-flight: dirty tree check
    if (isWorkingTreeDirty(workingDir)) {
        log('ERROR: Working tree is dirty. Aborting (tmux mode — no interactive prompt).');
        throw new Error('Working tree is dirty — stash or commit changes first');
    }
    // Ensure tmux_mode and command_template
    state.tmux_mode = true;
    state.command_template = 'microverse.md';
    if (!state.active)
        state.active = true;
    writeStateFile(statePath, state);
    // Signal handlers
    const handleShutdownSignal = (signal) => {
        log(`Received ${signal} — deactivating session`);
        try {
            const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            s.active = false;
            writeStateFile(statePath, s);
        }
        catch {
            try {
                writeStateFile(statePath, { active: false });
            }
            catch { /* nothing we can do */ }
        }
        const finalMv = readMicroverseState(sessionDir);
        if (finalMv) {
            finalMv.status = 'stopped';
            finalMv.exit_reason = 'signal';
            writeMicroverseState(sessionDir, finalMv);
        }
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux' });
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
    // Rate limit settings
    const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);
    const startTime = Date.now();
    let iteration = 0;
    let consecutiveRateLimits = 0;
    let exitReason = 'error';
    let currentMv = { ...mvState };
    // --- Gap Analysis Phase ---
    if (currentMv.status === 'gap_analysis') {
        log('Starting gap analysis phase');
        iteration++;
        // Write gap analysis handoff
        const handoffContent = buildMicroverseHandoff(currentMv, iteration, workingDir);
        fs.writeFileSync(path.join(sessionDir, 'handoff.txt'), handoffContent);
        state.iteration = iteration;
        writeStateFile(statePath, state);
        const result = await runIteration(sessionDir, iteration, extensionRoot, '');
        if (result === 'error' || result === 'inactive') {
            log(`Gap analysis failed: ${result}`);
            currentMv.status = 'stopped';
            currentMv.exit_reason = 'error';
            writeMicroverseState(sessionDir, currentMv);
            exitReason = 'error';
            state.active = false;
            writeStateFile(statePath, state);
            writeFinalReport(sessionDir, currentMv, exitReason, iteration, Math.floor((Date.now() - startTime) / 1000));
            process.exit(1);
        }
        // Measure baseline
        if (currentMv.key_metric.type === 'command') {
            const baseline = measureMetric(currentMv.key_metric.validation, currentMv.key_metric.timeout_seconds, workingDir);
            if (baseline) {
                currentMv.baseline_score = baseline.score;
                log(`Baseline metric: ${baseline.score} (raw: ${baseline.raw})`);
            }
            else {
                log('WARNING: Could not measure baseline metric — defaulting to 0');
            }
        }
        currentMv.status = 'iterating';
        writeMicroverseState(sessionDir, currentMv);
        log('Gap analysis complete — transitioning to iterating');
    }
    // --- Main Iteration Loop ---
    while (currentMv.status === 'iterating') {
        // Re-read state for external changes
        try {
            state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
            exitReason = 'error';
            break;
        }
        if (state.active !== true) {
            log('Session inactive. Exiting.');
            exitReason = 'stopped';
            break;
        }
        // Check max_iterations
        const rawMaxIter = Number(state.max_iterations);
        const maxIter = Number.isFinite(rawMaxIter) ? rawMaxIter : 0;
        if (maxIter > 0 && iteration >= maxIter) {
            log(`Max iterations reached (${iteration}/${maxIter}). Exiting.`);
            exitReason = 'limit_reached';
            break;
        }
        // Check max_time_minutes
        const rawStartEpoch = Number(state.start_time_epoch);
        const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
        const rawMaxTimeMins = Number(state.max_time_minutes);
        const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
        const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
        if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
            log(`Time limit reached (${elapsed}s). Exiting.`);
            exitReason = 'limit_reached';
            break;
        }
        iteration++;
        log(`--- Iteration ${iteration} ---`);
        logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration });
        // Record pre-iteration SHA
        const preIterSha = getHeadSha(workingDir);
        // Write microverse-specific handoff
        const handoffContent = buildMicroverseHandoff(currentMv, iteration, workingDir);
        fs.writeFileSync(path.join(sessionDir, 'handoff.txt'), handoffContent);
        state.iteration = iteration;
        writeStateFile(statePath, state);
        // Run iteration
        const result = await runIteration(sessionDir, iteration, extensionRoot, '');
        const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
        // Rate limit check
        const exitResult = classifyIterationExit(result, iterLogFile);
        logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitResult.type });
        if (exitResult.type === 'api_limit') {
            consecutiveRateLimits++;
            log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
            const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes);
            if (rlAction.action === 'bail') {
                exitReason = 'rate_limit_exhausted';
                logActivity({ event: 'rate_limit_exhausted', source: 'pickle', session: path.basename(sessionDir), error: `max retries exceeded` });
                break;
            }
            const { waitMs, waitSource } = rlAction;
            log(`Rate limit wait: ${Math.ceil(waitMs / 60_000)}min (source: ${waitSource})`);
            writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
                waiting: true, reason: 'API rate limit',
                started_at: new Date().toISOString(),
                wait_until: new Date(Date.now() + waitMs).toISOString(),
                consecutive_waits: consecutiveRateLimits,
            });
            // Cancellable sleep
            const waitEnd = Date.now() + waitMs;
            while (Date.now() < waitEnd) {
                await sleep(Defaults.RATE_LIMIT_POLL_MS);
                try {
                    const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                    if (ws.active !== true) {
                        exitReason = 'stopped';
                        break;
                    }
                }
                catch { /* proceed */ }
            }
            if (exitReason === 'stopped')
                break;
            try {
                fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json'));
            }
            catch { /* ok */ }
            if (rlAction.resetCounter)
                consecutiveRateLimits = 0;
            logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) });
            continue;
        }
        if (exitResult.type === 'success')
            consecutiveRateLimits = 0;
        if (result === 'error') {
            log('Subprocess error. Exiting loop.');
            exitReason = 'error';
            break;
        }
        if (result === 'inactive') {
            log('Session deactivated. Exiting loop.');
            exitReason = 'stopped';
            break;
        }
        // Check if HEAD advanced (agent made commits)
        const postIterSha = getHeadSha(workingDir);
        if (postIterSha === preIterSha) {
            log('No commits made — stall (no rollback)');
            currentMv.convergence.stall_counter++;
            writeMicroverseState(sessionDir, currentMv);
            if (isConverged(currentMv)) {
                log('Converged (stall limit reached with no new commits)');
                exitReason = 'converged';
                break;
            }
            await sleep(1000);
            continue;
        }
        // Measure metric
        let metricResult = null;
        if (currentMv.key_metric.type === 'command') {
            metricResult = measureMetric(currentMv.key_metric.validation, currentMv.key_metric.timeout_seconds, workingDir);
        }
        if (!metricResult) {
            log('WARNING: Could not measure metric — treating as stall');
            currentMv.convergence.stall_counter++;
            writeMicroverseState(sessionDir, currentMv);
            if (isConverged(currentMv)) {
                log('Converged (stall limit reached — metric unmeasurable)');
                exitReason = 'converged';
                break;
            }
            await sleep(1000);
            continue;
        }
        log(`Metric: ${metricResult.score} (raw: ${metricResult.raw})`);
        // Compare with previous
        const previousScore = currentMv.convergence.history.length > 0
            ? currentMv.convergence.history[currentMv.convergence.history.length - 1].score
            : currentMv.baseline_score;
        const classification = compareMetric(metricResult.score, previousScore, currentMv.key_metric.tolerance);
        log(`Classification: ${classification} (previous=${previousScore}, tolerance=${currentMv.key_metric.tolerance})`);
        const entry = {
            iteration,
            metric_value: metricResult.raw,
            score: metricResult.score,
            action: classification === 'regressed' ? 'revert' : 'accept',
            description: `${classification}: ${metricResult.score} vs ${previousScore}`,
            pre_iteration_sha: preIterSha,
            timestamp: new Date().toISOString(),
        };
        if (classification === 'regressed') {
            log(`Regression detected — rolling back to ${preIterSha}`);
            resetToSha(preIterSha, workingDir);
            currentMv = recordFailedApproach(currentMv, `Iteration ${iteration}: score dropped from ${previousScore} to ${metricResult.score}`);
        }
        currentMv = stateRecordIteration(currentMv, entry);
        writeMicroverseState(sessionDir, currentMv);
        if (isConverged(currentMv)) {
            log(`Converged after ${iteration} iterations (stall_counter=${currentMv.convergence.stall_counter})`);
            exitReason = 'converged';
            break;
        }
        await sleep(1000);
    }
    // --- Finalize ---
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    currentMv.status = exitReason === 'converged' ? 'converged' : 'stopped';
    currentMv.exit_reason = exitReason;
    writeMicroverseState(sessionDir, currentMv);
    state.active = false;
    writeStateFile(statePath, state);
    writeFinalReport(sessionDir, currentMv, exitReason, iteration, totalElapsed);
    logActivity({
        event: 'session_end', source: 'pickle',
        session: path.basename(sessionDir),
        duration_min: Math.round(totalElapsed / 60),
        mode: 'tmux',
        ...(exitReason === 'error' || exitReason === 'rate_limit_exhausted' ? { error: exitReason } : {}),
    });
    printMinimalPanel('microverse-runner Complete', {
        Iterations: iteration,
        Elapsed: formatTime(totalElapsed),
        ExitReason: exitReason,
        BestScore: currentMv.convergence.history.length > 0
            ? Math.max(...currentMv.convergence.history.filter(h => h.action === 'accept').map(h => h.score), currentMv.baseline_score)
            : currentMv.baseline_score,
    }, 'GREEN', '🔬');
    log(`microverse-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}, exit: ${exitReason}`);
    const exitCode = (exitReason === 'converged' || exitReason === 'stopped' || exitReason === 'limit_reached') ? 0 : 1;
    process.exit(exitCode);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'microverse-runner.js') {
    const sessionDir = process.argv[2];
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
        console.error('Usage: node microverse-runner.js <session-dir>');
        process.exit(1);
    }
    main(sessionDir).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
        // Best-effort state deactivation
        try {
            const statePath = path.join(sessionDir, 'state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            state.active = false;
            writeStateFile(statePath, state);
        }
        catch { /* best effort */ }
        try {
            const mvPath = path.join(sessionDir, 'microverse.json');
            if (fs.existsSync(mvPath)) {
                const mv = JSON.parse(fs.readFileSync(mvPath, 'utf-8'));
                mv.status = 'stopped';
                mv.exit_reason = 'error';
                writeStateFile(mvPath, mv);
            }
        }
        catch { /* best effort */ }
        process.exit(1);
    });
}
