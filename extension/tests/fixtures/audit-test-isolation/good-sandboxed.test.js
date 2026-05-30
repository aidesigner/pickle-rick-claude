// @tier: integration
// audit-test-isolation fixture: correctly sandboxes setup.js with a data-root var.
// No test() calls — this file only serves as a pattern-detection target for the
// audit-test-isolation.sh window scan. Imported by audit-test-isolation.test.js.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Properly sandboxed — PICKLE_DATA_ROOT set in child env.
export function sandboxedSetupCall() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/setup.js')], {
        env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
        encoding: 'utf-8',
        timeout: 5000,
    });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    return result;
}
