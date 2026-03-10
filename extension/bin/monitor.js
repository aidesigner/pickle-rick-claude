#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { collectTickets, statusSymbol, formatTime, getWidth, Style, sleep, MatrixStyle, matrixSeparator, latestIterationLog } from '../services/pickle-utils.js';
/**
 * Extracts a short readable summary from a stream-json log line.
 * Returns the original line (sans ANSI) if it's not valid JSON.
 */
export function summarizeLine(raw) {
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!clean)
        return '';
    let parsed;
    try {
        parsed = JSON.parse(clean);
    }
    catch {
        return clean;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return clean;
    const type = parsed.type;
    if (type === 'assistant') {
        const msg = parsed.message;
        if (!msg || !Array.isArray(msg.content))
            return '';
        const parts = [];
        for (const block of msg.content) {
            if (typeof block !== 'object' || block === null)
                continue;
            const b = block;
            if (b.type === 'text' && typeof b.text === 'string') {
                const first = b.text.split('\n')[0].trim();
                if (first)
                    parts.push(first);
            }
            else if (b.type === 'tool_use' && typeof b.name === 'string') {
                parts.push(`🔧 ${b.name}`);
            }
        }
        return parts.join(' | ') || '';
    }
    if (type === 'result') {
        const isError = typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error');
        return isError ? `❌ ${parsed.subtype}` : '✅ success';
    }
    if (type === 'system' && parsed.subtype === 'init') {
        return `🚀 init (${typeof parsed.model === 'string' ? parsed.model : 'unknown'})`;
    }
    return '';
}
const MX = MatrixStyle;
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
        process.stdout.write(`\x1b[2J\x1b[H${MX.DIM}Awaiting signal...${MX.R}\n`);
        return true;
    }
    const width = getWidth();
    const sep = matrixSeparator(width);
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
        ['Project', `${MX.BRIGHT}${project}${MX.R}`],
        ['Task', `${MX.GREEN}${taskDisplay}${MX.R}`],
        ['Phase', `${MX.CYAN}${state.step || 'unknown'}${MX.R}`],
        ['Iteration', `${MX.GREEN}${iterStr}${MX.R}`],
        ['Elapsed', `${MX.GREEN}${timeStr}${MX.R}`],
        ['Current', state.current_ticket ? `${MX.BRIGHT}${state.current_ticket}${MX.R}` : `${MX.DIM}none${MX.R}`],
        ['Active', state.active === true ? `${MX.BRIGHT}▣ ONLINE${MX.R}` : `${MX.ERR}▢ OFFLINE${MX.R}`],
    ];
    try {
        const cbRaw = fs.readFileSync(path.join(sessionDir, 'circuit_breaker.json'), 'utf-8');
        const cb = JSON.parse(cbRaw);
        if (cb.state === 'CLOSED') {
            fields.push(['Circuit', `${MX.GREEN}CLOSED${MX.R}`]);
        }
        else if (cb.state === 'HALF_OPEN') {
            fields.push(['Circuit', `${MX.WARN}HALF_OPEN (${cb.reason || ''})${MX.R}`]);
        }
        else if (cb.state === 'OPEN') {
            fields.push(['Circuit', `${MX.ERR}OPEN (${cb.reason || ''})${MX.R}`]);
        }
    }
    catch {
        // circuit_breaker.json missing or corrupt — skip field
    }
    // Rate limit wait display
    try {
        const waitPath = path.join(sessionDir, 'rate_limit_wait.json');
        const waitData = JSON.parse(fs.readFileSync(waitPath, 'utf-8'));
        if (waitData.waiting === true && waitData.wait_until) {
            const remainMs = new Date(waitData.wait_until).getTime() - Date.now();
            const typeLabel = waitData.rate_limit_type ? ` [${waitData.rate_limit_type}]` : '';
            const sourceLabel = waitData.wait_source === 'api' ? ' (API reset)' : '';
            if (remainMs > 0) {
                const remainSec = Math.ceil(remainMs / 1000);
                fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limited${typeLabel}${sourceLabel} (${formatTime(remainSec)} remaining)${MX.R}`]);
            }
            else {
                fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limit wait ending...${MX.R}`]);
            }
        }
    }
    catch { /* no wait state */ }
    const keyWidth = Math.max(...fields.map(([k]) => k.length)) + 1;
    const out = ['\x1b[2J\x1b[H'];
    out.push(`\n${MX.BRIGHT}◤ PICKLE RICK — LIVE MONITOR ◢${MX.R}\n`);
    out.push(`${sep}\n`);
    for (const [k, v] of fields) {
        out.push(`  ${MX.DIM}${k + ':'}${' '.repeat(keyWidth - k.length)}${MX.R} ${v}\n`);
    }
    if (tickets.length > 0) {
        out.push(`\n${sep}\n${MX.BRIGHT}Tickets:${MX.R}\n`);
        for (const ticket of tickets) {
            const status = (ticket.status || '').toLowerCase();
            const sym = statusSymbol(ticket.status);
            const coloredSym = status === 'done'
                ? `${MX.GREEN}${sym}${MX.R}`
                : status === 'in progress'
                    ? `${MX.WARN}${sym}${MX.R}`
                    : `${MX.DIM}${sym}${MX.R}`;
            const isCurrent = ticket.id === state.current_ticket;
            const prefix = isCurrent ? `${MX.BRIGHT}▸${MX.R}` : ' ';
            const titleStr = isCurrent ? `${MX.BRIGHT}${ticket.title}${MX.R}` : `${MX.GREEN}${ticket.title || ''}${MX.R}`;
            out.push(`${prefix} ${coloredSym} ${MX.DIM}${ticket.id}:${MX.R} ${titleStr}\n`);
        }
    }
    try {
        const logPath = latestIterationLog(sessionDir);
        if (logPath) {
            // Read only the tail of the file (last 64KB) instead of the entire log,
            // which can grow to multi-MB during long sessions. 64KB is more than
            // enough to capture the last 10 NDJSON lines.
            const TAIL_BYTES = 65536;
            const { size } = fs.statSync(logPath);
            const readStart = Math.max(0, size - TAIL_BYTES);
            let tail;
            if (readStart === 0) {
                tail = fs.readFileSync(logPath, 'utf-8');
            }
            else {
                const buf = Buffer.allocUnsafe(size - readStart);
                const fd = fs.openSync(logPath, 'r');
                try {
                    fs.readSync(fd, buf, 0, buf.length, readStart);
                }
                finally {
                    fs.closeSync(fd);
                }
                // Drop first partial line from mid-file read
                const raw = buf.toString('utf-8');
                const firstNewline = raw.indexOf('\n');
                tail = firstNewline !== -1 ? raw.slice(firstNewline + 1) : raw;
            }
            const summaryLines = tail
                .split('\n')
                .filter((l) => l.trim())
                .slice(-10)
                .map(summarizeLine)
                .filter((l) => l.length > 0)
                .slice(-5);
            if (summaryLines.length > 0) {
                out.push(`\n${sep}\n${MX.DIM}Recent output:${MX.R}\n`);
                for (const logLine of summaryLines) {
                    const truncated = logLine.length > width - 2 ? logLine.slice(0, width - 5) + '…' : logLine;
                    out.push(`${MX.GREEN}  ${truncated}${MX.R}\n`);
                }
            }
        }
    }
    catch {
        /* ignore */
    }
    out.push(`\n${MX.DIM}Refreshing every 2s  •  Ctrl+C to detach${MX.R}\n`);
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
        process.stdout.write(`\x1b[2J\x1b[H${MX.DIM}Monitor detached.${MX.R}\n`);
        process.exit(0);
    });
    while (true) {
        const active = render(sessionDir);
        if (!active) {
            await sleep(3000);
            const stillInactive = !render(sessionDir);
            if (stillInactive) {
                process.stdout.write(`\n${MX.BRIGHT}◤ SESSION COMPLETE ◢${MX.R}\n`);
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
