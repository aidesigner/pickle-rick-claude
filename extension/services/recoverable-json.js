import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readProcessStartTimeMs(pid) {
    try {
        const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8',
            timeout: 1000,
        }).trim();
        if (!output)
            return null;
        const startedAt = Date.parse(output);
        return Number.isFinite(startedAt) ? startedAt : null;
    }
    catch {
        return null;
    }
}
function shouldSkipLiveTmp(tmpPid, tmpPath) {
    if (!Number.isFinite(tmpPid) || !isProcessAlive(tmpPid))
        return false;
    const processStartTimeMs = readProcessStartTimeMs(tmpPid);
    if (processStartTimeMs === null)
        return true;
    try {
        return fs.statSync(tmpPath).mtimeMs >= processStartTimeMs;
    }
    catch {
        return true;
    }
}
function parseJsonObjectFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function readJsonObjectFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { kind: 'parsed', parsed }
            : { kind: 'invalid' };
    }
    catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
            const code = String(err.code);
            if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
                return { kind: 'unreadable' };
            }
        }
        return { kind: 'invalid' };
    }
}
function listEntries(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return null;
    }
}
function parseDeadTmp(tmpPath, baseMtimeMs) {
    const parsedResult = readJsonObjectFile(tmpPath);
    if (parsedResult.kind === 'unreadable') {
        return null;
    }
    if (parsedResult.kind !== 'parsed') {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore invalid tmp cleanup failure */ }
        return null;
    }
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(tmpPath).mtimeMs;
    }
    catch {
        return null;
    }
    if (mtimeMs <= baseMtimeMs) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore stale tmp cleanup failure */ }
        return null;
    }
    return { parsed: parsedResult.parsed, mtimeMs };
}
export function readRecoverableJsonObject(filePath) {
    const base = parseJsonObjectFile(filePath);
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const entries = listEntries(dir);
    if (!entries)
        return base;
    const tmpPrefix = baseName + '.tmp.';
    const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..+)?$`);
    let baseMtimeMs;
    try {
        baseMtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    }
    catch {
        baseMtimeMs = 0;
    }
    let winner = null;
    for (const entry of entries.filter(e => e.startsWith(tmpPrefix))) {
        const match = entry.match(tmpPattern);
        if (!match)
            continue;
        const tmpPath = path.join(dir, entry);
        const tmpPid = Number(match[1]);
        if (shouldSkipLiveTmp(tmpPid, tmpPath))
            continue;
        const candidate = parseDeadTmp(tmpPath, baseMtimeMs);
        if (candidate && (!winner || candidate.mtimeMs > winner.mtimeMs)) {
            winner = { tmpPath, ...candidate };
        }
    }
    if (!winner)
        return base;
    try {
        fs.renameSync(winner.tmpPath, filePath);
        return winner.parsed;
    }
    catch {
        return base;
    }
}
