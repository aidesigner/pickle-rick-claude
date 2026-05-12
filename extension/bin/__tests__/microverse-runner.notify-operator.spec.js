import { ok, strictEqual } from 'node:assert/strict';
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
        original_prompt: 'R-APMW-9 notification',
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
async function writeWorkerConvergenceLedger(sessionDir) {
    await fs.promises.writeFile(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
        subsystems: ['alpha', 'beta'],
        current_index: 0,
        stall_counts: { alpha: 0, beta: 0 },
    }, null, 2));
}
function notificationLogPath(homeDir) {
    return path.join(homeDir, '.claude', 'pickle-rick', 'notifications.log');
}
async function pathExists(targetPath) {
    try {
        await fs.promises.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
function stubSpawnSync() {
    return {
        pid: 0,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
    };
}
async function runWorkerErrorScenario(opts) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-session-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-work-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-home-'));
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = {
        ...makeMicroverseState(),
        consecutive_subprocess_errors: opts.consecutiveErrors,
    };
    const logPath = notificationLogPath(fakeHome);
    if (opts.breakNotificationDir) {
        await fs.promises.writeFile(path.join(fakeHome, '.claude'), 'not-a-directory');
    }
    const previousHome = process.env.HOME;
    const previousNotify = process.env.PICKLE_NOTIFY_ON_ERROR;
    const originalCollectTickets = _deps.collectTickets;
    const originalGetHeadSha = _deps.getHeadSha;
    const originalSleep = _deps.sleep;
    const originalSpawnSync = _deps.spawnSync;
    try {
        if (opts.notifyEnv === undefined)
            delete process.env.PICKLE_NOTIFY_ON_ERROR;
        else
            process.env.PICKLE_NOTIFY_ON_ERROR = opts.notifyEnv;
        process.env.HOME = fakeHome;
        // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
        stateManager.forceWrite(statePath, runnerState);
        await fs.promises.writeFile(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));
        await writeWorkerConvergenceLedger(sessionDir);
        _deps.collectTickets = () => [];
        _deps.getHeadSha = () => 'deadbeef';
        _deps.sleep = async () => { };
        _deps.spawnSync = (() => stubSpawnSync());
        const result = await handleIterationOutcome(microverseState, makeBaseline(), makeContext(sessionDir, statePath, runnerState), makeOutcome());
        return {
            result,
            logPath,
        };
    }
    finally {
        _deps.collectTickets = originalCollectTickets;
        _deps.getHeadSha = originalGetHeadSha;
        _deps.sleep = originalSleep;
        _deps.spawnSync = originalSpawnSync;
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousNotify === undefined)
            delete process.env.PICKLE_NOTIFY_ON_ERROR;
        else
            process.env.PICKLE_NOTIFY_ON_ERROR = previousNotify;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
}
test('R-APMW-9: PICKLE_NOTIFY_ON_ERROR unset -> no notification', async () => {
    const scenario = await runWorkerErrorScenario({
        consecutiveErrors: 2,
        notifyEnv: undefined,
    });
    strictEqual(scenario.result, 'error');
    strictEqual(await pathExists(scenario.logPath), false);
});
test('R-APMW-9: PICKLE_NOTIFY_ON_ERROR=1 -> one NDJSON line appended', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-session-on-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-work-on-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rapmw9-home-on-'));
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = {
        ...makeMicroverseState(),
        consecutive_subprocess_errors: 2,
    };
    const previousHome = process.env.HOME;
    const previousNotify = process.env.PICKLE_NOTIFY_ON_ERROR;
    const originalCollectTickets = _deps.collectTickets;
    const originalGetHeadSha = _deps.getHeadSha;
    const originalSleep = _deps.sleep;
    const originalSpawnSync = _deps.spawnSync;
    try {
        process.env.HOME = fakeHome;
        process.env.PICKLE_NOTIFY_ON_ERROR = '1';
        // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
        stateManager.forceWrite(statePath, runnerState);
        await fs.promises.writeFile(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));
        await writeWorkerConvergenceLedger(sessionDir);
        _deps.collectTickets = () => [];
        _deps.getHeadSha = () => 'deadbeef';
        _deps.sleep = async () => { };
        _deps.spawnSync = (() => stubSpawnSync());
        const result = await handleIterationOutcome(microverseState, makeBaseline(), makeContext(sessionDir, statePath, runnerState), makeOutcome());
        strictEqual(result, 'error');
        const lines = (await fs.promises.readFile(notificationLogPath(fakeHome), 'utf-8')).trim().split('\n');
        strictEqual(lines.length, 1);
        const record = JSON.parse(lines[0]);
        strictEqual(record.session_id, path.basename(sessionDir));
        strictEqual(record.iteration, 111);
        strictEqual(record.reason, 'subprocess_error_cap_exhausted');
        strictEqual(record.completion, 'error');
        strictEqual(record.timedOut, true);
        strictEqual(record.stallReason, null);
        ok(typeof record.ts === 'string' && String(record.ts).length > 0);
    }
    finally {
        _deps.collectTickets = originalCollectTickets;
        _deps.getHeadSha = originalGetHeadSha;
        _deps.sleep = originalSleep;
        _deps.spawnSync = originalSpawnSync;
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousNotify === undefined)
            delete process.env.PICKLE_NOTIFY_ON_ERROR;
        else
            process.env.PICKLE_NOTIFY_ON_ERROR = previousNotify;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});
test('R-APMW-9: notifier never throws', async () => {
    const scenario = await runWorkerErrorScenario({
        consecutiveErrors: 2,
        notifyEnv: '1',
        breakNotificationDir: true,
    });
    strictEqual(scenario.result, 'error');
});
test('R-APMW-9: only fires on cap-exhaustion path', async () => {
    const scenario = await runWorkerErrorScenario({
        consecutiveErrors: 1,
        notifyEnv: '1',
    });
    strictEqual(scenario.result, 'continue');
    strictEqual(await pathExists(scenario.logPath), false);
});
