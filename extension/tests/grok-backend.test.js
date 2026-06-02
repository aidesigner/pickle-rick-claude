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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-grok-backend-sandbox-'));
    sandboxDirs.push(dir);
    return dir;
}

function mkTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-grok-test-'));
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

// AC-GROK-2-2 part 1: buildWorkerInvocation returns measured one-shot + swarm-off invocation

test('grok-backend: isBackend recognizes grok', () => {
    assert.equal(isBackend('grok'), true);
});

test('grok-backend: resolves grok from state before env fallback', () => {
    withBackendEnv('codex', () => {
        assert.equal(resolveBackend({ backend: 'grok' }), 'grok');
    });
});

test('grok-backend: resolves grok from PICKLE_BACKEND env', () => {
    withBackendEnv('grok', () => {
        assert.equal(resolveBackend({}), 'grok');
    });
});

test('grok-backend: reads grok backend from state file', () => {
    const dir = mkTmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'grok', active: true, schema_version: 3 }));
    assert.equal(resolveBackendFromStateFile(statePath), 'grok');
});

test('grok-backend: worker invocation uses one-shot -p flag with swarm-disable', () => {
    const prompt = 'implement grok worker task';
    const inv = buildWorkerInvocation('grok', { prompt, addDirs: [] });

    assert.equal(inv.cmd, 'grok');
    assert.equal(inv.backend, 'grok');
    // one-shot flag must be present
    assert.ok(inv.args.includes('-p'), 'must include -p one-shot flag');
    assert.equal(inv.args[inv.args.indexOf('-p') + 1], prompt, 'prompt must follow -p');
    // INV-SWARM-OFF: --no-subagents must be present
    assert.ok(inv.args.includes('--no-subagents'), 'must include --no-subagents (INV-SWARM-OFF)');
    // no --output-format flag (plain is default, no JSON wrapping needed)
    assert.equal(inv.args.includes('--output-format'), false, 'must not include --output-format');
});

test('grok-backend: worker invocation threads model when provided', () => {
    const inv = buildWorkerInvocation('grok', {
        prompt: 'grok with model',
        addDirs: [],
        model: 'grok-build',
    });

    assert.equal(inv.cmd, 'grok');
    assert.ok(inv.args.includes('--model'), 'must include --model flag');
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'grok-build');
    assert.ok(inv.args.includes('--no-subagents'));
    assert.ok(inv.args.includes('-p'));
});

test('grok-backend: worker invocation omits --model when not provided', () => {
    const inv = buildWorkerInvocation('grok', { prompt: 'no model', addDirs: [] });
    assert.equal(inv.args.includes('--model'), false, '--model absent when not specified');
});

test('grok-backend: worker invocation trims whitespace-only model', () => {
    const inv = buildWorkerInvocation('grok', { prompt: 'trim test', addDirs: [], model: '  ' });
    assert.equal(inv.args.includes('--model'), false, '--model absent for whitespace-only model');
});

test('grok-backend: manager invocation uses same grok structure as worker', () => {
    const inv = buildManagerInvocation('grok', {
        prompt: 'manage grok lifecycle',
        addDirs: [],
        model: 'grok-composer-2.5-fast',
    });

    assert.equal(inv.cmd, 'grok');
    assert.equal(inv.backend, 'grok');
    assert.ok(inv.args.includes('--no-subagents'), 'manager must include INV-SWARM-OFF');
    assert.ok(inv.args.includes('-p'), 'manager must use -p one-shot flag');
    assert.ok(inv.args.includes('--model'));
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'grok-composer-2.5-fast');
    // manager-specific flags from claude invocation must NOT appear
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
});

test('grok-backend: backendEnvOverrides stamps PICKLE_BACKEND=grok', () => {
    assert.deepEqual(backendEnvOverrides('grok'), { PICKLE_BACKEND: 'grok' });
});

// AC-GROK-2-2 part 2: --teams --backend grok is rejected

test('grok-backend: setup --tmux --teams --backend grok rejects with non-zero exit', () => {
    const dataRoot = makeSandboxDataRoot();
    const result = spawnSync(
        process.execPath,
        [SETUP, '--tmux', '--teams', '--backend', 'grok', '--task', 'grok-teams-conflict'],
        {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
            timeout: 15_000,
        },
    );
    assert.notEqual(result.status, 0, 'expected non-zero exit when --teams + --backend grok');
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.match(output, /grok|claude/i, 'error message must mention grok or claude');
});
