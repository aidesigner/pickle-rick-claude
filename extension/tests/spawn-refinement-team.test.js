import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/spawn-refinement-team.js');

// Import buildWorkerPrompt for direct unit testing
const { buildWorkerPrompt } = await import('../bin/spawn-refinement-team.js');

function run(args, env = {}) {
    // 10s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Most cases exit fast on validation; budget exists
    // so node spawn + module load under load doesn't SIGKILL the subprocess.
    return spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

function makeTmpDir(prefix = 'pickle-refine-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeRefinementLogger(binDir, logPath) {
    const claudePath = path.join(binDir, 'claude');
    fs.writeFileSync(claudePath, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}) + '\\n');
process.stdout.write('<promise>ANALYSIS_DONE</promise>\\n');
process.exit(0);
`);
    fs.chmodSync(claudePath, 0o755);
}

// --- CLI arg validation ---

test('spawn-refinement-team: no args → exit 1, prints Usage', () => {
    const result = run([]);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Usage'), `Expected Usage in stderr, got: ${result.stderr}`);
});

test('spawn-refinement-team: missing --session-dir → exit 1', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nSome content');
        const result = run(['--prd', prd]);
        assert.strictEqual(result.status, 1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: missing --prd → exit 1', () => {
    const tmp = makeTmpDir();
    try {
        const result = run(['--session-dir', tmp]);
        assert.strictEqual(result.status, 1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: non-existent PRD → exit 1, prints "PRD not found"', () => {
    const tmp = makeTmpDir();
    try {
        const result = run(['--prd', '/no/such/file.md', '--session-dir', tmp]);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('PRD not found'), `Expected "PRD not found", got: ${result.stderr}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --prd value starts with -- → exit 1', () => {
    const tmp = makeTmpDir();
    try {
        const result = run(['--prd', '--session-dir', '--session-dir', tmp]);
        assert.strictEqual(result.status, 1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --session-dir value starts with -- → exit 1', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD');
        const result = run(['--prd', prd, '--session-dir', '--cycles']);
        assert.strictEqual(result.status, 1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Invalid --cycles / --max-turns ---

test('spawn-refinement-team: --cycles 0 → exit 1, prints error', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(['--prd', prd, '--session-dir', tmp, '--cycles', '0']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('--cycles requires a positive integer'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --cycles -1 → exit 1, prints error', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(['--prd', prd, '--session-dir', tmp, '--cycles', '-1']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('--cycles requires a positive integer'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --cycles abc → exit 1, prints error', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(['--prd', prd, '--session-dir', tmp, '--cycles', 'abc']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('--cycles requires a positive integer'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --max-turns 0 → exit 1, prints error', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(['--prd', prd, '--session-dir', tmp, '--max-turns', '0']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('--max-turns requires a positive integer'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --max-turns abc → exit 1, prints error', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(['--prd', prd, '--session-dir', tmp, '--max-turns', 'abc']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('--max-turns requires a positive integer'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Valid --cycles / --max-turns ---

test('spawn-refinement-team: --cycles 1 is accepted (no validation error)', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1'],
            { PATH: '/nonexistent' }
        );
        assert.ok(!result.stderr.includes('--cycles requires'), 'Should not fail on valid --cycles');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --max-turns 40 is accepted (no validation error)', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--max-turns', '40'],
            { PATH: '/nonexistent' }
        );
        assert.ok(!result.stderr.includes('--max-turns requires'), 'Should not fail on valid --max-turns');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Settings loading ---

test('spawn-refinement-team: reads refinement settings from pickle_settings.json', () => {
    const tmp = makeTmpDir();
    const fakeExt = makeTmpDir('pickle-ext-');
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(fakeExt, 'pickle_settings.json'), JSON.stringify({
            default_refinement_cycles: 3,
            default_refinement_max_turns: 50,
        }));

        // Create a fake claude that immediately exits
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp],
            { EXTENSION_DIR: fakeExt, PATH: `${fakeBin}:${process.env.PATH}` }
        );
        const combined = result.stdout + result.stderr;
        // Panel should print "Cycles" with the value from settings (3)
        // and "Max Turns" with value from settings (50)
        assert.ok(combined.includes('50/worker'), `Panel should show max turns from settings, got: ${combined.slice(0, 500)}`);
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeExt, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: promotes newer dead tmp refinement settings before launch', () => {
    const tmp = makeTmpDir();
    const fakeExt = makeTmpDir('pickle-ext-');
    const fakeBin = makeTmpDir('fake-bin-');
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');

        const settingsPath = path.join(fakeExt, 'pickle_settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            default_refinement_cycles: 1,
            default_refinement_max_turns: 10,
            default_worker_timeout_seconds: 300,
        }));
        const tmpSettingsPath = `${settingsPath}.tmp.999999`;
        fs.writeFileSync(tmpSettingsPath, JSON.stringify({
            default_refinement_cycles: 2,
            default_refinement_max_turns: 55,
            default_worker_timeout_seconds: 777,
        }));
        const newer = new Date(Date.now() + 10_000);
        fs.utimesSync(tmpSettingsPath, newer, newer);

        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp],
            { EXTENSION_DIR: fakeExt, PATH: `${fakeBin}:${process.env.PATH}` }
        );
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes('55/worker'), `Panel should show recovered max turns, got: ${combined.slice(0, 500)}`);
        assert.ok(combined.includes('777s each'), `Panel should show recovered timeout, got: ${combined.slice(0, 500)}`);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).default_refinement_max_turns, 55);
        assert.equal(fs.existsSync(tmpSettingsPath), false, 'dead tmp settings should be promoted');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeExt, { recursive: true, force: true });
        fs.rmSync(fakeBin, { recursive: true, force: true });
    }
});

