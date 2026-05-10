// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { respawnMonitorWindowForMode } from '../../lib/monitor-respawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const MUX_RUNNER_BIN = path.join(EXTENSION_ROOT, 'bin', 'mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pipeline-state-')));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function buildSession(tmpRoot) {
    const extDir = path.join(tmpRoot, 'ext');
    const templatesDir = path.join(extDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'pickle.md'), '# Fixture\n$ARGUMENTS\n');
    writeJson(path.join(extDir, 'pickle_settings.json'), {
        default_max_iterations: 3,
        default_max_time_minutes: 720,
        default_worker_timeout_seconds: 1200,
        default_manager_max_turns: 50,
        default_tmux_max_turns: 200,
        default_refinement_cycles: 3,
        default_refinement_max_turns: 100,
        default_meeseeks_model: 'sonnet',
        default_meeseeks_min_passes: 10,
        default_meeseeks_max_passes: 20,
        circuit_breaker: { enabled: false },
    });

    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');
    writeJson(statePath, {
        active: true,
        working_dir: tmpRoot,
        step: 'research',
        iteration: 0,
        max_iterations: 3,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'pipeline state coherence fixture',
        current_ticket: 'coherence-ticket',
        history: [],
        activity: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
        schema_version: 1,
        chain_meeseeks: false,
    });

    const observationsPath = path.join(tmpRoot, 'observations.jsonl');
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaudePath = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(
        fakeClaudePath,
        `#!/usr/bin/env node
const fs = require('fs');
const statePath = process.env.TEST_STATE_PATH;
const observationsPath = process.env.TEST_OBSERVATIONS_PATH;
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
const nextByIteration = { 1: 'plan', 2: 'implement', 3: 'review' };
fs.appendFileSync(observationsPath, JSON.stringify({
  iteration: state.iteration,
  step: state.step,
  current_ticket: state.current_ticket
}) + '\\n');
const next = nextByIteration[state.iteration];
if (next && state.step !== next) {
  state.activity = Array.isArray(state.activity) ? state.activity : [];
  state.activity.push({
    event: 'phase_transition',
    source: 'test-fixture',
    iteration: state.iteration,
    previous_phase: state.step,
    next_phase: next,
    ticket: state.current_ticket
  });
  state.step = next;
}
if (state.iteration === 3) {
  state.activity.push({
    event: 'phase_transition',
    source: 'test-fixture',
    iteration: state.iteration,
    previous_phase: 'review',
    next_phase: 'completed',
    ticket: state.current_ticket
  });
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'continue fixture' }] } }));
`,
    );
    fs.chmodSync(fakeClaudePath, 0o755);

    return { extDir, sessionDir, fakeBinDir, observationsPath, statePath };
}

