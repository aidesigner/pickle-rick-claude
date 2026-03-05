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
    return spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

function makeTmpDir(prefix = 'pickle-refine-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
