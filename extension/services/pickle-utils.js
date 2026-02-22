import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
export const Style = {
    GREEN: '\x1b[32m',
    RED: '\x1b[31m',
    BLUE: '\x1b[34m',
    CYAN: '\x1b[36m',
    YELLOW: '\x1b[33m',
    MAGENTA: '\x1b[35m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    RESET: '\x1b[0m',
};
export function getWidth(maxW = 90) {
    const cols = process.stdout.columns || 80;
    return Math.min(cols - 4, maxW);
}
export function wrapText(text, width) {
    if (width <= 0)
        return [text];
    const lines = [];
    const words = text.split(' ');
    let currentLine = '';
    for (const word of words) {
        if ((currentLine + word).length <= width) {
            currentLine += (currentLine === '' ? '' : ' ') + word;
        }
        else {
            if (currentLine)
                lines.push(currentLine);
            currentLine = word;
            while (currentLine.length > width) {
                lines.push(currentLine.slice(0, width));
                currentLine = currentLine.slice(width);
            }
        }
    }
    if (currentLine)
        lines.push(currentLine);
    return lines.length > 0 ? lines : [''];
}
export function printMinimalPanel(title, fields, colorName = 'GREEN', icon = '🥒') {
    const width = getWidth();
    const c = Style[colorName] || Style.GREEN;
    const r = Style.RESET;
    const b = Style.BOLD;
    const d = Style.DIM;
    if (title) {
        process.stdout.write(`\n${c}${icon} ${b}${title}${r}\n`);
    }
    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length === 0) {
        process.stdout.write('\n');
        return;
    }
    const maxKeyLen = Math.max(...fieldKeys.map((k) => k.length)) + 1;
    for (const [key, value] of Object.entries(fields)) {
        const valWidth = width - maxKeyLen - 5;
        const wrappedVal = wrapText(String(value), valWidth);
        process.stdout.write(`  ${d}${key + ':'}${' '.repeat(maxKeyLen - key.length - 1)}${r} ${wrappedVal[0]}\n`);
        for (let i = 1; i < wrappedVal.length; i++) {
            process.stdout.write(`  ${' '.repeat(maxKeyLen)} ${wrappedVal[i]}\n`);
        }
    }
    process.stdout.write('\n');
}
export function printBanner(text, colorName = 'CYAN') {
    const c = Style[colorName] || Style.CYAN;
    const r = Style.RESET;
    const b = Style.BOLD;
    const line = '='.repeat(60);
    process.stdout.write(`\n${b}${c}${line}${r}\n`);
    process.stdout.write(`${b}${c}  ${text}${r}\n`);
    process.stdout.write(`${b}${c}${line}${r}\n\n`);
}
export function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
}
export function run_cmd(cmd, options = {}) {
    const { cwd, check = true, capture = true } = options;
    const command = Array.isArray(cmd) ? cmd.join(' ') : cmd;
    try {
        const stdout = execSync(command, {
            cwd,
            encoding: 'utf-8',
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        return (stdout || '').trim();
    }
    catch (error) {
        const err = error;
        if (check)
            throw new Error(`Command failed: ${command}\nError: ${err.stderr?.toString() || err.message}`);
        return err.stdout?.toString().trim() || '';
    }
}
export async function spawn_cmd(cmd, options = {}) {
    return new Promise((resolve) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
            cwd: options.cwd,
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        proc.stdout?.on('data', (data) => options.onData?.(data.toString()));
        proc.stderr?.on('data', (data) => options.onData?.(data.toString()));
        proc.on('close', (code) => {
            resolve(code || 0);
        });
        proc.on('error', (err) => {
            console.error(`Failed to start process: ${err}`);
            resolve(1);
        });
    });
}
export function getExtensionRoot() {
    return path.join(os.homedir(), '.claude/pickle-rick');
}
export function getSessionDir() {
    try {
        const extensionRoot = getExtensionRoot();
        const getSessionScript = path.join(extensionRoot, 'extension/bin/get-session.js');
        if (fs.existsSync(getSessionScript)) {
            const res = run_cmd(['node', getSessionScript], { capture: true, check: false });
            return res || null;
        }
    }
    catch (e) {
        // Ignore
    }
    return null;
}
export function statusSymbol(status) {
    const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
    if (s === 'done') return '[x]';
    if (s === 'in progress') return '[~]';
    return '[ ]';
}
export function parseTicketFrontmatter(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) return null;
        const fm = fmMatch[1];
        const get = (field) => {
            const m = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
            return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
        };
        return {
            id: get('id'),
            title: get('title'),
            status: get('status'),
            order: parseInt(get('order') || '0', 10),
        };
    } catch {
        return null;
    }
}
export function collectTickets(sessionDir) {
    try {
        const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
        const tickets = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const subDir = path.join(sessionDir, entry.name);
            try {
                const files = fs.readdirSync(subDir);
                for (const file of files) {
                    if (!file.startsWith('linear_ticket_') || !file.endsWith('.md')) continue;
                    const parsed = parseTicketFrontmatter(path.join(subDir, file));
                    if (parsed) tickets.push(parsed);
                }
            } catch {
                /* skip */
            }
        }
        return tickets.sort((a, b) => a.order - b.order);
    } catch {
        return [];
    }
}
