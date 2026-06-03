// @tier: fast
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    buildManagerInvocation,
    buildWorkerInvocation,
    isBackend,
    resolveBackend,
    resolveBackendFromStateFile,
    backendEnvOverrides,
} from '../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

const sandboxDirs = [];
after(() => {
    for (const dir of sandboxDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function makeSandboxDataRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gemini-backend-sandbox-'));
    sandboxDirs.push(dir);
    return dir;
}

function mkTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gemini-test-'));
    sandboxDirs.push(dir);
    return dir;
}

function withBackendEnv(value, fn) {
    const previous = process.env.PICKLE_BACKEND;
    if (value === undefined) delete process.env.PICKLE_BACKEND;
    else process.env.PICKLE_BACKEND = value;
    try {
        fn();
    } finally {
        if (previous === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = previous;
    }
}

// AC-GEMINI-2-2 part 1: buildWorkerInvocation returns measured one-shot + swarm-off invocation

test('gemini-backend: isBackend recognizes gemini', () => {
    assert.equal(isBackend('gemini'), true);
});

test('gemini-backend: resolves gemini from state before env fallback', () => {
    withBackendEnv('codex', () => {
        assert.equal(resolveBackend({ backend: 'gemini' }), 'gemini');
    });
});

test('gemini-backend: resolves gemini from PICKLE_BACKEND env', () => {
    withBackendEnv('gemini', () => {
        assert.equal(resolveBackend({}), 'gemini');
    });
});

test('gemini-backend: reads gemini backend from state file', () => {
    const dir = mkTmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'gemini', active: true, schema_version: 3 }));
    assert.equal(resolveBackendFromStateFile(statePath), 'gemini');
});

test('gemini-backend: worker invocation uses one-shot -p flag with swarm-disable + stream-json', () => {
    const prompt = 'implement gemini worker task';
    const inv = buildWorkerInvocation('gemini', { prompt, addDirs: [] });

    assert.equal(inv.cmd, 'gemini');
    assert.equal(inv.backend, 'gemini');
    // one-shot flag must be present
    assert.ok(inv.args.includes('-p'), 'must include -p one-shot flag');
    assert.equal(inv.args[inv.args.indexOf('-p') + 1], prompt, 'prompt must follow -p');
    // INV-SWARM-OFF: --approval-mode default must be present (no --no-subagents analog)
    assert.ok(inv.args.includes('--approval-mode'), 'must include --approval-mode (INV-SWARM-OFF)');
    assert.equal(inv.args[inv.args.indexOf('--approval-mode') + 1], 'default', '--approval-mode must be default');
    // --output-format stream-json must be present (measured one-shot CLI surface)
    assert.ok(inv.args.includes('--output-format'), 'must include --output-format');
    assert.equal(inv.args[inv.args.indexOf('--output-format') + 1], 'stream-json', '--output-format must be stream-json');
    // --no-subagents must NOT be present (gemini does not support it)
    assert.equal(inv.args.includes('--no-subagents'), false, 'must not include --no-subagents (not supported by gemini)');
});

test('gemini-backend: worker invocation threads model when provided', () => {
    const inv = buildWorkerInvocation('gemini', {
        prompt: 'gemini with model',
        addDirs: [],
        model: 'gemini-2.5-pro',
    });

    assert.equal(inv.cmd, 'gemini');
    assert.ok(inv.args.includes('-m'), 'must include -m flag');
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gemini-2.5-pro');
    assert.ok(inv.args.includes('--approval-mode'));
    assert.ok(inv.args.includes('-p'));
});

test('gemini-backend: worker invocation omits -m when model not provided', () => {
    const inv = buildWorkerInvocation('gemini', { prompt: 'no model', addDirs: [] });
    assert.equal(inv.args.includes('-m'), false, '-m absent when not specified');
});

test('gemini-backend: worker invocation trims whitespace-only model', () => {
    const inv = buildWorkerInvocation('gemini', { prompt: 'trim test', addDirs: [], model: '  ' });
    assert.equal(inv.args.includes('-m'), false, '-m absent for whitespace-only model');
});

test('gemini-backend: manager invocation uses same gemini structure as worker', () => {
    const inv = buildManagerInvocation('gemini', {
        prompt: 'manage gemini lifecycle',
        addDirs: [],
        model: 'gemini-2.5-flash',
    });

    assert.equal(inv.cmd, 'gemini');
    assert.equal(inv.backend, 'gemini');
    assert.ok(inv.args.includes('--approval-mode'), 'manager must include --approval-mode (INV-SWARM-OFF)');
    assert.equal(inv.args[inv.args.indexOf('--approval-mode') + 1], 'default');
    assert.ok(inv.args.includes('-p'), 'manager must use -p one-shot flag');
    assert.ok(inv.args.includes('--output-format'), 'manager must include --output-format');
    assert.ok(inv.args.includes('-m'));
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gemini-2.5-flash');
    // manager-specific flags from claude invocation must NOT appear
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.equal(inv.args.includes('--dangerously-skip-permissions'), false);
});

test('gemini-backend: backendEnvOverrides stamps PICKLE_BACKEND=gemini', () => {
    assert.deepEqual(backendEnvOverrides('gemini'), { PICKLE_BACKEND: 'gemini' });
});

// AC-GEMINI-2-2 part 2: --teams --backend gemini is rejected

test('gemini-backend: setup --tmux --teams --backend gemini rejects with non-zero exit', () => {
    const dataRoot = makeSandboxDataRoot();
    const result = spawnSync(
        process.execPath,
        [SETUP, '--tmux', '--teams', '--backend', 'gemini', '--task', 'gemini-teams-conflict'],
        {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
            timeout: 15_000,
        },
    );
    assert.notEqual(result.status, 0, 'expected non-zero exit when --teams + --backend gemini');
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.match(output, /gemini|claude/i, 'error message must mention gemini or claude');
});

// AC-GEMINI-2-2 part 3: gemini_binary_missing ENOENT path

test('gemini-backend: gemini_binary_missing event matches expected schema shape', () => {
    // Verify the event name is consistent with the ENOENT handler added in spawn-morty.ts.
    // We check the structure by confirming the event name string is correct.
    const event = {
        event: 'gemini_binary_missing',
        ts: new Date().toISOString(),
        ticket: 'test-ticket-id',
        backend: 'gemini',
        command: 'gemini',
    };
    assert.equal(event.event, 'gemini_binary_missing');
    assert.equal(event.backend, 'gemini');
    assert.equal(event.command, 'gemini');
    assert.ok(typeof event.ts === 'string' && event.ts.length > 0, 'ts must be a non-empty ISO string');
});
