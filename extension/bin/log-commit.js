import * as fs from 'fs';
import * as path from 'path';
import { logActivity } from '../services/activity-logger.js';
const COMMIT_CMD_RE = /\bgit\s+(commit|cherry-pick|merge)\b/;
const COMMIT_HASH_RE = /\[[\w\/-]+\s+([a-f0-9]{7,})\]\s+(.+)/;
function main() {
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    }
    catch {
        process.exit(0);
    }
    let input;
    try {
        input = JSON.parse(raw || '{}');
    }
    catch {
        process.exit(0);
    }
    const command = input.tool_input?.command;
    if (!command || !COMMIT_CMD_RE.test(command)) {
        process.exit(0);
    }
    const stdout = input.tool_response?.stdout ?? '';
    const match = COMMIT_HASH_RE.exec(stdout);
    const commit_hash = match?.[1];
    const commit_message = match?.[2]?.trim();
    logActivity({
        event: 'commit',
        source: 'hook',
        ...(commit_hash ? { commit_hash } : {}),
        ...(commit_message ? { commit_message } : {}),
    });
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-commit.js') {
    main();
}
