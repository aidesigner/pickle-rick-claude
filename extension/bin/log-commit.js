import * as fs from 'fs';
import * as path from 'path';
import { logActivity } from '../services/activity-logger.js';
import { findSessionPathForCwd } from '../services/pickle-utils.js';
const COMMIT_CMD_RE = /\bgit\s+(commit|cherry-pick|merge|rebase)\b/;
const COMMIT_HASH_RE = /\[[^\]]*\s+([a-f0-9]{7,})\]\s+(.+)/;
const LAST_TOOL_ERROR_FILE = 'last-tool-error.json';
function findActiveSessionPath() {
    try {
        return findSessionPathForCwd(process.cwd(), { requireActive: true });
    }
    catch {
        return null;
    }
}
function readHookInput() {
    const MAX_STDIN = 1024 * 1024; // 1 MB guard — truncate oversized input
    let raw;
    try {
        raw = fs.readFileSync(0, 'utf8');
        if (raw.length > MAX_STDIN)
            raw = raw.slice(0, MAX_STDIN);
    }
    catch {
        return null;
    }
    try {
        return JSON.parse(raw || '{}');
    }
    catch {
        return null;
    }
}
function extractCommit(stdout) {
    const match = COMMIT_HASH_RE.exec(stdout);
    return {
        ...(match?.[1] ? { commit_hash: match[1] } : {}),
        ...(match?.[2]?.trim() ? { commit_message: match[2].trim() } : {}),
    };
}
function clearLastToolError(sessionPath) {
    if (!sessionPath)
        return;
    try {
        fs.unlinkSync(path.join(sessionPath, LAST_TOOL_ERROR_FILE));
    }
    catch {
        /* missing or unreadable retry marker is fine */
    }
}
function main() {
    const input = readHookInput();
    if (!input)
        process.exit(0);
    const sessionPath = findActiveSessionPath();
    clearLastToolError(sessionPath);
    const command = input.tool_input?.command;
    if (!command || !COMMIT_CMD_RE.test(command)) {
        process.exit(0);
    }
    const commit = extractCommit(input.tool_response?.stdout ?? '');
    const session = sessionPath ? path.basename(sessionPath) : null;
    logActivity({
        event: 'commit',
        source: 'hook',
        ...commit,
        ...(session ? { session } : {}),
    });
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-commit.js') {
    main();
}
