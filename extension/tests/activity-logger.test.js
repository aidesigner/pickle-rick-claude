import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

// Helper: create temp dir that acts as extension root, return activity dir path
function withTempActivityDir(fn) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fn(activityDir, extRoot);
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
}

// Re-import logActivity fresh per test to pick up env changes
async function getLogActivity() {
    // Dynamic import with cache-busting query param won't work in Node ESM,
    // but since EXTENSION_DIR is read at call time (not import time), static import is fine.
    const mod = await import('../services/activity-logger.js');
    return mod.logActivity;
}

// --- VALID_ACTIVITY_EVENTS ---

test('VALID_ACTIVITY_EVENTS contains all 21 expected event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'iteration_start', 'iteration_end',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'multi_repo_warning',
    ];
    assert.equal(VALID_ACTIVITY_EVENTS.length, 21);
    for (const e of expected) {
        assert.ok(VALID_ACTIVITY_EVENTS.includes(e), `Missing event type: ${e}`);
    }
});

test('VALID_ACTIVITY_EVENTS has no duplicates', () => {
    const unique = new Set(VALID_ACTIVITY_EVENTS);
    assert.equal(unique.size, VALID_ACTIVITY_EVENTS.length, 'should have no duplicate event types');
});

// --- logActivity ---

test('logActivity: appends valid JSONL to date-named file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'commit', source: 'hook', commit_hash: 'abc1234' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const line = fs.readFileSync(filepath, 'utf8').trim();
        const parsed = JSON.parse(line);
        assert.equal(parsed.event, 'commit');
        assert.equal(parsed.source, 'hook');
        assert.equal(parsed.commit_hash, 'abc1234');
    });
});

test('logActivity: sets ts field automatically', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const before = new Date().toISOString();
        logActivity({ event: 'session_start', source: 'pickle' });
        const after = new Date().toISOString();
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(parsed.ts >= before, 'ts should be >= test start');
        assert.ok(parsed.ts <= after, 'ts should be <= test end');
    });
});

test('logActivity: preserves caller-provided ts', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const customTs = '2026-01-15T10:00:00.000Z';
        logActivity({ event: 'commit', source: 'hook', ts: customTs });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.ts, customTs);
    });
});

test('logActivity: creates activity dir if missing', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        assert.ok(!fs.existsSync(activityDir), 'activity dir should not exist yet');
        logActivity({ event: 'feature', source: 'persona', title: 'test' });
        assert.ok(fs.existsSync(activityDir), 'activity dir should be created');
    });
});

test('logActivity: multiple events append to same file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle' });
        logActivity({ event: 'ticket_completed', source: 'pickle', ticket: 'abc' });
        logActivity({ event: 'session_end', source: 'pickle' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3);
        assert.equal(JSON.parse(lines[0]).event, 'session_start');
        assert.equal(JSON.parse(lines[1]).event, 'ticket_completed');
        assert.equal(JSON.parse(lines[2]).event, 'session_end');
    });
});

test('logActivity: silently catches errors on read-only directory', async () => {
    const logActivity = await getLogActivity();
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir);
    fs.chmodSync(activityDir, 0o444);
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        assert.doesNotThrow(() => {
            logActivity({ event: 'commit', source: 'hook' });
        });
    } finally {
        fs.chmodSync(activityDir, 0o755);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('logActivity: file permissions are 0o600', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'feature', source: 'persona', title: 'test perms' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const stats = fs.statSync(filepath);
        const mode = stats.mode & 0o777;
        assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`);
    });
});

test('logActivity: includes all provided optional fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({
            event: 'ticket_completed',
            source: 'pickle',
            session: 'sess-123',
            ticket: 'abc',
            step: 'implement',
            epic: 'my-epic',
        });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.session, 'sess-123');
        assert.equal(parsed.ticket, 'abc');
        assert.equal(parsed.step, 'implement');
        assert.equal(parsed.epic, 'my-epic');
    });
});

// --- Iteration events and new fields ---

test('logActivity: iteration_start event preserves iteration field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_start', source: 'pickle', iteration: 3, session: 'sess-abc' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_start');
        assert.equal(parsed.iteration, 3);
        assert.equal(parsed.session, 'sess-abc');
    });
});

test('logActivity: iteration_end event preserves iteration and exit_type fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_end', source: 'pickle', iteration: 5, exit_type: 'error' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_end');
        assert.equal(parsed.iteration, 5);
        assert.equal(parsed.exit_type, 'error');
    });
});

test('logActivity: session_start event preserves original_prompt field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle', original_prompt: 'Build the portal gun' });
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'session_start');
        assert.equal(parsed.original_prompt, 'Build the portal gun');
    });
});

// --- CLI: log-activity.js ---

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'log-activity.js');

function runCli(args, env = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, ...env },
    });
}

test('CLI: rejects unknown event type', () => {
    const result = runCli(['invalid_type', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown event type/);
});

test('CLI: rejects missing event type', () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects -- prefixed event type', () => {
    const result = runCli(['--commit', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects missing title', () => {
    const result = runCli(['feature']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects -- prefixed title', () => {
    const result = runCli(['feature', '--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects empty title after sanitization', () => {
    const result = runCli(['feature', '\n\r']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty/);
});

test('CLI: valid call exits 0 and writes event', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['bug_fix', 'Fixed the auth race'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'bug_fix');
        assert.equal(parsed.source, 'persona');
        assert.equal(parsed.title, 'Fixed the auth race');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips newlines from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['feature', 'line1\nline2\rline3'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\n'), 'title should not contain \\n');
        assert.ok(!parsed.title.includes('\r'), 'title should not contain \\r');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips ANSI escape codes from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const ansiTitle = '\x1b[31mred text\x1b[0m and \x1b[1mbold\x1b[0m';
        const result = runCli(['feature', ansiTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x1b'), 'title should not contain ANSI escape codes');
        assert.match(parsed.title, /red text.*bold/, 'text content should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips control characters (bell, backspace, vertical tab) from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        // Use control chars that Node allows in CLI args (no null bytes)
        const controlTitle = 'before\x07bell\x08backspace\x0Bvtab after';
        const result = runCli(['bug_fix', controlTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x07'), 'title should not contain bell char');
        assert.ok(!parsed.title.includes('\x08'), 'title should not contain backspace');
        assert.ok(!parsed.title.includes('\x0B'), 'title should not contain vertical tab');
        assert.ok(parsed.title.includes('before'), 'readable text should be preserved');
        assert.ok(parsed.title.includes('after'), 'readable text should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: truncates title at 200 chars', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const longTitle = 'x'.repeat(300);
        const result = runCli(['research', longTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = new Date().toLocaleDateString('en-CA');
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.title.length, 200);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: accepts all 21 valid event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'iteration_start', 'iteration_end',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'multi_repo_warning',
    ];
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        for (const eventType of expected) {
            const result = runCli([eventType, `test ${eventType}`], { EXTENSION_DIR: extRoot });
            assert.equal(result.status, 0, `Event type "${eventType}" should be accepted, stderr: ${result.stderr}`);
        }
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});
