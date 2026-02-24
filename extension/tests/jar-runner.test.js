import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAR_RUNNER_BIN = path.resolve(__dirname, '../bin/jar-runner.js');

/**
 * Create an isolated temp root directory for EXTENSION_DIR.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks,
 * ensuring paths match across the subprocess boundary.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-runner-')));
}

/**
 * Run jar-runner.js as a subprocess with isolated EXTENSION_DIR.
 * Returns the spawnSync result with stdout, stderr, and status.
 */
function run(extDir) {
    return spawnSync(process.execPath, [JAR_RUNNER_BIN], {
        env: { ...process.env, EXTENSION_DIR: extDir },
        encoding: 'utf-8',
        timeout: 10000,
    });
}

// --- Empty jar (no jar/ directory) ---

test('jar-runner: outputs "Pickle Jar is empty" when no jar/ dir exists', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.ok(
            result.stdout.includes('Pickle Jar is empty'),
            `Expected "Pickle Jar is empty" in stdout, got: ${result.stdout}`
        );
        assert.ok(
            result.stdout.includes('Jar Complete'),
            `Expected "Jar Complete" signal in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- No marinating tasks ---

test('jar-runner: outputs "No marinating tasks" when jar/ has non-marinating tasks', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create jar/2026-01-01/task1/meta.json with status !== 'marinating'
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task1');
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'consumed',
            repo_path: '/some/repo',
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks" in stdout, got: ${result.stdout}`
        );
        assert.ok(
            result.stdout.includes('Jar Complete'),
            `Expected "Jar Complete" signal in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Corrupt meta.json ---

test('jar-runner: outputs "Skipping" warning when meta.json is corrupt', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task1');
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), '{{{not json at all!!!');

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Skipping'),
            `Expected "Skipping" in stderr for corrupt meta.json, got stderr: ${result.stderr}`
        );
        // With no valid marinating tasks, should still output "No marinating tasks"
        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks" in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing repo_path ---

test('jar-runner: skips task and sets status to failed when repo_path is missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-no-repo';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            // no repo_path
        }, null, 2));

        // Create the session dir that jar-runner will look for
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Skipping'),
            `Expected "Skipping" in stderr for missing repo_path, got stderr: ${result.stderr}`
        );
        assert.ok(
            result.stderr.includes('repo_path'),
            `Expected "repo_path" mentioned in skip message, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- PRD integrity check failure ---

test('jar-runner: skips task when PRD integrity check fails (hash mismatch)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-bad-hash';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');

        // Write a PRD file
        const prdContent = '# My PRD\n\nThis is the original PRD content.\n';
        fs.writeFileSync(path.join(taskDir, 'prd.md'), prdContent);

        // Compute a WRONG hash (hash of different content)
        const wrongHash = crypto.createHash('sha256').update('totally different content').digest('hex');

        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,  // use tmpRoot as a valid path
            prd_hash: wrongHash,
        }, null, 2));

        // Create the session dir
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('integrity check failed'),
            `Expected "integrity check failed" in stderr, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing session dir ---

test('jar-runner: skips task and sets status to failed when session dir is missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-no-session';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Intentionally do NOT create sessions/<taskId>/ dir

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Session dir not found'),
            `Expected "Session dir not found" in stderr, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Settings type guard for default_manager_max_turns ---

test('jar-runner: ignores non-number default_manager_max_turns in settings (e.g., string)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-bad-settings';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Write settings with a string value (should be ignored → default 50)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_manager_max_turns: "fifty",
        }));

        // Create session dir with state.json
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        // Should not crash — the string value should be ignored
        const combined = result.stdout + result.stderr;
        assert.ok(
            !combined.includes('TypeError'),
            `Should not have TypeError with string settings, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: ignores zero or negative default_manager_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-zero-turns';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Write settings with zero value (should be ignored → default 50)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_manager_max_turns: 0,
        }));

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;
        // Should show MaxTurns: 50 (the default) since 0 is rejected
        assert.ok(
            combined.includes('50'),
            `Expected default max turns (50) when settings has 0, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- PRD integrity passes with correct hash ---

test('jar-runner: does not skip task when PRD hash matches (integrity passes)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-good-hash';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');

        // Write a PRD and compute the correct hash
        const prdContent = '# Good PRD\n\nThis content has a valid hash.\n';
        fs.writeFileSync(path.join(taskDir, 'prd.md'), prdContent);
        const correctHash = crypto.createHash('sha256').update(prdContent).digest('hex');

        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
            prd_hash: correctHash,
        }, null, 2));

        // Create the session dir (runTask will fail because claude isn't available,
        // but we should NOT see "integrity check failed")
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        // Should NOT contain integrity check failure
        assert.ok(
            !result.stderr.includes('integrity check failed'),
            `Should NOT see "integrity check failed" when hash matches, got stderr: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
