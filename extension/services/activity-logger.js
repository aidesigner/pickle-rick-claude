import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot } from './pickle-utils.js';
export function getActivityDir() {
    return path.join(getExtensionRoot(), 'activity');
}
export function logActivity(event) {
    try {
        const activityDir = getActivityDir();
        fs.mkdirSync(activityDir, { recursive: true });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const fullEvent = { ts: new Date().toISOString(), ...event };
        const line = JSON.stringify(fullEvent) + '\n';
        // mode only applies on file creation (ignored if file exists) — first write = 0o600
        fs.appendFileSync(filepath, line, { mode: 0o600 });
    }
    catch {
        // Silent failure — activity logging must never break the caller
    }
}
