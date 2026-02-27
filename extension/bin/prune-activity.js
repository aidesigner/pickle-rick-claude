import * as fs from 'fs';
import * as path from 'path';
import { getActivityDir } from '../services/activity-logger.js';
const DATE_JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/**
 * Deletes JSONL activity files older than maxAgeDays by filename date.
 * Handles ENOENT race (concurrent sessions may delete the same file).
 */
export function pruneActivity(maxAgeDays = 365) {
    const activityDir = getActivityDir();
    if (!fs.existsSync(activityDir))
        return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    cutoff.setHours(0, 0, 0, 0);
    const cutoffMs = cutoff.getTime();
    let deleted = 0;
    for (const entry of fs.readdirSync(activityDir)) {
        if (!DATE_JSONL_RE.test(entry))
            continue;
        const dateStr = path.basename(entry, '.jsonl');
        const fileMs = new Date(dateStr + 'T00:00:00').getTime();
        if (!Number.isFinite(fileMs))
            continue;
        if (fileMs >= cutoffMs)
            continue;
        try {
            fs.unlinkSync(path.join(activityDir, entry));
            deleted++;
        }
        catch (err) {
            if (err instanceof Error && err.code === 'ENOENT')
                continue;
            throw err;
        }
    }
    return deleted;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'prune-activity.js') {
    try {
        const deleted = pruneActivity();
        if (deleted > 0)
            console.log(`Pruned ${deleted} old activity file${deleted === 1 ? '' : 's'}.`);
    }
    catch (err) {
        console.error(`Activity prune failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
