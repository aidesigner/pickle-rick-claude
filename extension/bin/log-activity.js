import * as path from 'path';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { safeErrorMessage } from '../services/pickle-utils.js';
const USAGE = `Usage: log-activity <event_type> "<title>" [--gate-payload <json-object>]
Valid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`;
function parseGatePayload(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch (err) {
        console.error(`--gate-payload is not valid JSON: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error('--gate-payload must be a JSON object (not array, not null, not scalar).');
        process.exit(1);
    }
    return parsed;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-activity.js') {
    const argv = process.argv.slice(2);
    const positional = [];
    let gatePayload;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--gate-payload') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                console.error('--gate-payload requires a JSON-object value.');
                process.exit(1);
            }
            gatePayload = parseGatePayload(next);
            i++;
        }
        else {
            positional.push(arg);
        }
    }
    const [eventType, rawTitle] = positional;
    if (!eventType || eventType.startsWith('--')) {
        console.error(USAGE);
        process.exit(1);
    }
    if (!VALID_ACTIVITY_EVENTS.includes(eventType)) {
        console.error(`Unknown event type "${eventType}". Valid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`);
        process.exit(1);
    }
    if (!rawTitle || rawTitle.startsWith('--')) {
        console.error('Title is required and must not start with "--".');
        process.exit(1);
    }
    // Strip all control characters (C0/C1) and ANSI escape sequences
    const title = rawTitle.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
    if (title.trim().length === 0) {
        console.error('Title must not be empty after sanitization.');
        process.exit(1);
    }
    try {
        logActivity({
            event: eventType,
            title,
            source: 'persona',
            ...(gatePayload ? { gate_payload: gatePayload } : {}),
        });
    }
    catch (err) {
        console.error(`Failed to log activity: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
}
