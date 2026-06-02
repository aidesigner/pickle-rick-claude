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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-kimi-backend-sandbox-'));
    sandboxDirs.push(dir);
    return dir;
}

function mkTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-kimi-test-'));
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

// AC-KIMI-2-2 part 1: buildWorkerInvocation returns measured one-shot + swarm-off invocation

test('kimi-backend: isBackend recognizes kimi', () => {
    assert.equal(isBackend('kimi'), true);
});

test('kimi-backend: resolves kimi from state before env fallback', () => {
    withBackendEnv('codex', () => {
        assert.equal(resolveBackend({ backend: 'kimi' }), 'kimi');
    });
});

test('kimi-backend: resolves kimi from PICKLE_BACKEND env', () => {
    withBackendEnv('kimi', () => {
        assert.equal(resolveBackend({}), 'kimi');
    });
});

test('kimi-backend: reads kimi backend from state file', () => {
    const dir = mkTmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'kimi', active: true, schema_version: 3 }));
    assert.equal(resolveBackendFromStateFile(statePath), 'kimi');
});

test('kimi-backend: worker invocation uses --print + --agent-file (INV-SWARM-OFF) + -p', () => {
    const prompt = 'implement kimi worker task';
    const inv = buildWorkerInvocation('kimi', { prompt, addDirs: [] });

    assert.equal(inv.cmd, 'kimi');
    assert.equal(inv.backend, 'kimi');
    // C1: --print one-shot flag must be present
    assert.ok(inv.args.includes('--print'), 'must include --print one-shot flag');
    // C2: -p prompt flag must be present
    assert.ok(inv.args.includes('-p'), 'must include -p one-shot flag');
    assert.equal(inv.args[inv.args.indexOf('-p') + 1], prompt, 'prompt must follow -p');
    // INV-SWARM-OFF: --agent-file pointing to no-swarm spec must be present
    assert.ok(inv.args.includes('--agent-file'), 'must include --agent-file (INV-SWARM-OFF)');
    const agentFilePath = inv.args[inv.args.indexOf('--agent-file') + 1];
    assert.ok(
        typeof agentFilePath === 'string' && agentFilePath.endsWith('kimi-no-swarm.yaml'),
        `--agent-file must point to kimi-no-swarm.yaml (got: ${agentFilePath})`,
    );
    // kimi has no --no-subagents flag; must NOT be present
    assert.equal(inv.args.includes('--no-subagents'), false, 'must not include --no-subagents (not supported by kimi)');
});

test('kimi-backend: worker invocation threads model when provided', () => {
    const inv = buildWorkerInvocation('kimi', {
        prompt: 'kimi with model',
        addDirs: [],
        model: 'kimi-k2',
    });

    assert.equal(inv.cmd, 'kimi');
    assert.ok(inv.args.includes('--model'), 'must include --model flag');
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'kimi-k2');
    assert.ok(inv.args.includes('--agent-file'));
    assert.ok(inv.args.includes('-p'));
});

test('kimi-backend: worker invocation omits --model when not provided', () => {
    const inv = buildWorkerInvocation('kimi', { prompt: 'no model', addDirs: [] });
    assert.equal(inv.args.includes('--model'), false, '--model absent when not specified');
});

test('kimi-backend: worker invocation trims whitespace-only model', () => {
    const inv = buildWorkerInvocation('kimi', { prompt: 'trim test', addDirs: [], model: '  ' });
    assert.equal(inv.args.includes('--model'), false, '--model absent for whitespace-only model');
});

test('kimi-backend: manager invocation uses same kimi structure as worker', () => {
    const inv = buildManagerInvocation('kimi', {
        prompt: 'manage kimi lifecycle',
        addDirs: [],
        model: 'kimi-k2-pro',
    });

    assert.equal(inv.cmd, 'kimi');
    assert.equal(inv.backend, 'kimi');
    assert.ok(inv.args.includes('--agent-file'), 'manager must include --agent-file (INV-SWARM-OFF)');
    assert.ok(inv.args.includes('--print'), 'manager must use --print one-shot flag');
    assert.ok(inv.args.includes('-p'), 'manager must use -p flag');
    assert.ok(inv.args.includes('--model'));
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'kimi-k2-pro');
    // manager-specific flags from claude invocation must NOT appear
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
});

test('kimi-backend: backendEnvOverrides stamps PICKLE_BACKEND=kimi', () => {
    assert.deepEqual(backendEnvOverrides('kimi'), { PICKLE_BACKEND: 'kimi' });
});

// AC-KIMI-2-2 part 2: --teams --backend kimi is rejected

test('kimi-backend: setup --tmux --teams --backend kimi rejects with non-zero exit', () => {
    const dataRoot = makeSandboxDataRoot();
    const result = spawnSync(
        process.execPath,
        [SETUP, '--tmux', '--teams', '--backend', 'kimi', '--task', 'kimi-teams-conflict'],
        {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
            timeout: 15_000,
        },
    );
    assert.notEqual(result.status, 0, 'expected non-zero exit when --teams + --backend kimi');
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.match(output, /kimi|claude/i, 'error message must mention kimi or claude');
});
