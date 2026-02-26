import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function cleanup(sessionPath) {
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch { /* ignore */ }
}

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
        // tmux mode starts inactive — tmux-runner takes ownership and sets active=true
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