function readObservations(file) {
    return fs.readFileSync(file, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => fs.readFileSync(path.join(activityDir, name), 'utf-8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line)));
}

function countRunnerIterations(runnerLog) {
    const matches = runnerLog.match(/--- Iteration \d+(?: \(state\.iteration=\d+\))? ---/g);
    return matches ? matches.length : 0;
}

test('pipeline state stays coherent across a three-iteration mux-runner fixture', { timeout: 60000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { extDir, sessionDir, fakeBinDir, observationsPath, statePath } = buildSession(tmpRoot);

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            cwd: EXTENSION_ROOT,
            env: {
                ...process.env,
                EXTENSION_DIR: extDir,
                PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
                PICKLE_BACKEND: 'claude',
                PICKLE_DATA_ROOT: path.join(tmpRoot, 'pickle-data'),
                TEST_STATE_PATH: statePath,
                TEST_OBSERVATIONS_PATH: observationsPath,
            },
            encoding: 'utf-8',
            timeout: 60000,
        });

        const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
        // Per R-CNAR-1 part 2 cap split (extension/CLAUDE.md trap door): once the
        // per-ticket budget (max_iterations=3) is consumed without an
        // EPIC_COMPLETED promise, mux-runner exits 3 with
        // exit_reason='iteration_cap_exhausted' via safeDeactivate (forensic path).
        // step/current_ticket are intentionally preserved for postmortem.
        assert.equal(result.status, 3, `expected exit 3 (iteration_cap_exhausted); output:\n${output}`);

        const runnerLogPath = path.join(sessionDir, 'mux-runner.log');
        assert.ok(fs.existsSync(runnerLogPath), 'mux-runner.log should exist');
        const runnerLog = fs.readFileSync(runnerLogPath, 'utf-8');
        const runnerIterationCount = countRunnerIterations(runnerLog);
        assert.equal(runnerIterationCount, 3, `expected three runner iterations; log:\n${runnerLog}`);

        const iterationLogs = fs.readdirSync(sessionDir)
            .filter((name) => /^tmux_iteration_\d+\.log$/.test(name))
            .sort();
        assert.deepEqual(iterationLogs, [
            'tmux_iteration_1.log',
            'tmux_iteration_2.log',
            'tmux_iteration_3.log',
        ]);

        const observations = readObservations(observationsPath);
        assert.deepEqual(
            observations.map((entry) => entry.iteration),
            [1, 2, 3],
            'backend should observe the same three iterations as mux-runner',
        );
        assert.deepEqual(
            observations.map((entry) => entry.step),
            ['research', 'plan', 'implement'],
            'step should advance coherently before each worker iteration',
        );
        assert.deepEqual(
            observations.map((entry) => entry.current_ticket),
            ['coherence-ticket', 'coherence-ticket', 'coherence-ticket'],
            'current_ticket should remain stable during active worker iterations',
        );

        const finalState = readJson(statePath);
        assert.equal(finalState.iteration, runnerIterationCount, 'state.iteration should match mux-runner.log iteration count');
        // Forensic preservation: cap-exhausted exits go through safeDeactivate, NOT
        // finalizeTerminalState. step and current_ticket survive for postmortem.
        // The fixture's iteration-3 worker advances state.step to 'review' before
        // the next loop iteration's cap-check fires.
        assert.equal(finalState.step, 'review', "terminal state.step should be 'review' (preserved from iteration 3 advance before cap check)");
        assert.equal(finalState.current_ticket, 'coherence-ticket', 'cap-exhausted forensic exit should preserve current_ticket');
        assert.equal(finalState.exit_reason, 'iteration_cap_exhausted', 'cap-exhausted exit must record exit_reason for auto-resume gating (R-CNAR-4)');
        assert.equal(finalState.active, false, 'safeDeactivate must clear active flag on cap exhaustion');

        const iterationStartEvents = readActivityEvents(path.join(tmpRoot, 'pickle-data'))
            .filter((entry) => entry.event === 'iteration_start');
        assert.deepEqual(
            iterationStartEvents.map((entry) => entry.iteration),
            [1, 2, 3],
            'activity log should contain one iteration_start event per runner iteration',
        );
        assert.equal(
            iterationStartEvents.length,
            runnerIterationCount,
            'iteration_start activity count should match mux-runner.log iteration count',
        );

        const phaseTransitions = (finalState.activity ?? []).filter((entry) => entry.event === 'phase_transition');
        assert.deepEqual(
            phaseTransitions.map((entry) => [entry.previous_phase, entry.next_phase]),
            [
                ['research', 'plan'],
                ['plan', 'implement'],
                ['implement', 'review'],
                ['review', 'completed'],
            ],
            'each phase boundary should emit phase_transition activity',
        );

        const observedAndTerminalSteps = [
            ...observations.map((entry) => entry.step),
            phaseTransitions[2]?.next_phase,
            phaseTransitions[3]?.next_phase,
            finalState.step,
        ];
        assert.deepEqual(
            observedAndTerminalSteps,
            ['research', 'plan', 'implement', 'review', 'completed', 'review'],
            'observed worker steps + activity-log phase transitions + cap-exhausted forensic state.step',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// R-MDS-1: respawnMonitorWindowForMode integration tests
// ---------------------------------------------------------------------------

function readActivityEventsFromDir(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter((n) => n.endsWith('.jsonl'))
        .flatMap((n) =>
            fs.readFileSync(path.join(activityDir, n), 'utf-8')
                .split(/\r?\n/)
                .filter(Boolean)
                .map((l) => JSON.parse(l)),
        );
}

function makeSessionDir(tmpRoot) {
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true, step: 'anatomy-park', iteration: 1, schema_version: 1,
        working_dir: tmpRoot, max_iterations: 5, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 0,
        completion_promise: null, original_prompt: '', current_ticket: null,
        history: [], activity: [], started_at: new Date().toISOString(),
        session_dir: sessionDir, chain_meeseeks: false,
    }));
    return sessionDir;
}

