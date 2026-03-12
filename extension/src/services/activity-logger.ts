import * as fs from 'fs';
import * as path from 'path';
import { ActivityEvent, ActivityEventType } from '../types/index.js';
import { getExtensionRoot } from './pickle-utils.js';

export function getActivityDir(): string {
  return path.join(getExtensionRoot(), 'activity');
}

export function logActivity(
  event: Partial<ActivityEvent> & { event: ActivityEventType; source: ActivityEvent['source'] }
): void {
  try {
    const activityDir = getActivityDir();
    fs.mkdirSync(activityDir, { recursive: true });
    const date = new Date().toLocaleDateString('en-CA');
    const filepath = path.join(activityDir, `${date}.jsonl`);
    const fullEvent: ActivityEvent = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(fullEvent) + '\n';
    // mode only applies on file creation (ignored if file exists) — first write = 0o600
    fs.appendFileSync(filepath, line, { mode: 0o600 });
  } catch (err) {
    // Activity logging must never break the caller, but warn so data loss is visible
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[activity-logger] Failed to log event: ${msg}\n`);
  }
}

const DATE_JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Deletes JSONL activity files older than maxAgeDays by filename date.
 * Handles ENOENT race (concurrent sessions may delete the same file).
 */
export function pruneActivity(maxAgeDays = 365): number {
  const activityDir = getActivityDir();
  if (!fs.existsSync(activityDir)) return 0;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const cutoffMs = now.getTime() - maxAgeDays * 86_400_000;

  let deleted = 0;
  for (const entry of fs.readdirSync(activityDir)) {
    if (!DATE_JSONL_RE.test(entry)) continue;
    const dateStr = path.basename(entry, '.jsonl');
    const fileMs = new Date(dateStr + 'T00:00:00').getTime();
    if (!Number.isFinite(fileMs)) continue;
    if (fileMs >= cutoffMs) continue;
    try {
      fs.unlinkSync(path.join(activityDir, entry));
      deleted++;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return deleted;
}
