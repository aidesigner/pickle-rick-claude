// @tier: fast
//
// pr-refine-on-droid (VAL-IMPL-004..007): the pickle-refine-prd cycle must run
// on the `droid` backend with NO Claude. These CHEAP fixture tests lock the
// refine-on-droid plumbing (no `droid exec`, no credits):
//   - buildRefinementWorkerInvocation({backend:'droid'}) -> droid exec --auto
//     medium -m glm-5.2, prompt via stdin, no claude `-p`, no claude-only
//     --max-turns splicing.
//   - buildRefinementEnv({backend:'droid'}) -> PICKLE_BACKEND=droid, NO
//     PICKLE_REFINEMENT_LOCK (so grandchildren resolve to droid, not claude).
//   - resolveBackend family: PICKLE_REFINEMENT_LOCK=1 still forces claude for
//     codex/deepseek (regression) but lets `droid` through (relaxed carve-out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
    buildRefinementWorkerInvocation,
    buildRefinementEnv,
} = await import('../bin/spawn-refinement-team.js');
const {
    resolveBackend,
    resolveWorkerBackendFromState,
    resolveBackendFromStateFileWithSource,
    __resetBackendWarnings,
} = await import('../services/backend-spawn.js');

function mkTmp(prefix = 'spawn-refine-droid-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeState(dir, state) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    return path.join(dir, 'state.json');
}

// ---------------------------------------------------------------------------
// buildRefinementWorkerInvocation: droid backend
// ---------------------------------------------------------------------------

test('buildRefinementWorkerInvocation: backend=droid yields droid exec --auto medium -m glm-5.2', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 50,
        backend: 'droid',
    });
    assert.equal(inv.cmd, 'droid', `expected cmd=droid, got ${inv.cmd}`);
    assert.equal(inv.backend, 'droid');
    assert.equal(inv.args[0], 'exec', 'droid invocation must start with the exec subcommand');
    const ofIdx = inv.args.indexOf('--output-format');
    assert.ok(ofIdx !== -1, '--output-format must be present');
    assert.notEqual(inv.args[ofIdx + 1], 'text', 'output format must be parseable (stream-json/json), not text');
    const autoIdx = inv.args.indexOf('--auto');
    assert.ok(autoIdx !== -1, '--auto must be present');
    assert.equal(inv.args[autoIdx + 1], 'medium', 'refine worker MUST run --auto medium (commit-capable)');
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx !== -1, '-m model flag must be present');
    assert.equal(inv.args[mIdx + 1], 'glm-5.2', 'default droid model must be glm-5.2');
});

test('buildRefinementWorkerInvocation: backend=droid delivers prompt via stdin (no -p positional)', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'REFINE PROMPT BODY',
        addDirs: [],
        maxTurns: 0,
        backend: 'droid',
    });
    assert.equal(inv.stdinPrompt, 'REFINE PROMPT BODY', 'stdinPrompt must carry the full prompt');
    assert.equal(inv.args.indexOf('-p'), -1, 'droid must NOT use claude -p positional prompt');
    assert.equal(inv.args.indexOf('--max-turns'), -1, 'droid has no --max-turns flag; must not be spliced');
    // No claude-only flags leak into the droid invocation.
    assert.equal(inv.args.indexOf('--dangerously-skip-permissions'), -1);
});

test('buildRefinementWorkerInvocation: backend=droid honors per-session model override (glm-5.1)', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze',
        addDirs: [],
        maxTurns: 1,
        backend: 'droid',
        model: 'glm-5.1',
    });
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx !== -1);
    assert.equal(inv.args[mIdx + 1], 'glm-5.1', 'per-session droid_model override must win over the default');
});

test('buildRefinementWorkerInvocation: backend=droid never produces a claude CLI shape', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze',
        addDirs: [],
        maxTurns: 10,
        backend: 'droid',
    });
    assert.notStrictEqual(inv.cmd, 'claude');
    assert.equal(inv.args.indexOf('--dangerously-skip-permissions'), -1);
    assert.equal(inv.args.indexOf('--add-dir'), -1, 'droid has no --add-dir; out-of-tree dirs reached via cwd');
});

// ---------------------------------------------------------------------------
// buildRefinementEnv: droid backend (no refinement lock, no claude forcing)
// ---------------------------------------------------------------------------

