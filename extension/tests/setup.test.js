import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, initializeNewSession } from '../bin/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function runSetup(args) {
    const output = execFileSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
    });
    const match = output.match(/SESSION_ROOT=(.+)/);
    if (!match) throw new Error(`SESSION_ROOT not found in output:\n${output}`);
    return match[1].trim();
}

function runSetupWithEnv(args, extraEnv) {
    return execFileSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
    });
}

function cleanup(sessionPath) {
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch { /* ignore */ }
}

function withTimezone(tz, fn) {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try {
        return fn();
    } finally {
        if (saved === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = saved;
        }
    }
}

test('setup parseArguments: --resume sets resumeMode and resumePath', () => {
    const args = parseArguments(['--resume', '/tmp/pickle-session']);

    assert.equal(args.resumeMode, true);
    assert.equal(args.resumePath, '/tmp/pickle-session');
});

test('setup parseArguments: --reset can combine with --resume', () => {
    const args = parseArguments(['--resume', '/tmp/pickle-session', '--reset']);

    assert.equal(args.resumeMode, true);
    assert.equal(args.resetMode, true);
});

test('setup parseArguments: --paused sets pausedMode', () => {
    const args = parseArguments(['--paused', '--task', 'paused parse test']);

    assert.equal(args.pausedMode, true);
    assert.equal(args.task, 'paused parse test');
});

