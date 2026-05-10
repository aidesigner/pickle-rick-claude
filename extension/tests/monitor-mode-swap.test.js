// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { respawnMonitorWindowForMode } from '../lib/monitor-respawn.js';
import { inferModeFromStep, checkAndSwapMode, renderMicroverseDashboard } from '../bin/monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSYSTEM_WATCHER_BIN = path.resolve(__dirname, '../bin/subsystem-watcher.js');

function makeSession() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mms-'));
}

function writeState(sessionDir, overrides = {}) {
    const state = {
        active: false,
        step: 'implement',
        iteration: 0,
        session_dir: sessionDir,
        ...overrides,
    };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('monitor-mode-swap', () => {
  it('(a) respawnMonitorWindowForMode invoked once with mode=microverse on pickle→anatomy-park', async () => {
    const sessionDir = makeSession();
    try {
        writeState(sessionDir, { step: 'implement' });

        const spawnCalls = [];
        function spySyncFn(cmd, args, _opts) {
            spawnCalls.push({ cmd, args: Array.from(args) });
            if (Array.isArray(args) && args[0] === 'display-message') {
                return { status: 0, stdout: 'test-session', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        }

        await respawnMonitorWindowForMode(sessionDir, 'anatomy-park', spySyncFn);

        const respawnCalls = spawnCalls.filter(
            c => c.cmd === 'tmux' && c.args[0] === 'respawn-pane',
        );
        assert.ok(respawnCalls.length >= 1, 'expected at least one tmux respawn-pane call');

        const pane0Call = respawnCalls.find(
            c => c.args.some(a => typeof a === 'string' && a.includes(':monitor.0')),
        );
        assert.ok(pane0Call, 'expected a respawn-pane call targeting :monitor.0');

        const command = pane0Call.args.at(-1);
        assert.ok(
            typeof command === 'string' && command.includes('--mode microverse'),
            `expected command to include --mode microverse, got: ${command}`,
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('(b) inferModeFromStep swaps mode within 2s when state.step changes without respawn', () => {
    const sessionDir = makeSession();
    try {
        writeState(sessionDir, { step: 'implement' });

        const logCapture = [];
        const logFn = (e) => logCapture.push(e);

        assert.equal(inferModeFromStep('implement'), 'pickle', 'implement maps to pickle');

        // Simulate mid-process step change without calling respawnMonitorWindowForMode
        writeState(sessionDir, { step: 'anatomy-park' });

        const start = Date.now();
        const newMode = checkAndSwapMode(sessionDir, 'pickle', logFn);
        const elapsed = Date.now() - start;

        assert.equal(newMode, 'microverse', 'checkAndSwapMode must return microverse after step change');
        assert.ok(elapsed < 2000, `mode swap must occur within 2s, took ${elapsed}ms`);
        assert.equal(logCapture.length, 1, 'should emit exactly one monitor_mode_swapped event');
        assert.equal(logCapture[0].event, 'monitor_mode_swapped');
        assert.equal(logCapture[0].mode, 'microverse');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('(c) renderMicroverseDashboard output contains Subsystems, Convergence, Stall, Metric Trend headers', () => {
    const sessionDir = makeSession();
    try {
        writeState(sessionDir, { step: 'anatomy-park', active: true });

        const state = {
            active: true,
            step: 'anatomy-park',
            iteration: 3,
            max_iterations: 50,
            session_dir: sessionDir,
            current_ticket: null,
            working_dir: sessionDir,
            start_time_epoch: Math.floor(Date.now() / 1000),
        };

        const microverseJson = {
            status: 'iterating',
            key_metric: { name: 'coverage', type: 'numeric', direction: 'higher', unit: '%' },
            convergence_target: 90,
            failure_history: [],
            convergence: {
                stall_counter: 1,
                stall_limit: 5,
                history: [
                    { iteration: 1, score: 75, action: 'accept' },
                    { iteration: 2, score: 78, action: 'accept' },
                    { iteration: 3, score: 80, action: 'accept' },
                ],
            },
        };

        const output = renderMicroverseDashboard(state, microverseJson);
        const plain = stripAnsi(output);

        assert.ok(plain.includes('Subsystems'), `missing 'Subsystems' header, got: ${plain.slice(0, 200)}`);
        assert.ok(plain.includes('Convergence'), `missing 'Convergence' header, got: ${plain.slice(0, 200)}`);
        assert.ok(plain.includes('Stall'), `missing 'Stall' header, got: ${plain.slice(0, 200)}`);
        assert.ok(plain.includes('Metric Trend'), `missing 'Metric Trend' header, got: ${plain.slice(0, 200)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('(d) producer_done=true makes pane reader emit Producer complete instead of warning', () => {
    const sessionDir = makeSession();
    try {
        writeState(sessionDir, {
            active: false,
            monitor_panes: [
                { producer_done: false },
                { producer_done: false },
                { producer_done: true },
                { producer_done: false },
            ],
        });

        fs.writeFileSync(
            path.join(sessionDir, 'microverse.json'),
            JSON.stringify({ status: 'iterating', current_subsystem: null }),
        );

        const result = spawnSync(process.execPath, [SUBSYSTEM_WATCHER_BIN, sessionDir], {
            env: { ...process.env },
            encoding: 'utf-8',
            timeout: 10000,
        });

        assert.notEqual(result.error?.code, 'ETIMEDOUT', `subsystem-watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `expected clean exit, got: ${result.stderr}`);
        assert.ok(
            result.stdout.includes('Producer complete'),
            `expected 'Producer complete' in stdout, got: ${result.stdout}`,
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