test('buildRefinementEnv: backend=droid sets PICKLE_BACKEND=droid and OMITS PICKLE_REFINEMENT_LOCK', () => {
    const env = buildRefinementEnv({
        PICKLE_BACKEND: 'codex',
        CLAUDECODE: '1',
        PATH: '/usr/bin',
    }, 'droid');
    assert.equal(env.PICKLE_BACKEND, 'droid', 'grandchild env must stay on droid');
    assert.equal(env.PICKLE_REFINEMENT_LOCK, undefined,
        'PICKLE_REFINEMENT_LOCK must NOT be set for droid (else grandchildren short-circuit to claude)');
    assert.equal(env.PICKLE_ROLE, 'refinement-worker');
    assert.equal(env.PYTHONUNBUFFERED, '1');
    assert.equal(env.CLAUDECODE, undefined, 'CLAUDECODE must be stripped to prevent loops');
    assert.equal(env.PATH, '/usr/bin');
});

test('buildRefinementEnv: no backend arg keeps claude + lock (regression)', () => {
    const env = buildRefinementEnv({ PICKLE_BACKEND: 'codex', PATH: '/usr/bin' });
    assert.equal(env.PICKLE_BACKEND, 'claude');
    assert.equal(env.PICKLE_REFINEMENT_LOCK, '1',
        'non-droid refinement must still set the lock so codex cannot leak into planning');
});

// ---------------------------------------------------------------------------
// resolveBackend family: PICKLE_REFINEMENT_LOCK relaxation for droid
// ---------------------------------------------------------------------------

test('resolveBackend: PICKLE_REFINEMENT_LOCK=1 + state.backend=droid -> droid (relaxed)', () => {
    const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
    const prevEnv = process.env.PICKLE_BACKEND;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    delete process.env.PICKLE_BACKEND;
    try {
        assert.equal(resolveBackend({ backend: 'droid' }), 'droid',
            'lock must let droid through so refine proceeds on droid, not claude');
    } finally {
        if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prevEnv;
    }
});

test('resolveBackend: PICKLE_REFINEMENT_LOCK=1 + state.backend=codex -> claude (regression)', () => {
    const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
    const prevEnv = process.env.PICKLE_BACKEND;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    delete process.env.PICKLE_BACKEND;
    try {
        assert.equal(resolveBackend({ backend: 'codex' }), 'claude',
            'lock must STILL force claude for codex (codex reserved for implementation)');
        assert.equal(resolveBackend({ backend: 'deepseek' }), 'claude');
        assert.equal(resolveBackend({ backend: undefined }), 'claude');
    } finally {
        if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prevEnv;
    }
});

test('resolveWorkerBackendFromState: lock=1 + droid -> backend droid; codex -> claude', () => {
    const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
    const prevEnv = process.env.PICKLE_BACKEND;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    delete process.env.PICKLE_BACKEND;
    try {
        const droidRes = resolveWorkerBackendFromState({ backend: 'droid' });
        assert.equal(droidRes.backend, 'droid', 'lock must let droid through on the worker resolution path');
        const codexRes = resolveWorkerBackendFromState({ backend: 'codex' });
        assert.equal(codexRes.backend, 'claude', 'lock must still force claude for codex on the worker path');
    } finally {
        if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prevEnv;
    }
});

test('resolveBackendFromStateFileWithSource: lock=1 + state droid -> droid; codex -> claude', () => {
    const dir = mkTmp();
    const statePath = writeState(dir, { backend: 'droid', active: true });
    const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
    const prevEnv = process.env.PICKLE_BACKEND;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    delete process.env.PICKLE_BACKEND;
    try {
        const droidRes = resolveBackendFromStateFileWithSource(statePath);
        assert.equal(droidRes.backend, 'droid', 'lock must let droid through when reading state.json');
        assert.equal(droidRes.source, 'refinement-lock');

        writeState(dir, { backend: 'codex', active: true });
        const codexRes = resolveBackendFromStateFileWithSource(statePath);
        assert.equal(codexRes.backend, 'claude', 'lock must still force claude for codex when reading state.json');
    } finally {
        if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('resolveBackendFromStateFileWithSource: lock=1 + cli override droid -> droid (no disk read needed)', () => {
    const dir = mkTmp();
    const statePath = writeState(dir, { backend: 'codex', active: true });
    const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    try {
        const res = resolveBackendFromStateFileWithSource(statePath, 'droid');
        assert.equal(res.backend, 'droid', 'explicit --backend droid CLI override must win through the lock');
    } finally {
        if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Reset warning state between test interactions so warnIfCodexRequested
// one-shot doesn't leak across cases (defensive; no direct assertions here).
test('warn state reset is callable', () => {
    __resetBackendWarnings();
    assert.ok(true);
});