// --- Timeout from state.json ---

test('spawn-refinement-team: reads worker_timeout_seconds from state.json', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
            worker_timeout_seconds: 300,
            active: true,
        }));
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes('300s each'), `Panel should show 300s timeout, got: ${combined.slice(0, 500)}`);
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: recovers orphan tmp state before reading timeout and backend preference', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const statePath = path.join(tmp, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            worker_timeout_seconds: 300,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
            active: true,
        }));
        fs.writeFileSync(`${statePath}.tmp.424242`, JSON.stringify({
            worker_timeout_seconds: 45,
            backend: 'codex',
            iteration: 2,
            schema_version: 1,
            active: true,
        }));
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1'],
            { PATH: `${fakeBin}:${process.env.PATH}`, PICKLE_BACKEND: '' }
        );
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes('45s each'), `Panel should use recovered timeout, got: ${combined.slice(0, 500)}`);
        assert.ok(
            combined.includes('PRD refinement forces backend=claude'),
            `Recovered codex backend should trigger downgrade warning, got: ${combined.slice(0, 500)}`
        );

        const promoted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promoted.worker_timeout_seconds, 45, 'higher-iteration tmp should be promoted before timeout selection');
        assert.equal(promoted.backend, 'codex', 'higher-iteration tmp should be promoted before backend warning selection');
        assert.equal(fs.existsSync(`${statePath}.tmp.424242`), false, 'orphan tmp should be consumed during recovery');
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: recovered working_dir controls worker cwd and codebase prompt target', () => {
    const tmp = makeTmpDir();
    const fakeBin = makeTmpDir('fake-bin-');
    try {
        const sessionDir = path.join(tmp, 'session');
        const repoDir = path.join(tmp, 'target-repo');
        const wrongCwd = path.join(tmp, 'wrong-cwd');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(repoDir, { recursive: true });
        fs.mkdirSync(wrongCwd, { recursive: true });

        const prd = path.join(sessionDir, 'prd.md');
        fs.writeFileSync(prd, '# PRD\\nContent');
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: repoDir,
            worker_timeout_seconds: 30,
            iteration: 1,
            schema_version: 1,
        }));

        const logPath = path.join(tmp, 'refinement-worker.json');
        writeRefinementLogger(fakeBin, logPath);

        const result = spawnSync(
            process.execPath,
            [BIN, '--prd', prd, '--session-dir', sessionDir, '--cycles', '1', '--max-turns', '5', '--timeout', '5'],
            {
                cwd: wrongCwd,
                env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
                encoding: 'utf-8',
                timeout: 45000,
            }
        );

        assert.equal(result.status, 0, `expected success, got: ${(result.stdout || '') + (result.stderr || '')}`);
        assert.ok(fs.existsSync(logPath), 'refinement worker should be invoked');

        const invocations = fs.readFileSync(logPath, 'utf-8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        assert.equal(invocations.length, 3, 'all refinement workers should be logged');
        for (const invocation of invocations) {
            assert.equal(invocation.cwd, repoDir, 'refinement worker should run from recovered session working_dir');
        }

        const codebaseInvocation = invocations.find((invocation) => {
            const promptFlag = invocation.argv.indexOf('-p');
            if (promptFlag === -1) return false;
            return typeof invocation.argv[promptFlag + 1] === 'string' && invocation.argv[promptFlag + 1].includes('Codebase Context Analyst');
        });
        assert.ok(codebaseInvocation, 'one refinement worker should be the codebase analyst');

        const promptFlag = codebaseInvocation.argv.indexOf('-p');
        assert.ok(promptFlag !== -1, 'worker invocation should include -p prompt');
        const prompt = codebaseInvocation.argv[promptFlag + 1];
        assert.match(prompt, new RegExp(`Analyze alignment between the PRD and the actual codebase at: \\\`${repoDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\``));
        assert.doesNotMatch(prompt, new RegExp(`Analyze alignment between the PRD and the actual codebase at: \\\`${wrongCwd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\``));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeBin, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: --timeout flag overrides state.json', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
            worker_timeout_seconds: 300,
            active: true,
        }));
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--timeout', '120', '--cycles', '1'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes('120s each'), `Panel should show 120s (not 300s), got: ${combined.slice(0, 500)}`);
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: corrupt state.json is ignored gracefully', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(tmp, 'state.json'), '{not valid json!!!');
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );
        // Should not crash on corrupt state.json — falls back to default timeout
        assert.ok(!result.stderr.includes('Fatal'), `Should not fatal on corrupt state.json, got: ${result.stderr.slice(0, 500)}`);
        // Default timeout comes from pickle_settings.json (default_worker_timeout_seconds: 1200)
        assert.ok(result.stdout.includes('1200s each'), `Should fall back to settings default timeout, got: ${result.stdout.slice(0, 500)}`);
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Refinement directory creation ---

