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
    const statePath = path.join(sessionDir, 'state.json');
    let lastRendered;
    let fileSize = 0;
    while (true) {
        // R-MWR-4: truncation resilience — detect if microverse.json shrank
        const trunc = detectLogTruncation(microversePath, fileSize, '');
        if (trunc.truncated) {
            fileSize = trunc.offset;
        }
        // Read state once per poll for both liveness and producer_done (R-MDS-6).
        let sessionActive = true;
        let producerDone = false;
        try {
            const stateSnap = sm.read(statePath);
            sessionActive = stateSnap.active === true;
            producerDone = stateSnap.monitor_panes?.[2]?.producer_done === true;
        }
        catch {
            /* session dir unreadable — keep polling */
        }
        const data = readRecoverableJsonObject(microversePath);
        if (data !== null) {
            const raw = data;
            const subsystem = typeof raw.current_subsystem === 'string' && raw.current_subsystem
                ? raw.current_subsystem
                : null;
            // R-MDS-6: when subsystem is absent, check producer_done for message
            const display = subsystem ?? (producerDone ? 'Producer complete' : 'idle');
            if (display !== lastRendered) {
                lastRendered = display;
                process.stdout.write(`▸ ${display}\n`);
            }
            try {
                fileSize = fs.statSync(microversePath).size;
            }
            catch {
                fileSize = 0;
            }
        }
        // Liveness probe — exit after rendering current data
        if (!sessionActive)
            break;
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
