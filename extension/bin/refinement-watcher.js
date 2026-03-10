#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, formatTime, drainStreamJsonLines } from '../services/pickle-utils.js';
import { processLine } from './log-watcher.js';
const ROLES = ['requirements', 'codebase', 'risk-scope'];
const ROLE_ICONS = {
    requirements: '📋',
    codebase: '🔍',
    'risk-scope': '⚠️',
};
const ROLE_COLORS = {
    requirements: Style.CYAN,
    codebase: Style.GREEN,
    'risk-scope': Style.YELLOW,
};
function discoverLatestWorkerLog(refinementDir, roleId) {
    try {
        const files = fs.readdirSync(refinementDir)
            .filter((f) => f.startsWith(`worker_${roleId}_c`) && f.endsWith('.log'))
            .sort((a, b) => {
            const numA = parseInt(a.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10);
            const numB = parseInt(b.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10);
            return (numA || 0) - (numB || 0);
        });
        if (files.length === 0)
            return null;
        const latest = files[files.length - 1];
        const cycle = parseInt(latest.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10) || 1;
        return { logPath: path.join(refinementDir, latest), cycle };
    }
    catch {
        return null;
    }
}
function roleStatus(refinementDir, roleId) {
    const analysisFile = path.join(refinementDir, `analysis_${roleId}.md`);
    if (!fs.existsSync(analysisFile))
        return '⏳';
    // Check if the analysis has content (not just created empty)
    try {
        const stat = fs.statSync(analysisFile);
        return stat.size > 100 ? '✅' : '⏳';
    }
    catch {
        return '⏳';
    }
}
async function main() {
    const sessionDir = process.argv[2];
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node refinement-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const refinementDir = path.join(sessionDir, 'refinement');
    const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
    const { BOLD: b, DIM: d, RESET: r, MAGENTA: m } = Style;
    const width = () => Math.min((process.stdout.columns || 60) - 2, 80);
    const sep = () => `${d}${'─'.repeat(width())}${r}`;
    process.stdout.write(`\n${b}${m}🥒 Pickle Rick — Refinement Team Monitor${r}\n${sep()}\n`);
    const workers = new Map();
    for (const role of ROLES) {
        workers.set(role, { logPath: null, offset: 0, lineBuf: '', cycle: 0, done: false });
    }
    const startTime = Date.now();
    let lastRole = null;
    let lastStatusPrint = 0;
    while (true) {
        // Check if manifest exists (refinement complete)
        if (fs.existsSync(manifestPath)) {
            // Final drain of all logs
            for (const role of ROLES) {
                const ws = workers.get(role);
                if (ws.logPath) {
                    drainStreamJsonLines(ws.logPath, ws.offset, ws.lineBuf, processLine, (text) => {
                        const color = ROLE_COLORS[role];
                        const icon = ROLE_ICONS[role];
                        for (const line of text.split('\n')) {
                            const truncated = line.length > width() ? line.slice(0, width() - 3) + '…' : line;
                            process.stdout.write(`${color}${icon} ${d}${role}${r} ${truncated}\n`);
                        }
                    });
                }
            }
            // Read manifest and show summary
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                process.stdout.write(`\n${sep()}\n`);
                process.stdout.write(`${b}${Style.GREEN}🥒 Refinement Complete${r} ${d}(${formatTime(elapsed)})${r}\n`);
                process.stdout.write(`   Cycles: ${manifest.cycles_completed}/${manifest.cycles_requested}\n`);
                for (const w of manifest.workers || []) {
                    const icon = w.success ? '✅' : '❌';
                    process.stdout.write(`   ${icon} ${w.role}\n`);
                }
                process.stdout.write(`\n`);
            }
            catch { /* ignore */ }
            break;
        }
        // Wait for refinement directory to exist
        if (!fs.existsSync(refinementDir)) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            process.stdout.write(`\r${d}Waiting for refinement workers... (${formatTime(elapsed)})${r}\x1b[K`);
            await sleep(1000);
            continue;
        }
        // Print status header every 10s
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        if (now - lastStatusPrint >= 10_000) {
            lastStatusPrint = now;
            const statusParts = ROLES.map((role) => {
                const status = roleStatus(refinementDir, role);
                const color = ROLE_COLORS[role];
                return `${status} ${color}${role}${r}`;
            }).join(' │ ');
            process.stdout.write(`\n${d}[${formatTime(elapsed)}]${r} ${statusParts}\n`);
        }
        // Discover and drain each worker's log
        let anyOutput = false;
        for (const role of ROLES) {
            const ws = workers.get(role);
            // Check for new/updated log file
            const discovered = discoverLatestWorkerLog(refinementDir, role);
            if (!discovered)
                continue;
            // New log file or new cycle
            if (discovered.logPath !== ws.logPath) {
                ws.logPath = discovered.logPath;
                ws.offset = 0;
                ws.lineBuf = '';
                ws.cycle = discovered.cycle;
                const cycleLabel = ws.cycle > 1 ? ` (Cycle ${ws.cycle})` : '';
                process.stdout.write(`\n${sep()}\n${b}${ROLE_COLORS[role]}${ROLE_ICONS[role]} ${role}${cycleLabel}${r}\n${sep()}\n`);
                lastRole = role;
            }
            // Drain new content
            const prevOffset = ws.offset;
            const result = drainStreamJsonLines(ws.logPath, ws.offset, ws.lineBuf, processLine, (text) => {
                // Print role header if switching roles
                if (lastRole !== role) {
                    lastRole = role;
                    const color = ROLE_COLORS[role];
                    const icon = ROLE_ICONS[role];
                    process.stdout.write(`${color}${d}── ${icon} ${role} ──${r}\n`);
                }
                for (const line of text.split('\n')) {
                    const truncated = line.length > width() ? line.slice(0, width() - 3) + '…' : line;
                    process.stdout.write(`  ${truncated}\n`);
                }
            });
            ws.offset = result.offset;
            ws.lineBuf = result.lineBuf;
            if (result.offset > prevOffset)
                anyOutput = true;
            // Check if analysis file appeared
            if (!ws.done && roleStatus(refinementDir, role) === '✅') {
                ws.done = true;
                process.stdout.write(`  ${Style.GREEN}✅ ${role} analysis complete${r}\n`);
            }
        }
        // Fallback exit: if state.json shows session ended and no manifest ever appeared,
        // the spawner likely crashed. Don't hang forever.
        try {
            const statePath = path.join(sessionDir, 'state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            if (state.active === false && state.step !== 'prd') {
                // state advanced past prd (setup --paused sets step=prd, active=false)
                // but no manifest — something went wrong
                await sleep(3000);
                if (!fs.existsSync(manifestPath)) {
                    process.stdout.write(`\n${sep()}\n${Style.YELLOW}⚠️  Session inactive with no manifest — refinement may have failed.${r}\n`);
                    break;
                }
            }
        }
        catch { /* state.json missing or unreadable — keep waiting */ }
        await sleep(anyOutput ? 200 : 500);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'refinement-watcher.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${Style.RED}[refinement-watcher] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
