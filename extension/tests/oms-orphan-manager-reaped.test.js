// @tier: fast
/**
 * R-OMS regression test: orphan manager reaping at iteration boundaries.
 *
 * AC-BPBH-02: manager subprocess from iteration N is dead by start of N+1.
 * AC-BPBH-04: no LATEST_SCHEMA_VERSION bump; schema byte-compatible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseOrphanedManagersFromPs,
    reapOrphanedManagersAtIterationStart,
    writeActivePidFile,
    clearActivePidFile,
} from '../bin/mux-runner.js';
import { VALID_ACTIVITY_EVENTS, LATEST_SCHEMA_VERSION } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oms-test-')));
}

// ---------------------------------------------------------------------------
// parseOrphanedManagersFromPs
// ---------------------------------------------------------------------------

test('parseOrphanedManagersFromPs: returns empty for empty ps output', () => {
    const result = parseOrphanedManagersFromPs('', '/tmp/session-abc');
    assert.deepEqual(result, []);
});

test('parseOrphanedManagersFromPs: detects claude manager with matching sessionDir', () => {
    const sessionDir = '/home/user/.local/share/pickle-rick/sessions/2026-05-27-abc123/';
    const psLine = `1234 1 00:30:00 /usr/local/bin/claude --dangerously-skip-permissions --add-dir ${sessionDir} --prompt foo`;
    const result = parseOrphanedManagersFromPs(psLine, sessionDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].pid, 1234);
    assert.ok(result[0].argv_summary.includes('--dangerously-skip-permissions'));
});

test('parseOrphanedManagersFromPs: ignores processes without --dangerously-skip-permissions', () => {
    const sessionDir = '/sessions/abc/';
    const psLine = `5678 1 01:00:00 /usr/bin/claude --add-dir ${sessionDir}`;
    const result = parseOrphanedManagersFromPs(psLine, sessionDir);
    assert.deepEqual(result, []);
});

test('parseOrphanedManagersFromPs: ignores processes that do not mention sessionDir', () => {
    const sessionDir = '/sessions/abc/';
    const psLine = `9999 1 00:15:00 /usr/local/bin/claude --dangerously-skip-permissions --add-dir /sessions/other/`;
    const result = parseOrphanedManagersFromPs(psLine, sessionDir);
    assert.deepEqual(result, []);
});

test('parseOrphanedManagersFromPs: ignores non-claude binaries', () => {
    const sessionDir = '/sessions/abc/';
    const psLine = `1111 1 00:05:00 /usr/bin/node --dangerously-skip-permissions --add-dir ${sessionDir}`;
    const result = parseOrphanedManagersFromPs(psLine, sessionDir);
    assert.deepEqual(result, []);
});

test('parseOrphanedManagersFromPs: handles multiple matching and non-matching lines', () => {
    const sessionDir = '/sessions/test-session/';
    const lines = [
        // should match
        `1001 1 00:30:00 /usr/bin/claude --dangerously-skip-permissions --add-dir ${sessionDir}`,
        // should not match — different session
        `1002 1 01:00:00 /usr/bin/claude --dangerously-skip-permissions --add-dir /sessions/other/`,
        // should not match — no dangerously-skip
        `1003 1 00:05:00 /usr/bin/claude --add-dir ${sessionDir}`,
        // should match
        `1004 1 00:10:00 /usr/local/bin/claude --dangerously-skip-permissions --resume --add-dir ${sessionDir} --max-turns 50`,
        // noise
        `1005 1 00:01:00 sleep 9999`,
    ].join('\n');
    const result = parseOrphanedManagersFromPs(lines, sessionDir);
    assert.equal(result.length, 2);
    const pids = result.map(r => r.pid).sort((a, b) => a - b);
    assert.deepEqual(pids, [1001, 1004]);
});

// ---------------------------------------------------------------------------
// writeActivePidFile / clearActivePidFile
// ---------------------------------------------------------------------------

test('writeActivePidFile writes the pid and clearActivePidFile removes it', () => {
    const tmp = makeTmp();
    writeActivePidFile(tmp, 99916);
    const pidPath = path.join(tmp, '.active_manager.pid');
    assert.ok(fs.existsSync(pidPath), 'pidfile should exist after write');
    assert.equal(fs.readFileSync(pidPath, 'utf-8').trim(), '99916');
    clearActivePidFile(tmp);
    assert.ok(!fs.existsSync(pidPath), 'pidfile should be gone after clear');
    fs.rmSync(tmp, { recursive: true });
});

test('clearActivePidFile is ENOENT-safe when file does not exist', () => {
    const tmp = makeTmp();
    // Should not throw
    assert.doesNotThrow(() => clearActivePidFile(tmp));
    fs.rmSync(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// reapOrphanedManagersAtIterationStart — AC-BPBH-02
// ---------------------------------------------------------------------------

test('reapOrphanedManagersAtIterationStart: SIGTERMs orphan from prior iteration and emits activity event', () => {
    const tmp = makeTmp();
    const sessionDir = tmp;

    // State file (minimal for writeActivityEntry)
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        active: true,
        schema_version: LATEST_SCHEMA_VERSION,
        activity: [],
    }));

    const stalePid = 99916;
    const stalePsLine = `${stalePid} 1 04:30:00 /usr/bin/claude --dangerously-skip-permissions --add-dir ${sessionDir} --max-turns 200`;

    const killed = [];
    const logs = [];

    const opts = {
        psOutput: stalePsLine,
        kill: (pid) => killed.push(pid),
    };

    const log = (msg) => logs.push(msg);
    const reaped = reapOrphanedManagersAtIterationStart(statePath, sessionDir, log, opts);

    // AC-BPBH-02: the stale pid was reaped
    assert.ok(killed.includes(stalePid), `expected stalePid ${stalePid} to be SIGTERMd`);
    assert.equal(killed.length, 1, 'exactly one kill call');
    assert.ok(logs.some(l => l.includes(`pid=${stalePid}`)), 'log should mention reaped pid');

    // Activity event was emitted
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const reapedEvents = (state.activity ?? []).filter(e => e.event === 'orphan_manager_reaped');
    assert.equal(reapedEvents.length, 1, 'exactly one orphan_manager_reaped event');
    assert.equal(reapedEvents[0].pid, stalePid);

    // Return value
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].pid, stalePid);

    fs.rmSync(tmp, { recursive: true });
});

test('reapOrphanedManagersAtIterationStart: reads orphan pid from pidfile when not in ps output', () => {
    const tmp = makeTmp();
    const sessionDir = tmp;
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: LATEST_SCHEMA_VERSION, activity: [] }));

    const stalePid = 77777;
    // Write pidfile — simulates iter N manager that exited but left pidfile
    writeActivePidFile(sessionDir, stalePid);

    const killed = [];
    const opts = {
        psOutput: '', // nothing in ps
        kill: (pid) => killed.push(pid),
    };

    reapOrphanedManagersAtIterationStart(statePath, sessionDir, () => {}, opts);

    assert.ok(killed.includes(stalePid), 'pidfile pid should be killed even if not in ps');

    fs.rmSync(tmp, { recursive: true });
});

test('reapOrphanedManagersAtIterationStart: does not kill self (process.pid)', () => {
    const tmp = makeTmp();
    const sessionDir = tmp;
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: LATEST_SCHEMA_VERSION, activity: [] }));

    const selfPid = process.pid;
    const selfLine = `${selfPid} 1 00:01:00 /usr/bin/claude --dangerously-skip-permissions --add-dir ${sessionDir}`;

    const killed = [];
    const opts = {
        psOutput: selfLine,
        kill: (pid) => killed.push(pid),
    };

    reapOrphanedManagersAtIterationStart(statePath, sessionDir, () => {}, opts);
    assert.ok(!killed.includes(selfPid), 'must not kill self');

    fs.rmSync(tmp, { recursive: true });
});

test('reapOrphanedManagersAtIterationStart: no-ops when no orphans', () => {
    const tmp = makeTmp();
    const sessionDir = tmp;
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: LATEST_SCHEMA_VERSION, activity: [] }));

    const killed = [];
    const opts = {
        psOutput: '1001 1 00:01:00 some other process\n1002 1 00:01:00 sleep 9999',
        kill: (pid) => killed.push(pid),
    };

    const reaped = reapOrphanedManagersAtIterationStart(statePath, sessionDir, () => {}, opts);
    assert.equal(killed.length, 0);
    assert.equal(reaped.length, 0);

    fs.rmSync(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// AC-BPBH-04: LATEST_SCHEMA_VERSION unchanged
// ---------------------------------------------------------------------------

test('AC-BPBH-04: LATEST_SCHEMA_VERSION is not bumped by R-OMS', () => {
    // Read compiled index.js directly to ensure no LATEST_SCHEMA_VERSION bump
    const indexPath = path.resolve(__dirname, '../types/index.js');
    const src = fs.readFileSync(indexPath, 'utf-8');
    // R-OMS itself is schema-neutral; the global constant later moved to 5 when
    // R-WSWA-1 (ba276e43) bumped LATEST_SCHEMA_VERSION 4→5 for worker_artifact_progress.
    const m = src.match(/LATEST_SCHEMA_VERSION\s*=\s*(\d+)/);
    assert.ok(m, 'LATEST_SCHEMA_VERSION should be present in types/index.js');
    assert.equal(Number(m[1]), 5, 'LATEST_SCHEMA_VERSION is 5 since R-WSWA-1 (ba276e43); R-OMS added no further bump');
});

test('AC-BPBH-04: orphan_manager_reaped event is in VALID_ACTIVITY_EVENTS', () => {
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('orphan_manager_reaped'),
        'orphan_manager_reaped must be in VALID_ACTIVITY_EVENTS'
    );
});

test('AC-BPBH-04: orphan_test_runner_reaped (existing) still in VALID_ACTIVITY_EVENTS', () => {
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('orphan_test_runner_reaped'),
        'orphan_test_runner_reaped must still be present'
    );
});