test('setup initializeNewSession: state field set matches schema fixture', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-schema-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;

    try {
        const args = parseArguments([
            '--command-template',
            'pickle.md',
            '--backend',
            'claude',
            '--teams',
            '--max-parallel',
            '5',
            '--task',
            'schema fixture parity',
        ]);
        const session = initializeNewSession(args);
        const persisted = JSON.parse(JSON.stringify(session.state));
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/setup/state-schema.json'), 'utf-8'));

        assert.deepEqual(Object.keys(persisted), schema.fields_in_order);
    } finally {
        if (previousDataRoot === undefined) {
            delete process.env.PICKLE_DATA_ROOT;
        } else {
            process.env.PICKLE_DATA_ROOT = previousDataRoot;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup initializeNewSession: session id uses local day, not UTC day', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-local-day-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;

    try {
        const args = parseArguments(['--task', 'local day setup regression']);
        let session;
        withTimezone('America/Chicago', () => {
            mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-29T01:30:00.000Z') });
            try {
                session = initializeNewSession(args);
            } finally {
                mock.timers.reset();
            }
        });

        const sessionId = path.basename(session.sessionRoot);
        assert.match(sessionId, /^2026-04-28-[0-9a-f]{8}$/);
        assert.doesNotMatch(sessionId, /^2026-04-29-/);
        assert.equal(session.state.session_dir, session.sessionRoot);
    } finally {
        if (previousDataRoot === undefined) {
            delete process.env.PICKLE_DATA_ROOT;
        } else {
            process.env.PICKLE_DATA_ROOT = previousDataRoot;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: --tmux sets tmux_mode: true in state.json', () => {
    const sessionPath = runSetup(['--tmux', '--task', 'tmux-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.tmux_mode, true);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: without --tmux, tmux_mode is false in state.json', () => {
    const sessionPath = runSetup(['--task', 'no-tmux-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.tmux_mode, false);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --tmux does not affect other state fields', () => {
    const sessionPath = runSetup(['--tmux', '--task', 'field-check']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.tmux_mode, true);
        assert.equal(state.step, 'prd');
        assert.equal(state.iteration, 0);
        // tmux mode starts inactive — mux-runner takes ownership and sets active=true
        assert.equal(state.active, false);
        assert.equal(state.original_prompt, 'field-check');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume preserves stored limits when no explicit flags given', () => {
    // Create a session with custom limits
    const sessionPath = runSetup(['--max-iterations', '20', '--max-time', '120', '--worker-timeout', '3000', '--task', 'resume-limits-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.max_iterations, 20);
        assert.equal(state.max_time_minutes, 120);
        assert.equal(state.worker_timeout_seconds, 3000);

        // Resume WITHOUT specifying limits — should preserve stored values
        const resumedPath = runSetup(['--resume', sessionPath]);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.max_iterations, 20, 'max_iterations should be preserved on resume');
        assert.equal(state.max_time_minutes, 120, 'max_time_minutes should be preserved on resume');
        assert.equal(state.worker_timeout_seconds, 3000, 'worker_timeout_seconds should be preserved on resume');
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// --min-iterations and --command-template flags (meeseeks support)
// ---------------------------------------------------------------------------

test('setup: --min-iterations 10 sets min_iterations in state.json', () => {
    const sessionPath = runSetup(['--tmux', '--min-iterations', '10', '--task', 'meeseeks-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.min_iterations, 10);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --command-template meeseeks.md sets field; ../evil.md is rejected', () => {
    const sessionPath = runSetup(['--tmux', '--command-template', 'meeseeks.md', '--task', 'template-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.command_template, 'meeseeks.md');
    } finally {
        cleanup(sessionPath);
    }
    // Path traversal must be rejected
    assert.throws(
        () => runSetup(['--tmux', '--command-template', '../evil.md', '--task', 'evil-test']),
        /plain filename/i
    );
});

test('setup: without meeseeks flags, min_iterations is 0 and command_template is undefined', () => {
    const sessionPath = runSetup(['--task', 'default-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.min_iterations, 0);
        assert.equal(state.command_template, undefined);
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// Resume tests
// ---------------------------------------------------------------------------

test('setup: --resume with --tmux propagates tmux_mode to state.json', () => {
    // Create a non-tmux session (simulates /pickle-refine-prd Step 2: --paused)
    const sessionPath = runSetup(['--paused', '--task', 'refine-then-tmux']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.tmux_mode, false, 'initial session should be non-tmux');
        assert.equal(state.active, false, 'paused session should be inactive');

        // Resume with --tmux (simulates /pickle-refine-prd Step 10b)
        runSetup(['--resume', sessionPath, '--tmux', '--max-iterations', '0', '--max-time', '0']);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.tmux_mode, true, 'resume with --tmux must set tmux_mode: true');
        assert.equal(state.active, true, 'resume without --paused must set active: true');
        assert.equal(state.max_iterations, 0, 'explicit --max-iterations 0 must be set');
        assert.equal(state.max_time_minutes, 0, 'explicit --max-time 0 must be set');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume rejects codex teams conflict from recovered tmp state', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-conflict-data-'));
    const sessionPath = path.join(dataRoot, 'sessions', 'resume-conflict');
    fs.mkdirSync(sessionPath, { recursive: true });
    const statePath = path.join(sessionPath, 'state.json');
    const workingDir = process.cwd();

    fs.writeFileSync(statePath, JSON.stringify({
        schema_version: 1,
        active: false,
        backend: 'claude',
        teams_mode: false,
        session_dir: sessionPath,
        working_dir: workingDir,
        iteration: 1,
        step: 'implement',
        original_prompt: 'resume conflict test',
    }, null, 2));
    fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
        schema_version: 1,
        active: false,
        backend: 'codex',
        teams_mode: true,
        session_dir: sessionPath,
        working_dir: workingDir,
        iteration: 2,
        step: 'implement',
        original_prompt: 'resume conflict test',
    }, null, 2));

    try {
        assert.throws(
            () => runSetupWithEnv(['--resume', sessionPath], { PICKLE_DATA_ROOT: dataRoot }),
            /--teams is incompatible with --backend codex/i,
        );
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: --resume keeps the resolved session path authoritative over stale state.session_dir', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-session-dir-data-'));
    const sessionsRoot = path.join(dataRoot, 'sessions');
    const liveSessionDir = path.join(sessionsRoot, 'live-session');
    const staleSessionDir = path.join(sessionsRoot, 'stale-session');
    const workingDir = process.cwd();

    fs.mkdirSync(liveSessionDir, { recursive: true });
    fs.mkdirSync(staleSessionDir, { recursive: true });

    fs.writeFileSync(path.join(liveSessionDir, 'state.json'), JSON.stringify({
        schema_version: 1,
        active: false,
        backend: 'claude',
        session_dir: staleSessionDir,
        working_dir: workingDir,
        iteration: 2,
        step: 'implement',
        original_prompt: 'resume stale session_dir test',
    }, null, 2));
    fs.writeFileSync(path.join(staleSessionDir, 'state.json'), JSON.stringify({
        schema_version: 1,
        active: true,
        backend: 'claude',
        session_dir: staleSessionDir,
        working_dir: workingDir,
        iteration: 9,
        step: 'review',
        original_prompt: 'wrong organ',
    }, null, 2));

    try {
        const output = runSetupWithEnv(['--resume', liveSessionDir], { PICKLE_DATA_ROOT: dataRoot });
        assert.match(output, new RegExp(`SESSION_ROOT=${liveSessionDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));

        const resumedState = JSON.parse(fs.readFileSync(path.join(liveSessionDir, 'state.json'), 'utf-8'));
        assert.equal(resumedState.session_dir, liveSessionDir, 'resume should repair state.session_dir to the resolved live session path');

        const sessionsMap = JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
        assert.equal(sessionsMap[workingDir].sessionPath, liveSessionDir, 'resume should update current_sessions.json with the resolved live session path');
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: --resume rejects a session whose recovered working_dir belongs to another repo', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-cross-repo-data-'));
    const sessionsRoot = path.join(dataRoot, 'sessions');
    const foreignRepo = path.join(dataRoot, 'foreign-repo');
    const sessionPath = path.join(sessionsRoot, 'foreign-session');

    fs.mkdirSync(foreignRepo, { recursive: true });
    fs.mkdirSync(sessionPath, { recursive: true });
    fs.writeFileSync(path.join(sessionPath, 'state.json'), JSON.stringify({
        schema_version: 1,
        active: false,
        backend: 'claude',
        session_dir: sessionPath,
        working_dir: foreignRepo,
        iteration: 4,
        step: 'implement',
        original_prompt: 'cross-repo resume should fail',
    }, null, 2));

    try {
        assert.throws(
            () => runSetupWithEnv(['--resume', sessionPath], { PICKLE_DATA_ROOT: dataRoot }),
            /Refusing cross-repo resume/i,
        );

        const resumedState = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(resumedState.active, false, 'cross-repo resume must not reactivate the foreign session');

        const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
        assert.equal(
            fs.existsSync(sessionsMapPath),
            false,
            'cross-repo resume must not write a current_sessions.json entry for the wrong cwd',
        );
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: --resume preserves max_time_minutes=0 (unlimited) without falling back to default', () => {
    // Create a session with max_time=0 (unlimited)
    const sessionPath = runSetup(['--max-time', '0', '--task', 'unlimited-time-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.max_time_minutes, 0, 'initial max_time_minutes should be 0');

        // Resume WITHOUT explicit --max-time — should preserve 0, not fall back to default
        const output = execFileSync(process.execPath, [SETUP, '--resume', sessionPath], {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0' },
        });
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.max_time_minutes, 0, 'max_time_minutes=0 must be preserved on resume');
        // Display should show ∞ for unlimited, not a numeric default
        assert.ok(output.includes('∞'), 'output should show ∞ for unlimited max_time_minutes');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: new session with max_time=0 shows ∞ in panel output', () => {
    const output = execFileSync(process.execPath, [SETUP, '--max-time', '0', '--task', 'display-infinity-test'], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
    });
    const match = output.match(/SESSION_ROOT=(.+)/);
    assert.ok(match, 'SESSION_ROOT should be in output');
    const sessionPath = match[1].trim();
    try {
        // Max Time should display ∞, not "0m"
        assert.ok(!output.includes('Max Time') || !output.includes('0m') || output.includes('∞'),
            'Max Time should show ∞ for 0 (unlimited), not "0m"');
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// --chain-meeseeks flag
// ---------------------------------------------------------------------------

test('setup: --chain-meeseeks sets chain_meeseeks: true in state.json', () => {
    const sessionPath = runSetup(['--tmux', '--chain-meeseeks', '--task', 'chain-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.chain_meeseeks, true);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: without --chain-meeseeks, chain_meeseeks is false in state.json', () => {
    const sessionPath = runSetup(['--task', 'no-chain-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.chain_meeseeks, false);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume with --chain-meeseeks propagates to state.json', () => {
    const sessionPath = runSetup(['--paused', '--task', 'chain-resume-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.chain_meeseeks, false, 'initial session should not have chain_meeseeks');

        runSetup(['--resume', sessionPath, '--tmux', '--chain-meeseeks']);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.chain_meeseeks, true, 'resume with --chain-meeseeks must set chain_meeseeks: true');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume without --chain-meeseeks preserves existing chain_meeseeks in state', () => {
    // Create a session WITH --chain-meeseeks
    const sessionPath = runSetup(['--tmux', '--chain-meeseeks', '--task', 'preserve-chain-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.chain_meeseeks, true, 'initial session should have chain_meeseeks: true');

        // Resume WITHOUT --chain-meeseeks — should preserve existing true
        runSetup(['--resume', sessionPath, '--tmux']);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.chain_meeseeks, true, 'resume without --chain-meeseeks must preserve existing chain_meeseeks: true');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume syncs chain_meeseeks from state for display', () => {
    // Create a session WITH --chain-meeseeks
    const sessionPath = runSetup(['--tmux', '--chain-meeseeks', '--task', 'display-sync-test']);
    try {
        // Resume WITHOUT --chain-meeseeks — output should still show "Chain Meeseeks"
        const output = execFileSync(process.execPath, [SETUP, '--resume', sessionPath, '--tmux'], {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0' },
        });
        assert.ok(output.includes('Chain Meeseeks'), 'resume should show Chain Meeseeks from stored state');
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// Activity logging: session_start suppression on resume, original_prompt on new
// ---------------------------------------------------------------------------

function getActivityEvents(sessionId) {
    const activityDir = path.join(os.homedir(), '.local/share/pickle-rick/activity');
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const filepath = path.join(activityDir, `${date}.jsonl`);
    if (!fs.existsSync(filepath)) return [];
    return fs.readFileSync(filepath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(e => e && e.event === 'session_start' && e.session === sessionId);
}

function sessionIdFromPath(sessionPath) {
    return path.basename(sessionPath);
}

test('setup: new session logs session_start with original_prompt', () => {
    const taskText = 'activity-log-new-session-test';
    const sessionPath = runSetup(['--task', taskText]);
    try {
        const sid = sessionIdFromPath(sessionPath);
        const events = getActivityEvents(sid);
        assert.ok(events.length >= 1, 'session_start should be logged for new sessions');
        assert.equal(events[0].original_prompt, taskText, 'session_start should include original_prompt');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: resumed session does NOT log additional session_start', () => {
    const sessionPath = runSetup(['--task', 'resume-no-session-start-test']);
    try {
        const sid = sessionIdFromPath(sessionPath);
        const beforeCount = getActivityEvents(sid).length;
        assert.ok(beforeCount >= 1, 'new session should have logged session_start');

        // Resume the session
        runSetup(['--resume', sessionPath]);
        const afterCount = getActivityEvents(sid).length;
        assert.equal(afterCount, beforeCount, 'resume should NOT log additional session_start');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: prunes dead-pid stale sessions before creating a new session', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-data-'));
    const staleSessionDir = path.join(dataRoot, 'sessions', 'stale-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(staleSessionDir, 'state.json'),
        JSON.stringify({
            active: true,
            pid: 99999999,
            started_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            working_dir: path.join(dataRoot, 'old-repo'),
            session_dir: staleSessionDir,
        }, null, 2)
    );

    const output = runSetupWithEnv(
        ['--task', 'prune-dead-pid-stale-session'],
        {
            EXTENSION_DIR: path.resolve(__dirname, '..', '..'),
            PICKLE_DATA_ROOT: dataRoot,
        }
    );
    const match = output.match(/SESSION_ROOT=(.+)/);
    assert.ok(match, `SESSION_ROOT not found in output:\n${output}`);
    const sessionPath = match[1].trim();

    try {
        assert.equal(
            fs.existsSync(staleSessionDir),
            false,
            'setup should prune stale sessions whose dead PID is recovered to inactive before age check'
        );
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
        cleanup(sessionPath);
    }
});

test('setup: prunes future-dated stale inactive sessions before creating a new session', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-future-stale-data-'));
    const staleSessionDir = path.join(dataRoot, 'sessions', 'future-stale-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    const statePath = path.join(staleSessionDir, 'state.json');
    fs.writeFileSync(
        statePath,
        JSON.stringify({
            active: false,
            started_at: '2099-12-31T23:59:59.000Z',
            working_dir: path.join(dataRoot, 'old-repo'),
            session_dir: staleSessionDir,
        }, null, 2)
    );
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleSessionDir, oldTime, oldTime);
    fs.utimesSync(statePath, oldTime, oldTime);

    const output = runSetupWithEnv(
        ['--task', 'prune-future-dated-stale-session'],
        {
            EXTENSION_DIR: path.resolve(__dirname, '..', '..'),
            PICKLE_DATA_ROOT: dataRoot,
        }
    );
    const match = output.match(/SESSION_ROOT=(.+)/);
    assert.ok(match, `SESSION_ROOT not found in output:\n${output}`);
    const sessionPath = match[1].trim();

    try {
        assert.equal(
            fs.existsSync(staleSessionDir),
            false,
            'setup should prune stale inactive sessions whose future-dated started_at exceeds the trusted skew window'
        );
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
        cleanup(sessionPath);
    }
});

test('setup: session_start original_prompt matches exact task text', () => {
    const taskText = 'exact-prompt-match-test with spaces and $pecial chars';
    const sessionPath = runSetup(['--task', taskText]);
    try {
        const sid = sessionIdFromPath(sessionPath);
        const events = getActivityEvents(sid);
        assert.equal(events.length, 1, 'exactly one session_start should be logged');
        assert.equal(events[0].original_prompt, taskText, 'original_prompt should match task text exactly');
        assert.equal(events[0].source, 'pickle', 'source should be pickle');
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// --effort flag (reasoning effort for codex backend; claude no-op)
// ---------------------------------------------------------------------------

test('setup: --effort high persists into state.effort', () => {
    const sessionPath = runSetup(['--effort', 'high', '--task', 'effort-high-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.effort, 'high');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --effort low and --effort medium persist correctly', () => {
    for (const level of ['low', 'medium']) {
        const sessionPath = runSetup(['--effort', level, '--task', `effort-${level}-test`]);
        try {
            const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
            assert.equal(state.effort, level);
        } finally {
            cleanup(sessionPath);
        }
    }
});

test('setup: without --effort, state.effort is undefined (preserves CLI default)', () => {
    const sessionPath = runSetup(['--task', 'effort-default-test']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.effort, undefined);
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --effort bogus errors out with a clear message', () => {
    assert.throws(
        () => runSetup(['--effort', 'bogus', '--task', 'effort-bogus-test']),
        /--effort must be one of: low, medium, high/i,
    );
});

test('setup: --effort without value errors out', () => {
    assert.throws(
        () => runSetup(['--task', 'effort-missing-test', '--effort']),
        /--effort requires a value/i,
    );
});

test('setup: --resume with --effort high overrides stored effort', () => {
    const sessionPath = runSetup(['--effort', 'low', '--task', 'effort-resume-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.effort, 'low');

        runSetup(['--resume', sessionPath, '--effort', 'high']);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.effort, 'high', 'explicit --effort on resume must override stored value');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume without --effort preserves stored effort', () => {
    const sessionPath = runSetup(['--effort', 'medium', '--task', 'effort-preserve-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        runSetup(['--resume', sessionPath]);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.effort, 'medium', 'resume without --effort must preserve stored effort');
    } finally {
        cleanup(sessionPath);
    }
});

test('setup: --resume with explicit flag overrides stored limit', () => {
    // Create a session with default limits
    const sessionPath = runSetup(['--task', 'resume-override-test']);
    try {
        const statePath = path.join(sessionPath, 'state.json');

        // Resume WITH explicit --max-iterations — should override
        runSetup(['--resume', sessionPath, '--max-iterations', '99']);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.max_iterations, 99, 'explicit --max-iterations should override on resume');
    } finally {
        cleanup(sessionPath);
    }
});

// ---------------------------------------------------------------------------
// iteration_budget_per_backend — codex iteration semantics are coarser than
// claude, so the per-backend split keeps wall-clock budgets comparable.
// ---------------------------------------------------------------------------

function makeExtensionRootWithSettings(settings) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-budget-ext-'));
    fs.writeFileSync(path.join(extRoot, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
    return extRoot;
}

test('setup: iteration_budget_per_backend.codex honored when --backend codex', () => {
    const extRoot = makeExtensionRootWithSettings({
        default_max_iterations: 100,
        iteration_budget_per_backend: { claude: 100, codex: 80 },
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-budget-data-'));
    const output = runSetupWithEnv(
        ['--backend', 'codex', '--task', 'codex-budget-test'],
        { EXTENSION_DIR: extRoot, PICKLE_DATA_ROOT: dataRoot }
    );
    const sessionPath = output.match(/SESSION_ROOT=(.+)/)[1].trim();
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.max_iterations, 80, 'codex backend must pick up codex per-backend budget');
        assert.equal(state.backend, 'codex');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: iteration_budget_per_backend.claude honored when --backend claude', () => {
    const extRoot = makeExtensionRootWithSettings({
        default_max_iterations: 500,
        iteration_budget_per_backend: { claude: 100, codex: 80 },
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-budget-data-'));
    const output = runSetupWithEnv(
        ['--backend', 'claude', '--task', 'claude-budget-test'],
        { EXTENSION_DIR: extRoot, PICKLE_DATA_ROOT: dataRoot }
    );
    const sessionPath = output.match(/SESSION_ROOT=(.+)/)[1].trim();
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.max_iterations, 100, 'claude backend must pick up claude per-backend budget, not default_max_iterations');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: falls back to default_max_iterations when iteration_budget_per_backend is absent', () => {
    const extRoot = makeExtensionRootWithSettings({
        default_max_iterations: 250,
        // no iteration_budget_per_backend field at all
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-budget-data-'));
    const output = runSetupWithEnv(
        ['--backend', 'codex', '--task', 'budget-fallback-test'],
        { EXTENSION_DIR: extRoot, PICKLE_DATA_ROOT: dataRoot }
    );
    const sessionPath = output.match(/SESSION_ROOT=(.+)/)[1].trim();
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.max_iterations, 250, 'absent per-backend map must fall through to default_max_iterations');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('setup: falls back to default_max_iterations when backend missing from per-backend map', () => {
    const extRoot = makeExtensionRootWithSettings({
        default_max_iterations: 250,
        iteration_budget_per_backend: { claude: 100 }, // no codex entry
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-budget-data-'));
    const output = runSetupWithEnv(
        ['--backend', 'codex', '--task', 'budget-missing-key-test'],
        { EXTENSION_DIR: extRoot, PICKLE_DATA_ROOT: dataRoot }
    );
    const sessionPath = output.match(/SESSION_ROOT=(.+)/)[1].trim();
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.max_iterations, 250, 'codex backend with no codex key must fall through to default_max_iterations');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
