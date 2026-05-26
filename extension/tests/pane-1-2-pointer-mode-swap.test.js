// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POINTER_SRC = path.resolve(__dirname, '../src/bin/pane-1-2-pointer.ts');
const POINTER_BIN = path.resolve(__dirname, '../bin/pane-1-2-pointer.js');

function run(args, { timeout = 8000, input = undefined } = {}) {
    return spawnSync(process.execPath, [POINTER_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout,
        input,
    });
}

function makeSessionDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pane-1-2-pointer-')));
}

function writeState(sessionDir, overrides = {}) {
    const state = { active: false, pid: process.pid, step: 'implement', iteration: 1, ...overrides };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeMicroverse(sessionDir, data) {
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(data, null, 2));
}

// AC: existence checks
test('pane-1-2-pointer: source file exists at canonical path', () => {
    assert.ok(fs.existsSync(POINTER_SRC), `Missing: ${POINTER_SRC}`);
});

test('pane-1-2-pointer: compiled JS exists at bin path', () => {
    assert.ok(fs.existsSync(POINTER_BIN), `Missing compiled JS: ${POINTER_BIN}`);
});

// TC-1: pickle mode → ▸ <ticket_hash>
test('pane-1-2-pointer: pickle mode emits ▸ <ticket_hash>', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false, step: 'pickle', current_ticket: 'abcd1234' });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Timed out: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ abcd1234'), `Expected ▸ abcd1234 in stdout, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// TC-2: anatomy-park mode with microverse.json present → ▸ <subsystem> (iter N)
test('pane-1-2-pointer: anatomy-park mode emits ▸ <subsystem> (iter N)', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false, step: 'anatomy-park' });
        writeMicroverse(sessionDir, { current_subsystem: 'services', iterations: 12 });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Timed out: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ services (iter 12)'), `Expected ▸ services (iter 12) in stdout, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// TC-3: anatomy-park mode, missing microverse.json → ▸ — (em-dash), no throw
test('pane-1-2-pointer: anatomy-park mode missing microverse emits ▸ — and does not throw', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false, step: 'anatomy-park' });
        // No microverse.json written
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Timed out: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ —'), `Expected ▸ — (em-dash) in stdout, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// TC-4: stdin EOF (input:'') → exit 0, no stale-stdin warning
test('pane-1-2-pointer: stdin EOF causes clean exit 0, no stale-stdin warning', () => {
    const sessionDir = makeSessionDir();
    try {
        // active: true so the loop doesn't exit naturally — only stdin-EOF path can exit
        writeState(sessionDir, { active: true, step: 'pickle', current_ticket: 'test1234' });
        const result = run([sessionDir], { input: '' });
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Timed out: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0 from stdin EOF, got ${result.status}: ${result.stderr}`);
        assert.ok(
            !result.stderr.includes('no stdin data received'),
            `stderr should not contain stale-stdin warning, got: ${result.stderr}`,
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
