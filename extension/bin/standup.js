#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getExtensionRoot } from '../services/pickle-utils.js';
function consumeArg(argv, i, flagName, hint) {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
        console.error(`Error: ${flagName} requires ${hint}.`);
        process.exit(1);
    }
    return val;
}
export function parseArgs(argv) {
    let days = null;
    let sinceStr = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--days') {
            const val = consumeArg(argv, i++, '--days', 'a numeric value');
            days = Number(val);
            if (!Number.isFinite(days) || days < 0 || Math.floor(days) !== days) {
                console.error(`Error: --days must be a non-negative integer, got "${val}".`);
                process.exit(1);
            }
        }
        else if (arg === '--since') {
            sinceStr = consumeArg(argv, i++, '--since', 'a YYYY-MM-DD value');
        }
        else {
            console.error(`Error: unknown flag "${arg}".`);
            process.exit(1);
        }
    }
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (sinceStr !== null) {
        const parsed = new Date(sinceStr + 'T00:00:00');
        if (isNaN(parsed.getTime())) {
            console.error(`Error: invalid date "${sinceStr}". Use YYYY-MM-DD format.`);
            process.exit(1);
        }
        const tomorrowMidnight = new Date(todayMidnight);
        tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
        if (parsed >= tomorrowMidnight) {
            console.error(`Error: --since date "${sinceStr}" is in the future.`);
            process.exit(1);
        }
        return { range: { since: parsed, until: tomorrowMidnight } };
    }
    // Default: --days 1
    const effectiveDays = days ?? 1;
    const until = new Date(todayMidnight);
    if (effectiveDays === 0) {
        // --days 0 = today only
        until.setDate(until.getDate() + 1);
    }
    const since = new Date(todayMidnight);
    since.setDate(since.getDate() - effectiveDays);
    return { range: { since, until } };
}
function dateToFilename(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
export function readActivityFiles(activityDir, since, until) {
    if (!fs.existsSync(activityDir))
        return [];
    let files;
    try {
        files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return [];
    }
    const sinceMs = since.getTime();
    const untilMs = until.getTime();
    const matchingFiles = files.filter((f) => {
        const datepart = f.replace('.jsonl', '');
        const fileMs = new Date(datepart + 'T00:00:00').getTime();
        return Number.isFinite(fileMs) && fileMs >= sinceMs && fileMs < untilMs;
    });
    const events = [];
    let totalLines = 0;
    let corruptLines = 0;
    const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB guard
    for (const file of matchingFiles) {
        const filePath = path.join(activityDir, file);
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_FILE_BYTES) {
                console.error(`Warning: skipping ${file} (${Math.round(stat.size / 1024 / 1024)}MB exceeds 10MB limit).`);
                continue;
            }
        }
        catch {
            continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        for (const line of lines) {
            totalLines++;
            try {
                const parsed = JSON.parse(line);
                if (typeof parsed.ts === 'string' && typeof parsed.event === 'string') {
                    events.push(parsed);
                }
                else {
                    corruptLines++;
                }
            }
            catch {
                corruptLines++;
            }
        }
    }
    if (totalLines > 0 && corruptLines / totalLines > 0.1) {
        console.error(`Warning: ${corruptLines}/${totalLines} lines (${Math.round(100 * corruptLines / totalLines)}%) could not be parsed.`);
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return events;
}
export function getGitCommits(since) {
    const commits = new Map();
    try {
        const output = execSync(`git log --after="${since.toISOString()}" --oneline`, {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 0) {
                commits.set(trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1));
            }
        }
    }
    catch {
        // Not in a git repo or git not available — that's fine
    }
    return commits;
}
export function deduplicateCommits(events, gitCommits) {
    const hookCommits = events.filter((e) => e.event === 'commit' && e.commit_hash);
    const seenHashes = hookCommits.map((e) => e.commit_hash);
    const seenSet = new Set(seenHashes);
    const gitOnlyCommits = [];
    for (const [hash, msg] of gitCommits) {
        if (seenSet.has(hash) || seenHashes.some((h) => h.startsWith(hash) || hash.startsWith(h)))
            continue;
        gitOnlyCommits.push([hash, msg]);
    }
    return { hookCommits, gitOnlyCommits };
}
export function formatOutput(events, hookCommits, gitOnlyCommits, since, until) {
    const sinceStr = dateToFilename(since);
    const untilStr = dateToFilename(until);
    const nonCommitEvents = events.filter((e) => e.event !== 'commit');
    const hasContent = nonCommitEvents.length > 0 || hookCommits.length > 0 || gitOnlyCommits.length > 0;
    if (!hasContent) {
        return `No activity found for ${sinceStr} to ${untilStr}.`;
    }
    const lines = [];
    lines.push(`# Standup — ${sinceStr} to ${untilStr}`);
    lines.push('');
    // Sessions section
    const sessions = new Map();
    const adhoc = [];
    for (const e of nonCommitEvents) {
        if (e.session) {
            const list = sessions.get(e.session) || [];
            list.push(e);
            sessions.set(e.session, list);
        }
        else {
            adhoc.push(e);
        }
    }
    if (sessions.size > 0) {
        lines.push('## Sessions');
        lines.push('');
        for (const [session, sessionEvents] of sessions) {
            lines.push(`### ${session}`);
            for (const e of sessionEvents) {
                const time = e.ts.slice(11, 16);
                const detail = e.title || e.ticket || e.step || '';
                lines.push(`- \`${time}\` **${e.event}**${detail ? ` — ${detail}` : ''}`);
            }
            lines.push('');
        }
    }
    // Commits section
    if (hookCommits.length > 0 || gitOnlyCommits.length > 0) {
        lines.push('## Commits');
        lines.push('');
        for (const c of hookCommits) {
            const msg = c.commit_message || '(no message)';
            lines.push(`- \`${c.commit_hash?.slice(0, 7)}\` ${msg}`);
        }
        for (const [hash, msg] of gitOnlyCommits) {
            lines.push(`- \`${hash.slice(0, 7)}\` ${msg}`);
        }
        lines.push('');
    }
    // Ad-hoc Activity section
    if (adhoc.length > 0) {
        lines.push('## Ad-hoc Activity');
        lines.push('');
        for (const e of adhoc) {
            const time = e.ts.slice(11, 16);
            const detail = e.title || e.ticket || e.step || '';
            lines.push(`- \`${time}\` **${e.event}**${detail ? ` — ${detail}` : ''}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
function main() {
    const { range } = parseArgs(process.argv.slice(2));
    const activityDir = path.join(getExtensionRoot(), 'activity');
    const events = readActivityFiles(activityDir, range.since, range.until);
    const gitCommits = getGitCommits(range.since);
    const { hookCommits, gitOnlyCommits } = deduplicateCommits(events, gitCommits);
    const output = formatOutput(events, hookCommits, gitOnlyCommits, range.since, range.until);
    console.log(output);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'standup.js') {
    main();
}
