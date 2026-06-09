// @tier: integration
// audit-test-isolation fixture: EXTENSION_DIR: REPO_ROOT is legitimate.
// No test() calls — pattern-detection target for audit-test-isolation.sh only.
// EXTENSION_DIR is a read-only code path, not a session working_dir.
// The audit MUST NOT flag this pattern.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

export function goodExtensionDirRooted(dataRoot) {
    return spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/setup.js')], {
        env: { ...process.env, EXTENSION_DIR: REPO_ROOT, PICKLE_DATA_ROOT: dataRoot },
        encoding: 'utf-8',
        timeout: 5000,
    });
}
