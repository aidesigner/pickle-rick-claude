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
    until.setDate(until.getDate() + 1); // always include today's file
    const since = new Date(todayMidnight);
    since.setDate(since.getDate() - effectiveDays);
    return { range: { since, until } };
}
/** Read working_dir from a session's state.json and extract the project name. */
function getSessionProject(sessionId) {
    const sessionsDir = path.join(getExtensionRoot(), 'sessions');
    const stateFile = path.join(sessionsDir, sessionId, 'state.json');
    try {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const wd = data?.working_dir;
        if (typeof wd === 'string' && wd) {
            return path.basename(wd);
        }
    }
    catch {
        // state.json missing or unreadable
    }
    return null;
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
    // 1. Build session map from non-commit events
    const sessionEvents = new Map();
    const adhocEvents = [];
    for (const e of nonCommitEvents) {
        if (e.session) {
            const list = sessionEvents.get(e.session) || [];
            list.push(e);
            sessionEvents.set(e.session, list);
        }
        else {
            adhocEvents.push(e);
        }
    }
    // 2. Attribute commits to sessions
    const sessionCommits = new Map();
    const adhocHookCommits = [];
    for (const c of hookCommits) {
        if (c.session) {
            if (!sessionEvents.has(c.session))
                sessionEvents.set(c.session, []);
            const list = sessionCommits.get(c.session) || [];
            list.push(c);
            sessionCommits.set(c.session, list);
        }
        else {
            // No session field — try timestamp fallback
            let attributed = false;
            for (const [sid, sevts] of sessionEvents) {
                if (sevts.length === 0)
                    continue;
                const firstTs = sevts[0].ts;
                const lastTs = sevts[sevts.length - 1].ts;
                if (c.ts >= firstTs && c.ts <= lastTs) {
                    const list = sessionCommits.get(sid) || [];
                    list.push(c);
                    sessionCommits.set(sid, list);
                    attributed = true;
                    break;
                }
            }
            if (!attributed)
                adhocHookCommits.push(c);
        }
    }
    // 3. Build sorted session entries (newest first by first event timestamp)
    //    Filter out empty sessions: only session_start/session_end events, no commits, no iterations
    const LIFECYCLE_ONLY = new Set(['session_start', 'session_end']);
    const sessionEntries = [...sessionEvents.entries()]
        .filter(([sid, sevts]) => {
        const commits = sessionCommits.get(sid) || [];
        const hasMeaningfulEvents = sevts.some((e) => !LIFECYCLE_ONLY.has(e.event));
        return commits.length > 0 || hasMeaningfulEvents;
    })
        .map(([sid, sevts]) => {
        const startEvent = sevts.find((e) => e.event === 'session_start');
        const prompt = startEvent?.original_prompt;
        const taskName = prompt ? (prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt) : sid;
        const allTs = sevts.map((e) => e.ts);
        const commits = sessionCommits.get(sid) || [];
        for (const c of commits)
            allTs.push(c.ts);
        allTs.sort();
        const firstTs = allTs[0] || '';
        const lastTs = allTs[allTs.length - 1] || firstTs;
        const durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
        const durationMin = Math.floor(durationMs / 60000);
        const hours = Math.floor(durationMin / 60);
        const mins = durationMin % 60;
        const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        const iterationStarts = sevts.filter((e) => e.event === 'iteration_start');
        const iterationCount = iterationStarts.length;
        const iterationStr = iterationCount > 0 ? `${iterationCount} iteration${iterationCount === 1 ? '' : 's'}` : '? iterations';
        const mode = startEvent?.mode || (iterationCount > 0 ? 'tmux' : 'inline');
        const project = getSessionProject(sid);
        return { sid, taskName, durationStr, iterationStr, mode, commits, firstTs, project };
    });
    sessionEntries.sort((a, b) => (a.firstTs > b.firstTs ? -1 : a.firstTs < b.firstTs ? 1 : 0));
    // 4. Render output
    const lines = [];
    lines.push(`# Standup — ${sinceStr} to ${untilStr}`);
    lines.push('');
    for (const s of sessionEntries) {
        const projectTag = s.project ? ` [${s.project}]` : '';
        lines.push(`## ${s.taskName}${projectTag} (${s.sid})`);
        lines.push(`- **Duration**: ${s.durationStr} (${s.iterationStr})`);
        lines.push(`- **Mode**: ${s.mode}`);
        if (s.commits.length > 0) {
            lines.push('- **Commits**:');
            for (const c of s.commits) {
                const msg = c.commit_message || '(no message)';
                lines.push(`  - \`${c.commit_hash?.slice(0, 7)}\` ${msg}`);
            }
        }
        lines.push('');
    }
    // 5. Ad-hoc section
    const hasAdhocCommits = adhocHookCommits.length > 0 || gitOnlyCommits.length > 0;
    if (hasAdhocCommits) {
        lines.push('## Ad-hoc Commits');
        for (const c of adhocHookCommits) {
            const msg = c.commit_message || '(no message)';
            lines.push(`- \`${c.commit_hash?.slice(0, 7)}\` ${msg}`);
        }
        for (const [hash, msg] of gitOnlyCommits) {
            lines.push(`- \`${hash.slice(0, 7)}\` ${msg}`);
        }
        lines.push('');
    }
    if (adhocEvents.length > 0) {
        lines.push('## Ad-hoc Activity');
        for (const e of adhocEvents) {
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
