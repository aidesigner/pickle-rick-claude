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
  } catch {
    // Silent failure — activity logging must never break the caller
  }
}
