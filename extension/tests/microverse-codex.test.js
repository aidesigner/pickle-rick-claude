// @tier: fast
/**
 * microverse-codex.test.js
 *
 * Codex backend coverage for microverse's LLM judge and gap-analysis baseline.
 *
 * Guards against the "judge uses codex path when state.backend=codex" regression
 * (R-SCJM-2): the judge MUST always spawn via the claude binary, even when the
 * session backend is codex. codex on ChatGPT accounts rejects claude-sonnet-4-6
 * causing silent false-convergence (BestScore: 0).
 *
 * Also guards against the "gap-analysis baseline reads stale state" bug: if
 * the user flips state.backend between session start and gap-analysis, the
 * baseline call must re-read state from disk before resolving backend so
 * compareMetric() doesn't compare apples to oranges against iteration scores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { measureLlmMetric, measureLlmMetricWithBackoff, _deps } from '../bin/microverse-runner.js';
import { resolveBackend } from '../services/backend-spawn.js';

function withTempExtensionSettings(settings, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ext-settings-'));
    const prev = {
        EXTENSION_DIR: process.env.EXTENSION_DIR,
        EXTENSION_DIR_TEST: process.env.EXTENSION_DIR_TEST,
        NODE_ENV: process.env.NODE_ENV,
    };
    fs.writeFileSync(path.join(dir, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
    process.env.EXTENSION_DIR = dir;
    process.env.EXTENSION_DIR_TEST = '1';
    process.env.NODE_ENV = 'test';
    const cleanup = () => {
        if (prev.EXTENSION_DIR === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = prev.EXTENSION_DIR;
        if (prev.EXTENSION_DIR_TEST === undefined) delete process.env.EXTENSION_DIR_TEST;
        else process.env.EXTENSION_DIR_TEST = prev.EXTENSION_DIR_TEST;
        if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prev.NODE_ENV;
        fs.rmSync(dir, { recursive: true, force: true });
    };
    try {
        const result = fn(dir);
        if (result && typeof result.then === 'function') {
            return result.finally(cleanup);
        }
        cleanup();
        return result;
    } catch (err) {
        cleanup();
        throw err;
    }
}

// --- Bug 1 coverage: measureLlmMetric read-only sandboxing ---

test('measureLlmMetric codex backend: judge always spawns via claude binary (R-SCJM-2)', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '42';
    };
    try {
        const result = await measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        // Judge MUST use claude even when session backend is codex (R-SCJM-2).
        // codex on ChatGPT accounts rejects claude-sonnet-4-6, causing silent
        // false-convergence. The fix: judge always spawns via claude binary.
        assert.equal(captured.cmd, 'claude', 'judge must spawn claude binary even when session backend=codex');
        assert.ok(captured.args.includes('--allowedTools'), 'claude judge must set tool allowlist');
        assert.ok(captured.args.includes('Read,Glob,Grep'), 'claude judge is restricted to read-only tools');
        assert.ok(captured.args.includes('--no-session-persistence'), 'judge sessions are ephemeral');
        assert.ok(
            !captured.args.includes('--dangerously-bypass-approvals-and-sandbox'),
            'judge MUST NOT have write/shell access',
        );
        assert.deepEqual(result, { raw: '42', score: 42 });
    } finally {
        delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric codex backend: judge uses --system-prompt flag (claude path)', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '7';
    };
    try {
        await measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        // Judge uses claude path, which threads --system-prompt and -p flags
        // (not codex inline-prefix style).
        assert.equal(captured.cmd, 'claude', 'judge must use claude binary');
        const sysIdx = captured.args.indexOf('--system-prompt');
        assert.ok(sysIdx >= 0, 'claude judge threads --system-prompt');
        assert.ok(
            captured.args[sysIdx + 1].includes('precise scoring judge'),
            'system prompt value should be the judge system prompt',
        );
        const pIdx = captured.args.lastIndexOf('-p');
        assert.ok(pIdx >= 0, 'claude judge passes prompt via -p');
        assert.ok(captured.args[pIdx + 1].includes('fix bugs'), 'user prompt passed via -p');
    } finally {
        delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric codex backend: judge always includes claude-sonnet-4-6 model (R-SCJM-2)', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '7';
    };
    try {
        await measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        // Judge always uses claude binary with DEFAULT_JUDGE_MODEL, even when
        // session backend=codex. The old codex path omitted -m; now judge
        // always passes --model claude-sonnet-4-6 through the claude path.
        assert.equal(captured.cmd, 'claude', 'judge must use claude binary');
        const modelIdx = captured.args.indexOf('--model');
        assert.ok(modelIdx >= 0, 'claude judge must pass --model flag');
        assert.equal(
            captured.args[modelIdx + 1],
            'claude-sonnet-4-6',
            'judge always uses DEFAULT_JUDGE_MODEL regardless of session backend',
        );
    } finally {
        delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetricWithBackoff keeps judge spawn on claude when microverse.judge_backend=codex', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const orig = _deps.execFileSync;
    const captured = [];
    _deps.execFileSync = (cmd, args) => {
        captured.push({ cmd, args });
        return Array.isArray(args) && args[0] === '--version' ? 'claude/2.1.0' : '11';
    };
    try {
        const result = await withTempExtensionSettings(
            { microverse: { judge_backend: 'codex' } },
            () => measureLlmMetricWithBackoff(
                'fix bugs',
                30,
                '/tmp',
                undefined,
                undefined,
                undefined,
                undefined,
                'codex',
            ),
        );
        assert.deepEqual(result.metric, { raw: '11', score: 11 });
        const measurementCalls = captured.filter(({ args }) => !args.includes('--version'));
        assert.equal(measurementCalls.length, 1, 'expected exactly one judge measurement spawn');
        assert.equal(measurementCalls[0].cmd, 'claude', 'judge spawn must stay on claude even when settings pin codex');
        assert.ok(measurementCalls[0].args.includes('--allowedTools'), 'judge spawn must still use the claude invocation shape');
    } finally {
        delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric claude backend still uses --allowedTools Read,Glob,Grep', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '99';
    };
    try {
        await measureLlmMetric(
            'fix bugs', 30, '/tmp',
            'claude-opus-4-6', undefined, undefined, undefined,
            'claude',
        );
        assert.equal(captured.cmd, 'claude');
        assert.ok(captured.args.includes('--allowedTools'), 'claude must set tool allowlist');
        assert.ok(captured.args.includes('Read,Glob,Grep'), 'claude judge restricted to read-only tools');
        assert.ok(captured.args.includes('--no-session-persistence'), 'claude judge sessions are ephemeral');
        assert.ok(captured.args.includes('--system-prompt'), 'claude path threads --system-prompt');
        assert.ok(
            !captured.args.includes('-s'),
            'claude path must not accidentally pass codex sandbox flag',
        );
    } finally {
        delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
        _deps.execFileSync = orig;
    }
});

// --- Bug 2 coverage: gap-analysis baseline re-reads state from disk ---

test('resolveBackend re-read from disk reflects a backend flip made after session start', () => {
    // Simulate main()'s initial state load, then a user-initiated flip of
    // state.backend (e.g. editing state.json or running a side script), then
    // gap-analysis baseline's re-read. Mirrors the fix in microverse-runner.ts
    // where `freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))`
    // replaces the stale in-memory `state` before calling resolveBackend.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-codex-'));
    const statePath = path.join(dir, 'state.json');
    try {
        // Initial state — backend set to claude
        const initialState = {
            active: true, working_dir: dir, step: 'implement',
            iteration: 0, max_iterations: 10, max_time_minutes: 60,
            worker_timeout_seconds: 120,
            start_time_epoch: Math.floor(Date.now() / 1000),
            backend: 'claude',
        };
        fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2));

        // main() loads state at startup
        const staleState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resolveBackend(staleState), 'claude');

        // User flips backend on disk between session start and gap-analysis
        const flipped = { ...initialState, backend: 'codex' };
        fs.writeFileSync(statePath, JSON.stringify(flipped, null, 2));

        // Stale in-memory copy still resolves to claude — this is the BUG path
        assert.equal(resolveBackend(staleState), 'claude',
            'stale in-memory state still resolves to old backend (the bug)');

        // The FIX: re-read state from disk before resolveBackend
        const freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resolveBackend(freshState), 'codex',
            'fresh on-disk state reflects the flip — baseline will use new backend');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
