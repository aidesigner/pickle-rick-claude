// @tier: integration
// audit-test-isolation fixture: session-writing bin spawn with real-repo working_dir.
// No test() calls — pattern-detection target for audit-test-isolation.sh only.
// PICKLE_DATA_ROOT is present (passes old check), but working_dir: REPO_ROOT
// in the window should be caught by the new isolation guard.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

export function badMuxRunnerRealWorkingDir(dataRoot) {
    // working_dir: REPO_ROOT  <- real-repo isolation violation (R-WTIV pattern)
    return spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/mux-runner.js'), '/tmp/sess'], {
        env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
        encoding: 'utf-8',
        timeout: 5000,
    });
}
