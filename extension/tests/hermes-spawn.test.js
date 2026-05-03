// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    backendEnvOverrides,
    buildManagerInvocation,
    buildWorkerInvocation,
    isBackend,
    resolveBackend,
    resolveBackendFromStateFile,
} from '../services/backend-spawn.js';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-spawn-'));
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

test('hermes-spawn: resolves hermes from state before env fallback', () => {
    withBackendEnv('codex', () => {
        assert.equal(isBackend('hermes'), true);
        assert.equal(resolveBackend({ backend: 'hermes' }), 'hermes');
    });
});

test('hermes-spawn: resolves hermes from PICKLE_BACKEND env', () => {
    withBackendEnv('hermes', () => {
        assert.equal(resolveBackend({}), 'hermes');
    });
});

test('hermes-spawn: reads hermes backend from state file', () => {
    const dir = mkTmpDir();
    try {
        const statePath = path.join(dir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({ backend: 'hermes', active: true, schema_version: 3 }));

        assert.equal(resolveBackendFromStateFile(statePath), 'hermes');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hermes-spawn: worker invocation uses isolated hermes query mode', () => {
    const inv = buildWorkerInvocation('hermes', {
        prompt: 'spawn hermes worker',
        addDirs: [],
    });

    assert.equal(inv.cmd, 'hermes');
    assert.equal(inv.backend, 'hermes');
    assert.deepEqual(inv.args.slice(0, 4), ['chat', '-q', 'spawn hermes worker', '-Q']);
    assert.ok(inv.args.includes('--ignore-rules'));
    assert.ok(inv.args.includes('--ignore-user-config'));
});

test('hermes-spawn: worker invocation threads toolsets provider model and max turns', () => {
    const inv = buildWorkerInvocation('hermes', {
        prompt: 'configured hermes worker',
        addDirs: [],
        toolsets: ['terminal', ' file ', 'code_execution'],
        provider: 'openrouter',
        model: 'openrouter/test-model',
        maxTurns: 9,
    });

    assert.equal(inv.args[inv.args.indexOf('--toolsets') + 1], 'terminal,file,code_execution');
    assert.equal(inv.args[inv.args.indexOf('--provider') + 1], 'openrouter');
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'openrouter/test-model');
    assert.equal(inv.args[inv.args.indexOf('--max-turns') + 1], '9');
});

test('hermes-spawn: worker invocation omits empty toolsets and nonpositive max turns', () => {
    const inv = buildWorkerInvocation('hermes', {
        prompt: 'minimal hermes worker',
        addDirs: [],
        toolsets: [' ', ''],
        maxTurns: 0,
    });

    assert.equal(inv.args.includes('--toolsets'), false);
    assert.equal(inv.args.includes('--max-turns'), false);
});

test('hermes-spawn: manager invocation uses hermes backend env identity', () => {
    const inv = buildManagerInvocation('hermes', {
        prompt: 'manage hermes lifecycle',
        addDirs: [],
        toolsets: ['terminal', 'file'],
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4',
        maxTurns: 3,
        streamJson: true,
        noSessionPersistence: true,
    });

    assert.equal(inv.cmd, 'hermes');
    assert.equal(inv.backend, 'hermes');
    assert.deepEqual(inv.args.slice(0, 4), ['chat', '-q', 'manage hermes lifecycle', '-Q']);
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.deepEqual(backendEnvOverrides('hermes'), { PICKLE_BACKEND: 'hermes' });
});
