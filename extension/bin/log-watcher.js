#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style } from '../services/pickle-utils.js';
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function latestLog(sessionDir) {
    try {
        const logs = fs
            .readdirSync(sessionDir)
            .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
            .sort();
        return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1]) : null;
    }
    catch {
        return null;
    }
}
function emit(content) {
    const width = Math.min((process.stdout.columns || 80) - 2, 120);
    const lines = content.replace(ANSI, '').split('\n').filter((l) => l.trim());
    for (const line of lines) {
        process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
    }
}
const DRAIN_CHUNK = 65536; // 64 KiB — prevents large allocations on long-running sessions
function drain(logPath, offset) {
    let fd = null;
    try {
        const { size } = fs.statSync(logPath);
        if (size <= offset)
            return offset;
        fd = fs.openSync(logPath, 'r');
        let pos = offset;
        while (pos < size) {
            const toRead = Math.min(DRAIN_CHUNK, size - pos);
            const buf = Buffer.allocUnsafe(toRead);
            fs.readSync(fd, buf, 0, toRead, pos);
            emit(buf.toString('utf-8'));
            pos += toRead;
        }
        fs.closeSync(fd);
        return size;
    }
    catch {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch { /* ignore double-close */ }
        }
        return offset;
    }
}
async function main() {
    const sessionDir = process.argv[2];
    if (!sessionDir || !fs.existsSync(sessionDir)) {
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
        offset = drain(currentLog, offset);
        try {
            const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
            if (!state.active) {
                await sleep(2000);
                drain(currentLog, offset);
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
main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[log-watcher] ${msg}\n`);
    process.exit(1);
});