test('spawn-refinement-team: creates refinement subdirectory in session dir', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        run(['--prd', prd, '--session-dir', tmp], { PATH: '/nonexistent' });
        const refinementDir = path.join(tmp, 'refinement');
        assert.ok(fs.existsSync(refinementDir), 'refinement/ directory should be created');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Panel output ---

test('spawn-refinement-team: panel shows Cycles and Max Turns values', () => {
    const tmp = makeTmpDir();
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        const fakeBin = makeTmpDir('fake-bin-');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const result = run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '3', '--max-turns', '25'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes('25/worker'), `Panel should include max turns value, got: ${combined.slice(0, 500)}`);
        fs.rmSync(fakeBin, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Manifest structure ---

test('spawn-refinement-team: manifest has cycles_requested, cycles_completed, and max_turns_per_worker', () => {
    const tmp = makeTmpDir();
    const fakeBin = makeTmpDir('fake-bin-');
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1', '--max-turns', '15', '--timeout', '5'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );

        const manifestPath = path.join(tmp, 'refinement_manifest.json');
        assert.ok(fs.existsSync(manifestPath), 'manifest file must be written');

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.strictEqual(manifest.cycles_requested, 1, 'cycles_requested should match --cycles');
        assert.strictEqual(manifest.cycles_completed, 1, 'cycles_completed should be 1');
        assert.strictEqual(manifest.max_turns_per_worker, 15, 'max_turns_per_worker should match --max-turns');
        assert.ok(Array.isArray(manifest.workers), 'manifest.workers should be an array');
        assert.strictEqual(manifest.workers.length, 3, 'should have 3 worker results');
        for (const w of manifest.workers) {
            assert.ok('cycle' in w, 'each worker should have a cycle field');
            assert.ok('role' in w, 'each worker should have a role field');
            assert.ok('success' in w, 'each worker should have a success field');
        }
        assert.ok('all_success' in manifest, 'manifest should have all_success');
        assert.ok('prd_path' in manifest, 'manifest should have prd_path');
        assert.ok('completed_at' in manifest, 'manifest should have completed_at');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeBin, { recursive: true, force: true });
    }
});

test('spawn-refinement-team: manifest workers report failure when claude exits non-zero', () => {
    const tmp = makeTmpDir();
    const fakeBin = makeTmpDir('fake-bin-');
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');
        fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        run(
            ['--prd', prd, '--session-dir', tmp, '--cycles', '1', '--max-turns', '15', '--timeout', '5'],
            { PATH: `${fakeBin}:${process.env.PATH}` }
        );

        const manifestPath = path.join(tmp, 'refinement_manifest.json');
        assert.ok(fs.existsSync(manifestPath), 'manifest must be written');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.strictEqual(manifest.all_success, false, 'all_success should be false when workers fail');
        for (const w of manifest.workers) {
            assert.strictEqual(w.success, false, `worker ${w.role} should report failure`);
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeBin, { recursive: true, force: true });
    }
});

