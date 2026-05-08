// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function run(args, dataRoot) {
    return execFileSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
    });
}

function sessionRoot(output) {
    const match = output.match(/SESSION_ROOT=(.+)/);
    if (!match) throw new Error(`SESSION_ROOT not found:\n${output}`);
    return match[1].trim();
}

function withDataRoot(fn) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-icp-'));
    try {
        return fn(dataRoot);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

// AC-ICP-04: state.json:max_iterations=100 → resume returns cap=100 not default
test('setup.resume-honors-persisted-cap: max_iterations=100 in state.json is honored without --max-iterations override', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--max-iterations', '100', '--task', 'icp04-persisted-cap'], dataRoot));
        const statePath = path.join(sp, 'state.json');

        assert.equal(
            JSON.parse(fs.readFileSync(statePath, 'utf-8')).max_iterations,
            100,
            'initial setup must persist max_iterations=100',
        );

        run(['--resume', sp], dataRoot);

        const resumed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resumed.max_iterations, 100, 'resume without --max-iterations must honor persisted max_iterations=100, not re-derive default');
    });
});

test('setup.resume-honors-persisted-cap: explicit --max-iterations on resume overrides persisted value', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--max-iterations', '100', '--task', 'icp-override-persisted'], dataRoot));
        const statePath = path.join(sp, 'state.json');

        run(['--resume', sp, '--max-iterations', '5'], dataRoot);

        assert.equal(
            JSON.parse(fs.readFileSync(statePath, 'utf-8')).max_iterations,
            5,
            'explicit --max-iterations on resume must override persisted value',
        );
    });
});

test('setup.resume-honors-persisted-cap: persisted worker_timeout_seconds honored on resume', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--worker-timeout', '999', '--task', 'icp-worker-timeout'], dataRoot));
        const statePath = path.join(sp, 'state.json');

        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).worker_timeout_seconds, 999);

        run(['--resume', sp], dataRoot);

        assert.equal(
            JSON.parse(fs.readFileSync(statePath, 'utf-8')).worker_timeout_seconds,
            999,
            'resume without --worker-timeout must honor persisted worker_timeout_seconds',
        );
    });
});

test('setup.resume-honors-persisted-cap: persisted max_time_minutes honored on resume without --max-time', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--max-time', '60', '--task', 'icp-max-time'], dataRoot));
        const statePath = path.join(sp, 'state.json');

        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).max_time_minutes, 60);

        run(['--resume', sp], dataRoot);

        assert.equal(
            JSON.parse(fs.readFileSync(statePath, 'utf-8')).max_time_minutes,
            60,
            'resume without --max-time must honor persisted max_time_minutes',
        );
    });
});

test('setup.resume-honors-persisted-cap: persisted backend honored on resume without explicit --backend', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--backend', 'hermes', '--task', 'icp-backend'], dataRoot));
        const statePath = path.join(sp, 'state.json');

        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).backend, 'hermes');

        run(['--resume', sp], dataRoot);

        assert.equal(
            JSON.parse(fs.readFileSync(statePath, 'utf-8')).backend,
            'hermes',
            'resume without --backend must honor persisted backend value',
        );
    });
});

// R-ICP-4: initial setup persists CLI args into state.json
test('setup.resume-honors-persisted-cap: initial setup persists --max-iterations into state.json', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--max-iterations', '42', '--task', 'icp4-persist-iter'], dataRoot));
        const state = JSON.parse(fs.readFileSync(path.join(sp, 'state.json'), 'utf-8'));
        assert.equal(state.max_iterations, 42, 'initial setup must persist --max-iterations value into state.json');
    });
});

test('setup.resume-honors-persisted-cap: initial setup persists --worker-timeout into state.json', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--worker-timeout', '600', '--task', 'icp4-persist-timeout'], dataRoot));
        const state = JSON.parse(fs.readFileSync(path.join(sp, 'state.json'), 'utf-8'));
        assert.equal(state.worker_timeout_seconds, 600, 'initial setup must persist --worker-timeout value into state.json');
    });
});

test('setup.resume-honors-persisted-cap: initial setup persists --max-time into state.json when explicit', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--max-time', '90', '--task', 'icp4-persist-time'], dataRoot));
        const state = JSON.parse(fs.readFileSync(path.join(sp, 'state.json'), 'utf-8'));
        assert.equal(state.max_time_minutes, 90, 'initial setup must persist --max-time value into state.json');
    });
});
