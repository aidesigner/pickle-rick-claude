// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
        assert.equal(result.status, 0, `expected runner to exit cleanly; output:\n${output}`);

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
        assert.equal(finalState.step, 'completed', 'terminal state should be completed');
        assert.equal(finalState.current_ticket, null, 'terminal state should clear current_ticket');

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
            finalState.step,
        ];
        assert.deepEqual(
            observedAndTerminalSteps,
            ['research', 'plan', 'implement', 'review', 'completed'],
            'state.step should transition through research, plan, implement, review, and completed',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
