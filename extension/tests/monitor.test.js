import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_BIN = path.resolve(__dirname, '../bin/monitor.js');

/**
 * Run monitor.js as a subprocess.
 * @param {string[]} args - CLI arguments
 */
function run(args) {
    return spawnSync(process.execPath, [MONITOR_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

// --- Startup validation ---

test('monitor: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('monitor: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-pickle-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});
