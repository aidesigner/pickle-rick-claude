#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, drainLog } from '../services/pickle-utils.js';
function latestLog(sessionDir) {
    try {
        const logs = fs
            .readdirSync(sessionDir)
            .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
            .sort((a, b) => {
            const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
            const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
            return (numA || 0) - (numB || 0);
        });
        return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1]) : null;
    }
    catch {
        return null;
    }
}
async function main() {
    const sessionDir = process.argv[2];
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node log-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const { GREEN: g, CYAN: c, BOLD: b, DIM: d, RESET: r } = Style;
    const sep = () => `${d}${'─'.repeat(Math.min((process.stdout.columns || 60) - 2, 60))}${r}`;
    process.stdout.write(`\n${b}${g}🥒 Pickle Rick — Log Stream${r}\n${sep()}\n`);
    let currentLog = null;
    let offset = 0;
    while (true) {
        const log = latestLog(sessionDir);
        if (!log) {
            try {
                const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
                if (state.active !== true) {
                    process.stdout.write(`\n${sep()}\n${g}🥒 Session complete (no iteration logs).${r}\n`);
                    break;
                }
            }
            catch { /* ignore */ }
            process.stdout.write(`\r${d}Waiting for first iteration...${r}\x1b[K`);
            await sleep(1000);
            continue;
        }
        if (log !== currentLog) {
            currentLog = log;
            offset = 0;
            const n = path.basename(log, '.log').replace('tmux_iteration_', '');
            process.stdout.write(`\n${sep()}\n${b}${c}Iteration ${n}${r}\n${sep()}\n`);
        }
        offset = drainLog(currentLog, offset);
        try {
            const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
            if (state.active !== true) {
                await sleep(2000);
                drainLog(currentLog, offset);
                process.stdout.write(`\n${sep()}\n${g}🥒 Session complete.${r}\n`);
                break;
            }
        }
        catch {
            /* ignore */
        }
        await sleep(500);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-watcher.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${Style.RED}[log-watcher] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
