import { strictEqual } from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { StateManager } from '../../services/state-manager.js';
import { _deps, handleIterationOutcome, } from '../microverse-runner.js';
const stateManager = new StateManager();
function makeMicroverseState() {
    return {
        status: 'iterating',
        prd_path: 'prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md',
        key_metric: {
            description: 'test metric',
            validation: 'echo ok',
            type: 'command',
            timeout_seconds: 30,
            tolerance: 0,
        },
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [],
        },
        gap_analysis_path: 'gap.md',
        failed_approaches: [],
        baseline_score: 0,
        failure_history: [],
        approach_exhaustion_fired: false,
        convergence_mode: 'worker',
        convergence_file: 'anatomy-park.json',
        current_subsystem: 'alpha',
        consecutive_subprocess_errors: 0,
    };
}
function makeRunnerState(sessionDir, workingDir) {
    return {
        active: true,
        working_dir: workingDir,
        step: 'anatomy-park',
        iteration: 111,
        max_iterations: 200,
        max_time_minutes: 0,
        worker_timeout_seconds: 0,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'R-APMW-1 baseline',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
        backend: 'codex',
    };
}
function makeContext(sessionDir, statePath, currentRunnerState) {
    return {
        sessionDir,
        extensionRoot: path.resolve(sessionDir, '..'),
        statePath,
        workingDir: currentRunnerState.working_dir,
        startTime: Date.now(),
        initialIteration: 110,
        enableFailureClassification: true,
        cgSettings: {
            enabled_convergence_files: ['anatomy-park.json'],
            regression_warning_threshold: 5,
            remediator_timeout_s: 600,
            baseline_max_age_iterations: 30,
            baseline_max_age_seconds: 14_400,
        },
        rateLimitWaitMinutes: 60,
        maxRateLimitRetries: 3,
        log: () => { },
        currentRunnerState,
        iteration: 111,
        consecutiveRateLimits: 0,
    };
}
function makeBaseline() {
    return { raw: '0', score: 0 };
}
function makeOutcome(overrides = {}) {
    return {
        completion: 'error',
        timedOut: true,
        exitCode: null,
        wallSeconds: 14_400,
        ...overrides,
    };
}
test('R-APMW-1: spec imports without runtime error', () => {
    strictEqual(typeof handleIterationOutcome, 'function');
    strictEqual(typeof _deps.collectTickets, 'function');
});
async function writeWorkerConvergenceLedger(sessionDir) {
    await fs.promises.writeFile(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
        subsystems: ['alpha', 'beta'],
        current_index: 0,
        stall_counts: { alpha: 0, beta: 0 },
    }, null, 2));
}
function readMicroverse(sessionDir) {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}
function readConvergenceLedger(sessionDir) {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'anatomy-park.json'), 'utf-8'));
}
async function runWorkerErrorScenario(opts) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw1-session-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw1-work-'));
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const logs = [];
    const microverseState = {
        ...makeMicroverseState(),
        convergence_mode: opts?.convergenceMode ?? 'worker',
        consecutive_subprocess_errors: opts?.consecutiveErrors ?? 0,
    };
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    await fs.promises.writeFile(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));
    await writeWorkerConvergenceLedger(sessionDir);
    const originalCollectTickets = _deps.collectTickets;
    const originalGetHeadSha = _deps.getHeadSha;
    const originalSleep = _deps.sleep;
    try {
        _deps.collectTickets = () => [];
        _deps.getHeadSha = () => 'deadbeef';
        _deps.sleep = async () => { };
        const ctx = makeContext(sessionDir, statePath, runnerState);
        ctx.log = (msg) => { logs.push(msg); };
        const result = await handleIterationOutcome(microverseState, makeBaseline(), ctx, makeOutcome());
        return {
            result,
            logs,
            microverseState: readMicroverse(sessionDir),
            convergenceLedger: readConvergenceLedger(sessionDir),
        };
    }
    finally {
        _deps.collectTickets = originalCollectTickets;
        _deps.getHeadSha = originalGetHeadSha;
        _deps.sleep = originalSleep;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
}
/* baseline retired by R-APMW-2 */
test("R-APMW-1: handleIterationOutcome returns 'continue' on worker codex timeout with no tickets", async () => {
    const scenario = await runWorkerErrorScenario();
    strictEqual(scenario.result, 'continue');
});
test("R-APMW-2: first worker subprocess error returns 'continue'", async () => {
    const scenario = await runWorkerErrorScenario({ consecutiveErrors: 0 });
    strictEqual(scenario.result, 'continue');
    strictEqual(scenario.microverseState.consecutive_subprocess_errors, 1);
    strictEqual(scenario.convergenceLedger.stall_counts.alpha, 1);
    strictEqual(scenario.convergenceLedger.current_index, 1);
});
test("R-APMW-2: second worker subprocess error returns 'continue'", async () => {
    const scenario = await runWorkerErrorScenario({ consecutiveErrors: 1 });
    strictEqual(scenario.result, 'continue');
    strictEqual(scenario.microverseState.consecutive_subprocess_errors, 2);
    strictEqual(scenario.convergenceLedger.stall_counts.alpha, 1);
    strictEqual(scenario.convergenceLedger.current_index, 1);
});
test("R-APMW-2: third worker subprocess error returns 'error' (cap)", async () => {
    const scenario = await runWorkerErrorScenario({ consecutiveErrors: 2 });
    strictEqual(scenario.result, 'error');
    strictEqual(scenario.microverseState.consecutive_subprocess_errors, 3);
    strictEqual(scenario.logs.some((line) => line.includes('cap reached')), true);
});
test('R-APMW-2: manager mode unchanged on subprocess error', async () => {
    const scenario = await runWorkerErrorScenario({ convergenceMode: 'metric' });
    strictEqual(scenario.result, 'error');
    strictEqual(scenario.microverseState.consecutive_subprocess_errors, 0);
});
test('R-APMW-4: success outcome resets counter to 0', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw4-session-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw4-work-'));
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = {
        ...makeMicroverseState(),
        consecutive_subprocess_errors: 2,
    };
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    await fs.promises.writeFile(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));
    await writeWorkerConvergenceLedger(sessionDir);
    const originalCollectTickets = _deps.collectTickets;
    const originalGetHeadSha = _deps.getHeadSha;
    const originalSleep = _deps.sleep;
    const originalRunWorkerManagedIteration = _deps.runWorkerManagedIteration;
    try {
        _deps.collectTickets = () => [];
        _deps.getHeadSha = () => 'deadbeef';
        _deps.sleep = async () => { };
        _deps.runWorkerManagedIteration = async ({ currentMv }) => ({
            currentMv,
            converged: false,
            reason: 'test-success',
        });
        const ctx = makeContext(sessionDir, statePath, runnerState);
        const result = await handleIterationOutcome(microverseState, makeBaseline(), ctx, makeOutcome({ completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 30 }));
        strictEqual(result, 'continue');
        strictEqual(readMicroverse(sessionDir).consecutive_subprocess_errors, 0);
        strictEqual(microverseState.consecutive_subprocess_errors, 0);
    }
    finally {
        _deps.collectTickets = originalCollectTickets;
        _deps.getHeadSha = originalGetHeadSha;
        _deps.sleep = originalSleep;
        _deps.runWorkerManagedIteration = originalRunWorkerManagedIteration;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});
