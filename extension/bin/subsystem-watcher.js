#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { sleep, detectLogTruncation } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
const POLL_INTERVAL_MS = 2000;
const sm = new StateManager();
async function main() {
    const sessionDir = process.argv[2];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node subsystem-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const microversePath = path.join(sessionDir, 'microverse.json');
    let lastSubsystem;
    let fileSize = 0;
    while (true) {
        // R-MWR-4: truncation resilience — detect if microverse.json shrank
        const trunc = detectLogTruncation(microversePath, fileSize, '');
        if (trunc.truncated) {
            fileSize = trunc.offset;
        }
        const data = readRecoverableJsonObject(microversePath);
        if (data !== null) {
            const raw = data;
            const subsystem = typeof raw.current_subsystem === 'string' && raw.current_subsystem
                ? raw.current_subsystem
                : null;
            if (subsystem !== lastSubsystem) {
                lastSubsystem = subsystem;
                process.stdout.write(`▸ ${subsystem ?? 'idle'}\n`);
            }
            try {
                fileSize = fs.statSync(microversePath).size;
            }
            catch {
                fileSize = 0;
            }
        }
        // Liveness probe — exit when session is inactive
        try {
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.active !== true)
                break;
        }
        catch {
            /* session dir unreadable — keep polling */
        }
        await sleep(POLL_INTERVAL_MS);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'subsystem-watcher.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[subsystem-watcher] ${msg}`);
        process.exit(1);
    });
}
