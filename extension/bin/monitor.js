#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { collectTickets, statusSymbol, formatTime, getWidth, Style, sleep } from '../services/pickle-utils.js';
function render(sessionDir) {
    // If the session directory itself is gone, signal exit (not just "waiting")
    if (!fs.existsSync(sessionDir))
        return false;
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch {
        process.stdout.write('\x1b[2J\x1b[H⏳ Waiting for session...\n');
        return true;
    }
    const { GREEN: g, RED: red, YELLOW: y, BOLD: b, DIM: d, RESET: r } = Style;
    const width = getWidth();
    const sep = `${d}${'─'.repeat(width)}${r}`;
    const startEpoch = Number(state.start_time_epoch) || 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    const tickets = collectTickets(sessionDir);
    const maxIter = Number(state.max_iterations) || 0;
    const maxTime = Number(state.max_time_minutes) || 0;
    const iterStr = maxIter > 0
        ? `${state.iteration} / ${state.max_iterations}`
        : `${state.iteration}`;
    const timeStr = maxTime > 0
        ? `${formatTime(elapsed)} / ${state.max_time_minutes}m`
        : formatTime(elapsed);
    const workDir = state.working_dir || '';
    const project = workDir ? path.basename(workDir) : 'unknown';
    const task = state.original_prompt || '';
    const taskDisplay = task.length > width - 20 ? task.slice(0, width - 23) + '…' : (task || 'none');
    const fields = [
        ['Project', `${b}${project}${r}`],
        ['Task', taskDisplay],
        ['Phase', state.step || 'unknown'],
        ['Iteration', iterStr],
        ['Elapsed', timeStr],
        ['Current Ticket', state.current_ticket || 'none'],
        ['Active', state.active === true ? `${g}Yes${r}` : `${red}No${r}`],
    ];
    const keyWidth = Math.max(...fields.map(([k]) => k.length)) + 1;
    const out = ['\x1b[2J\x1b[H'];
    out.push(`\n${b}${g}🥒 Pickle Rick — Live Monitor${r}\n`);
    out.push(`${sep}\n`);
    for (const [k, v] of fields) {
        out.push(`  ${d}${k + ':'}${' '.repeat(keyWidth - k.length)}${r} ${v}\n`);
    }
    if (tickets.length > 0) {
        out.push(`\n${sep}\n${b}Tickets:${r}\n`);
        for (const ticket of tickets) {
            const status = (ticket.status || '').toLowerCase();
            const sym = statusSymbol(ticket.status);
            const coloredSym = status === 'done'
                ? `${g}${sym}${r}`
                : status === 'in progress'
                    ? `${y}${sym}${r}`
                    : sym;
            const isCurrent = ticket.id === state.current_ticket;
            const prefix = isCurrent ? `${y}▶${r}` : ' ';
            const titleStr = isCurrent ? `${b}${ticket.title}${r}` : ticket.title || '';
            out.push(`${prefix} ${coloredSym} ${ticket.id}: ${titleStr}\n`);
        }
    }
    try {
        const logs = fs
            .readdirSync(sessionDir)
            .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
            .sort((a, b) => {
            const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
            const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
            return (numA || 0) - (numB || 0);
        });
        if (logs.length > 0) {
            const latestLog = fs.readFileSync(path.join(sessionDir, logs[logs.length - 1]), 'utf-8');
            const cleanLines = latestLog
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .split('\n')
                .filter((l) => l.trim())
                .slice(-5);
            if (cleanLines.length > 0) {
                out.push(`\n${sep}\n${d}Recent output:${r}\n`);
                for (const logLine of cleanLines) {
                    const truncated = logLine.length > width - 2 ? logLine.slice(0, width - 5) + '…' : logLine;
                    out.push(`${d}  ${truncated}${r}\n`);
                }
            }
        }
    }
    catch {
        /* ignore */
    }
    out.push(`\n${d}Refreshing every 2s  •  Ctrl+C to detach${r}\n`);
    process.stdout.write(out.join(''));
    return state.active === true;
}
async function main() {
    const sessionDir = process.argv[2];
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node monitor.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\x1b[2J\x1b[HMonitor detached.\n');
        process.exit(0);
    });
    while (true) {
        const active = render(sessionDir);
        if (!active) {
            await sleep(3000);
            const stillInactive = !render(sessionDir);
            if (stillInactive) {
                process.stdout.write('\n🥒 Session complete. Monitor exiting.\n');
                break;
            }
        }
        await sleep(2000);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'monitor.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${Style.RED}[monitor] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
