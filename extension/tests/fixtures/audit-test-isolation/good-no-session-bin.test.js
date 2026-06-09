// @tier: integration
// audit-test-isolation fixture: no session-writing bin spawned.
// No test() calls — pattern-detection target for audit-test-isolation.sh only.
// check-readiness.js is a read-only utility, not a session-writing bin.
// The audit MUST NOT flag this pattern.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function goodNoSessionBinCall() {
    return spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/check-readiness.js'), '/tmp/sess'], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 5000,
    });
}
