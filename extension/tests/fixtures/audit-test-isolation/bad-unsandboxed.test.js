// @tier: integration
// audit-test-isolation fixture: deliberately shows an unsandboxed setup.js call.
// No test() calls — this file only serves as a pattern-detection target for the
// audit-test-isolation.sh window scan. Imported by audit-test-isolation.test.js.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deliberately missing sandbox — no data-root var in env.
// The audit gate should flag the spawnSync line below.
export function unsandboxedSetupCall() {
    return spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/setup.js')], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 5000,
    });
}
