// BMAD residual P0.6 — `--skip-readiness <reason>` flag and mux-runner wiring.
// Source: extension/src/bin/check-readiness.ts (parseArgs + main),
// extension/src/bin/mux-runner.ts (runMuxReadinessGate skipReason forwarding).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runMuxReadinessGate } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-readiness-skip-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function readActivityLines(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    return files.flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split('\n').filter(Boolean).map(JSON.parse));
}

test('check-readiness: --skip-readiness without reason exits 64', () => {
    const sessionDir = tmpDir();
    try {
        const result = spawnSync(process.execPath, [
            BIN,
            '--session-dir', sessionDir,
            '--skip-readiness',
        ], { encoding: 'utf-8', timeout: 10_000 });
        assert.equal(result.status, 64);
        assert.match(result.stderr, /--skip-readiness requires a reason argument/);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: --skip-readiness with empty-string reason exits 64', () => {
    const sessionDir = tmpDir();
    try {
        const result = spawnSync(process.execPath, [
            BIN,
            '--session-dir', sessionDir,
            '--skip-readiness', '',
        ], { encoding: 'utf-8', timeout: 10_000 });
        assert.equal(result.status, 64);
        assert.match(result.stderr, /--skip-readiness requires a reason argument/);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: --skip-readiness with reason exits 0 and prints status:skipped', () => {
    const sessionDir = tmpDir();
    const dataRoot = tmpDir('pickle-data-skip-');
    try {
        const reason = 'bundle pre-validated by refinement team';
        const result = spawnSync(process.execPath, [
            BIN,
            '--session-dir', sessionDir,
            '--skip-readiness', reason,
        ], {
            encoding: 'utf-8',
            timeout: 10_000,
            env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'skipped');
        assert.equal(out.reason, reason);
        assert.equal(out.elapsed_ms, 0);

        // Activity event was recorded.
        const events = readActivityLines(dataRoot);
        const skipEvent = events.find((e) => e.event === 'readiness_skipped');
        assert.ok(skipEvent, `expected readiness_skipped event, got: ${JSON.stringify(events)}`);
        assert.equal(skipEvent.source, 'pickle');
        assert.equal(skipEvent.session, path.basename(sessionDir));
        assert.equal(skipEvent.gate_payload?.reason, reason);
        assert.ok(typeof skipEvent.gate_payload?.timestamp === 'string', 'timestamp should be a string');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('check-readiness: --skip-readiness skips PRD-map validation entirely (would fail otherwise)', () => {
    const sessionDir = tmpDir();
    const dataRoot = tmpDir('pickle-data-skip-');
    try {
        // Plant a manifest with an unmapped requirement that would fail readiness.
        fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
            requirements: ['REQ-UNMAPPED'],
            tickets: [],
        }));

        const result = spawnSync(process.execPath, [
            BIN,
            '--session-dir', sessionDir,
            '--skip-readiness', 'pre-validated',
        ], {
            encoding: 'utf-8',
            timeout: 10_000,
            env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'skipped');
        // No findings, no report path written when skipping.
        assert.equal(out.findings, undefined);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// mux-runner wiring: runMuxReadinessGate forwards `--skip-readiness <reason>`
// when input.skipReason is set.
// ---------------------------------------------------------------------------

function makeStubExtensionRoot(stubScriptBody) {
    const root = tmpDir('mux-extroot-');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const stubPath = path.join(binDir, 'check-readiness.js');
    fs.writeFileSync(stubPath, stubScriptBody, { mode: 0o755 });
    return root;
}

test('mux-runner: runMuxReadinessGate forwards --skip-readiness <reason> when skipReason set', () => {
    const sessionDir = tmpDir('mux-session-');
    const argDumpFile = path.join(sessionDir, 'argv.json');
    // Stub check-readiness.js writes its argv to disk for inspection then exits 0.
    const stubBody = `#!/usr/bin/env node
import * as fs from 'fs';
fs.writeFileSync(${JSON.stringify(argDumpFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;
    const extensionRoot = makeStubExtensionRoot(stubBody);
    const logs = [];
    try {
        const status = runMuxReadinessGate({
            sessionDir,
            repoRoot: process.cwd(),
            extensionRoot,
            log: (m) => logs.push(m),
            skipReason: 'pre-validated by refinement team',
        });
        assert.equal(status, 0);
        const argv = JSON.parse(fs.readFileSync(argDumpFile, 'utf-8'));
        assert.deepEqual(argv, [
            '--session-dir', sessionDir,
            '--repo-root', process.cwd(),
            '--skip-readiness', 'pre-validated by refinement team',
        ]);
        assert.ok(logs.some((m) => /skip_readiness_reason/.test(m)), `expected log to mention skip_readiness_reason: ${logs.join(' | ')}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('mux-runner: runMuxReadinessGate omits --skip-readiness when skipReason absent', () => {
    const sessionDir = tmpDir('mux-session-');
    const argDumpFile = path.join(sessionDir, 'argv.json');
    const stubBody = `#!/usr/bin/env node
import * as fs from 'fs';
fs.writeFileSync(${JSON.stringify(argDumpFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;
    const extensionRoot = makeStubExtensionRoot(stubBody);
    try {
        const status = runMuxReadinessGate({
            sessionDir,
            repoRoot: process.cwd(),
            extensionRoot,
            log: () => {},
        });
        assert.equal(status, 0);
        const argv = JSON.parse(fs.readFileSync(argDumpFile, 'utf-8'));
        assert.deepEqual(argv, [
            '--session-dir', sessionDir,
            '--repo-root', process.cwd(),
        ]);
        assert.ok(!argv.includes('--skip-readiness'), 'argv must not contain --skip-readiness when skipReason is absent');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('mux-runner: runMuxReadinessGate omits --skip-readiness when skipReason is empty string', () => {
    const sessionDir = tmpDir('mux-session-');
    const argDumpFile = path.join(sessionDir, 'argv.json');
    const stubBody = `#!/usr/bin/env node
import * as fs from 'fs';
fs.writeFileSync(${JSON.stringify(argDumpFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;
    const extensionRoot = makeStubExtensionRoot(stubBody);
    try {
        const status = runMuxReadinessGate({
            sessionDir,
            repoRoot: process.cwd(),
            extensionRoot,
            log: () => {},
            skipReason: '',
        });
        assert.equal(status, 0);
        const argv = JSON.parse(fs.readFileSync(argDumpFile, 'utf-8'));
        assert.ok(!argv.includes('--skip-readiness'), 'empty-string skipReason should not forward the flag');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

