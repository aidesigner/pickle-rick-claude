#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasCompletionCommit, readFrontmatterField, ticketFilePath, upsertFrontmatterField } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { writeActivityEntry } from '../services/state-manager.js';
function parseStateStartEpoch(statePath) {
    if (!statePath || !fs.existsSync(statePath))
        return null;
    try {
        const raw = readRecoverableJsonObject(statePath);
        const parsed = Number(raw?.start_time_epoch);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
function targetTicketIds(sessionDir, ticketId) {
    if (ticketId)
        return [ticketId];
    try {
        return fs.readdirSync(sessionDir).filter((entry) => fs.existsSync(path.join(sessionDir, entry, `linear_ticket_${entry}.md`)));
    }
    catch {
        return [];
    }
}
function stageTicketFile(workingDir, filePath) {
    execFileSync('git', ['-C', workingDir, 'add', '--', filePath], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'pipe'],
    });
}
export function autoFillCompletionCommit(input) {
    const startTimeEpoch = parseStateStartEpoch(input.statePath);
    const results = [];
    for (const id of targetTicketIds(input.sessionDir, input.ticketId)) {
        const filePath = ticketFilePath(input.sessionDir, id);
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        }
        catch {
            results.push({ ticketId: id, sha: null, action: 'unreadable' });
            continue;
        }
        if ((readFrontmatterField(content, 'status') ?? '').toLowerCase() !== 'done') {
            results.push({ ticketId: id, sha: null, action: 'not_done' });
            continue;
        }
        if (readFrontmatterField(content, 'completion_commit')) {
            results.push({ ticketId: id, sha: readFrontmatterField(content, 'completion_commit'), action: 'already_present' });
            continue;
        }
        const evidence = hasCompletionCommit({
            sessionDir: input.sessionDir,
            ticketId: id,
            ticketPath: filePath,
            workingDir: input.workingDir,
            startTimeEpoch,
        });
        if (evidence.source === 'absent' || !evidence.sha) {
            results.push({ ticketId: id, sha: null, action: 'no_evidence' });
            continue;
        }
        const updated = upsertFrontmatterField(content, 'completion_commit', evidence.sha);
        if (!updated) {
            results.push({ ticketId: id, sha: null, action: 'unreadable' });
            continue;
        }
        fs.writeFileSync(filePath, updated);
        stageTicketFile(input.workingDir, filePath);
        if (input.statePath) {
            writeActivityEntry(input.statePath, {
                event: 'completion_commit_auto_filled',
                source: 'pickle',
                session: path.basename(input.sessionDir),
                ticket_id: id,
                sha: evidence.sha,
                helper: 'auto_fill',
                ts: new Date().toISOString(),
            });
        }
        results.push({ ticketId: id, sha: evidence.sha, action: 'filled' });
    }
    return results;
}
function parseArgs(argv) {
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
            continue;
        args.set(key.slice(2), value);
    }
    const sessionDir = args.get('session-dir');
    const workingDir = args.get('working-dir');
    if (!sessionDir || !workingDir) {
        throw new Error('Usage: auto-fill-completion-commit --session-dir <dir> --working-dir <dir> [--ticket-id <id>] [--state-path <path>]');
    }
    return {
        sessionDir,
        workingDir,
        ticketId: args.get('ticket-id') ?? null,
        statePath: args.get('state-path') ?? null,
    };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const result = autoFillCompletionCommit(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
