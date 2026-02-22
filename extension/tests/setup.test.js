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
        assert.equal(state.active, true);
        assert.equal(state.original_prompt, 'field-check');
    } finally {
        cleanup(sessionPath);
    }
});
