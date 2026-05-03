import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    evaluateLaunchSizing,
    initializeNewSession,
    parseArguments,
} from '../bin/setup.js';

const setupBin = path.resolve(import.meta.dirname, '../bin/setup.js');

function withDataRoot(fn) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-smoke-data-'));
    const previous = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try {
        return fn(dataRoot);
    } finally {
        if (previous === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previous;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

test('hermes-smoke: setup persists hermes backend identity', () => {
    withDataRoot(() => {
        const args = parseArguments(['--backend', 'hermes', '--task', 'hermes backend identity']);
        const session = initializeNewSession(args);
        const persisted = JSON.parse(fs.readFileSync(path.join(session.sessionRoot, 'state.json'), 'utf-8'));

        assert.equal(session.state.backend, 'hermes');
        assert.equal(persisted.backend, 'hermes');
    });
});

test('hermes-smoke: backend validation lists hermes as accepted value', () => {
    const result = spawnSync(process.execPath, [setupBin, '--backend', 'bogus', '--task', 'invalid hermes backend'], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--backend must be one of: claude, codex, hermes/);
});

test('hermes-smoke: launch sizing uses hermes throughput baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-sizing-'));
    try {
        fs.writeFileSync(
            path.join(dir, 'decomposition_manifest.json'),
            JSON.stringify({ tickets: new Array(9).fill(0).map((_, i) => ({ id: `h${i}` })) }),
        );
        const config = parseArguments(['--max-time', '30', '--backend', 'hermes', '--task', 'hermes sizing']);
        const captured = [];

        const result = evaluateLaunchSizing(dir, config, message => captured.push(message));

        assert.equal(result.backend, 'hermes');
        assert.equal(result.throughput, 4.5);
        assert.match(captured.join(''), /at 4\.5 t\/h on hermes/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hermes-smoke: launch sizing falls back to built-in hermes baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-sizing-'));
    try {
        fs.writeFileSync(
            path.join(dir, 'decomposition_manifest.json'),
            JSON.stringify({ tickets: new Array(9).fill(0).map((_, i) => ({ id: `h${i}` })) }),
        );
        const result = evaluateLaunchSizing(dir, {
            timeLimit: 30,
            throughputBaselines: { claude: 5 },
            backend: 'hermes',
            acknowledgeUndersized: false,
        }, () => {});

        assert.equal(result.backend, 'hermes');
        assert.equal(result.throughput, 4.5);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