test('respawnMonitorWindowForMode: emits monitor_respawn_started on success', { timeout: 15000 }, async () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-respawn-')));
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        const sessionDir = makeSessionDir(tmpRoot);
        const dataRoot = path.join(tmpRoot, 'data');
        process.env.PICKLE_DATA_ROOT = dataRoot;

        const capturedArgs = [];
        const mockSpawnSync = (_cmd, args, _opts) => {
            capturedArgs.push([...args]);
            if (args[0] === 'display-message') return { status: 0, stdout: 'pickle-test\n', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };

        await respawnMonitorWindowForMode(sessionDir, 'anatomy-park', mockSpawnSync);

        const events = readActivityEventsFromDir(dataRoot);
        const started = events.filter((e) => e.event === 'monitor_respawn_started');
        assert.equal(started.length, 1, 'should emit one monitor_respawn_started event');
        assert.equal(started[0].gate_payload.mode, 'microverse', 'anatomy-park maps to microverse');
        assert.equal(started[0].gate_payload.to_phase, 'anatomy-park', 'to_phase is anatomy-park');
        const respawnCall = capturedArgs.find((a) => a[0] === 'respawn-pane');
        assert.ok(respawnCall, 'should call tmux respawn-pane');
        assert.ok(respawnCall.join(' ').includes('--mode microverse'), 'respawn-pane command includes --mode microverse');
    } finally {
        if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('respawnMonitorWindowForMode: emits monitor_respawn_failed and is non-fatal on tmux unavailable', { timeout: 15000 }, async () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-respawn-')));
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        const sessionDir = makeSessionDir(tmpRoot);
        const dataRoot = path.join(tmpRoot, 'data');
        process.env.PICKLE_DATA_ROOT = dataRoot;

        const mockSpawnSync = (_cmd, _args, _opts) => ({ status: 1, stdout: '', stderr: 'no server running' });

        await assert.doesNotReject(
            respawnMonitorWindowForMode(sessionDir, 'szechuan-sauce', mockSpawnSync),
            'respawnMonitorWindowForMode must not throw on tmux unavailable',
        );

        const events = readActivityEventsFromDir(dataRoot);
        const failed = events.filter((e) => e.event === 'monitor_respawn_failed');
        assert.ok(failed.length >= 1, 'should emit monitor_respawn_failed event');
        assert.equal(failed[0].gate_payload.phase, 'szechuan-sauce', 'failed event carries phase');
        assert.ok(typeof failed[0].gate_payload.error === 'string' && failed[0].gate_payload.error.length > 0,
            'failed event carries error message');
    } finally {
        if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('respawnMonitorWindowForMode: phase-to-mode mapping covers all phases', { timeout: 15000 }, async () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-respawn-')));
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        const sessionDir = makeSessionDir(tmpRoot);
        const dataRoot = path.join(tmpRoot, 'data');
        process.env.PICKLE_DATA_ROOT = dataRoot;

        const expectedModes = [
            ['anatomy-park', 'microverse'],
            ['szechuan-sauce', 'microverse'],
            ['pickle', 'pickle'],
            ['exit', 'idle'],
        ];

        for (const [phase, expectedMode] of expectedModes) {
            const capturedRespawnArgs = [];
            const mockSpawnSync = (_cmd, args, _opts) => {
                if (args[0] === 'display-message') return { status: 0, stdout: 'pickle-test\n', stderr: '' };
                capturedRespawnArgs.push([...args]);
                return { status: 0, stdout: '', stderr: '' };
            };
            await respawnMonitorWindowForMode(sessionDir, phase, mockSpawnSync);
            assert.ok(capturedRespawnArgs.length > 0, `should call respawn-pane for phase=${phase}`);
            const cmd = capturedRespawnArgs[capturedRespawnArgs.length - 1].join(' ');
            assert.ok(
                cmd.includes(`--mode ${expectedMode}`),
                `phase=${phase} should map to --mode ${expectedMode}, got: ${cmd}`,
            );
        }
    } finally {
        if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
