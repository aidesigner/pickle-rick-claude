#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { Style } from '../services/pickle-utils.js';
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function discoverWorkerLogs(sessionDir) {
    try {
        const entries = [];
        for (const dir of fs.readdirSync(sessionDir)) {
            const dirPath = path.join(sessionDir, dir);
            let stat;
            try {
                stat = fs.lstatSync(dirPath);
            }
            catch {
                continue;
            }
            if (!stat.isDirectory())
                continue;
            try {
                for (const file of fs.readdirSync(dirPath)) {
                    if (file.startsWith('worker_session_') && file.endsWith('.log')) {
                        const logPath = path.join(dirPath, file);
                        let logStat;
                        try {
                            logStat = fs.lstatSync(logPath);
                        }
                        catch {
                            continue;
                        }
                        if (!logStat.isFile())
                            continue;
                        entries.push({ ticketId: dir, logPath, mtimeMs: logStat.mtimeMs });
                    }
                }
            }
            catch {
                continue;
            }
        }
        return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.logPath.localeCompare(b.logPath));
    }
    catch {
        return [];
    }
}
function emit(content) {
    const width = Math.min((process.stdout.columns || 80) - 2, 120);
    const lines = content.replace(ANSI, '').split('\n').filter((l) => l.trim());
    for (const line of lines) {
        process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
    }
}
const DRAIN_CHUNK = 65536; // 64 KiB
function drain(logPath, offset) {
    let fd = null;
    try {
        const { size } = fs.statSync(logPath);
        if (size <= offset)
            return offset;
        fd = fs.openSync(logPath, 'r');
        const decoder = new StringDecoder('utf-8');
        let pos = offset;
        while (pos < size) {
            const toRead = Math.min(DRAIN_CHUNK, size - pos);
            const buf = Buffer.allocUnsafe(toRead);
            const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
            if (bytesRead === 0)
                break; // EOF — file was truncated
            emit(decoder.write(buf.subarray(0, bytesRead)));
            pos += bytesRead;
        }
        const trailing = decoder.end();
        if (trailing)
            emit(trailing);
        fs.closeSync(fd);
        return pos;
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
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node morty-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const { GREEN: g, YELLOW: y, CYAN: c, BOLD: b, DIM: d, RESET: r } = Style;
    const sep = () => `${d}${'─'.repeat(Math.min((process.stdout.columns || 60) - 2, 60))}${r}`;
    process.stdout.write(`\n${b}${y}🥒 Pickle Rick — Worker Logs${r}\n${sep()}\n`);
    let currentLog = null;
    let currentTicket = null;
    let offset = 0;
    while (true) {
        const logs = discoverWorkerLogs(sessionDir);
        if (logs.length === 0) {
            try {
                const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
                if (state.active !== true) {
                    process.stdout.write(`\n${sep()}\n${g}🥒 Session complete (no worker logs).${r}\n`);
                    break;
                }
            }
            catch { /* ignore */ }
            process.stdout.write(`\r${d}Waiting for first worker log...${r}\x1b[K`);
            await sleep(1000);
            continue;
        }
        const latest = logs[logs.length - 1];
        if (latest.logPath !== currentLog) {
            const isNewTicket = latest.ticketId !== currentTicket;
            currentLog = latest.logPath;
            currentTicket = latest.ticketId;
            offset = 0;
            if (isNewTicket) {
                process.stdout.write(`\n${sep()}\n${b}${c}Ticket: ${latest.ticketId}${r}\n${sep()}\n`);
            }
            else {
                const pid = path.basename(latest.logPath, '.log').replace('worker_session_', '');
                process.stdout.write(`\n${sep()}\n${b}${y}Worker Retry (PID ${pid})${r}\n${sep()}\n`);
            }
        }
        offset = drain(currentLog, offset);
        try {
            const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
            if (state.active !== true) {
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
if (process.argv[1] && path.basename(process.argv[1]) === 'morty-watcher.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[morty-watcher] ${msg}\n`);
        process.exit(1);
    });
}