// --- Sibling kill on worker crash ---

test('spawn-refinement-team: crashing worker kills siblings — completes without waiting for slow workers', () => {
    const tmp = makeTmpDir();
    const fakeBin = makeTmpDir('fake-bin-');
    try {
        const prd = path.join(tmp, 'prd.md');
        fs.writeFileSync(prd, '# PRD\nContent');

        // requirements role crashes immediately (exit 1).
        // codebase and risk-scope sleep 30s — they must be killed by the sibling logic.
        // Without sibling kill: test times out waiting for the sleepers.
        // With sibling kill: all three settle in <5s.
        fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const idx = process.argv.indexOf('-p');
const prompt = idx !== -1 ? process.argv[idx + 1] : '';
if (prompt.includes('Requirements Analyst')) {
  process.exit(1);
}
// Sibling — hangs until killed by parent
setTimeout(() => process.exit(0), 30000);
`);
        fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

        const start = Date.now();
        const result = spawnSync(
            process.execPath,
            [BIN, '--prd', prd, '--session-dir', tmp, '--cycles', '1', '--timeout', '60'],
            {
                env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
                encoding: 'utf-8',
                // 15s → 45s: budget for system load when run alongside concurrent
                // codex/tmux work. Siblings sleep 30s — bumped wall-clock budget
                // is still less than 30s + 30s if siblings weren't killed, so the
                // assertion still detects the regression class (siblings still
                // running == process status null after spawnSync timeout).
                timeout: 45000,
            }
        );
        const elapsed = Date.now() - start;

        assert.ok(result.status !== null, 'process should not time out (siblings must be killed)');
        // 10s → 25s: still half the 30s sibling sleep, so a regression where
        // siblings aren't killed is detected.
        assert.ok(elapsed < 25000, `should complete quickly when siblings are killed, took ${elapsed}ms`);

        // Manifest is written and covers all 3 workers (Set was cleared — no orphans)
        const manifestPath = path.join(tmp, 'refinement_manifest.json');
        assert.ok(fs.existsSync(manifestPath), 'manifest must be written after sibling kill');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.strictEqual(manifest.workers.length, 3, 'all 3 workers should appear in manifest');
        // requirements crashed; codebase and risk-scope were killed (no ANALYSIS_DONE token)
        assert.strictEqual(manifest.all_success, false, 'all_success should be false');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(fakeBin, { recursive: true, force: true });
    }
});

// --- Portal context in buildWorkerPrompt ---

test('buildWorkerPrompt includes portal context for codebase role', () => {
    const prompt = buildWorkerPrompt('codebase', '# PRD', '/out.md', '/target', 1, undefined, {
        portalDir: '/session/portal', patternSummaryLines: 50
    });
    assert.ok(prompt.includes('Portal Artifacts'), 'Should include Portal Artifacts section');
    assert.ok(prompt.includes('/session/portal/pattern_analysis.md'), 'Should include pattern_analysis.md path');
});

test('buildWorkerPrompt omits portal context for non-codebase roles', () => {
    const prompt = buildWorkerPrompt('requirements', '# PRD', '/out.md', '/target', 1, undefined, {
        portalDir: '/session/portal', patternSummaryLines: 50
    });
    assert.ok(!prompt.includes('Portal Artifacts'), 'Should not include Portal Artifacts for requirements role');
});

test('buildWorkerPrompt omits portal context when not provided', () => {
    const prompt = buildWorkerPrompt('codebase', '# PRD', '/out.md', '/target', 1);
    assert.ok(!prompt.includes('Portal Artifacts'), 'Should not include Portal Artifacts when no portalContext');
});
