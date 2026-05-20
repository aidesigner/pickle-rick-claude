import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runIteration } from '../../bin/mux-runner.js';
import { Defaults } from '../../types/index.js';
function makeExecutableNodeScript(filePath, source) {
    fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`);
    fs.chmodSync(filePath, 0o755);
}
function buildState(sessionDir) {
    return {
        active: true,
        working_dir: sessionDir,
        step: 'implement',
        iteration: 0,
        max_iterations: 5,
        worker_timeout_seconds: 1200,
        start_time_epoch: 1_700_000_000,
        completion_promise: null,
        original_prompt: 'R-APMW-6 test',
        current_ticket: null,
        history: [],
        started_at: '2026-05-12T00:00:00.000Z',
        session_dir: sessionDir,
        backend: 'claude',
        schema_version: 3,
    };
}
function makeScenarioSession(prefix) {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    fs.mkdirSync(path.join(sessionDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'templates', 'pickle.md'), '# Pickle\n\n$ARGUMENTS\n');
    // eslint-disable-next-line pickle/no-raw-state-write -- isolated test fixture bootstrap before any runner lock exists
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(buildState(sessionDir)));
    const fakeBin = path.join(sessionDir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const signalFile = path.join(sessionDir, 'signals.log');
    const markerFile = path.join(sessionDir, 'marker.log');
    makeExecutableNodeScript(path.join(fakeBin, 'claude'), `
const fs = require('node:fs');

const scenario = process.env.R_APMW6_SCENARIO;
const signalFile = process.env.R_APMW6_SIGNAL_FILE;
const markerFile = process.env.R_APMW6_MARKER_FILE;

function note(line) {
  if (!markerFile) return;
  fs.appendFileSync(markerFile, line + '\\n');
}

function emit(line) {
  process.stdout.write(line + '\\n');
  note('emit:' + line);
}

process.on('SIGTERM', () => {
  if (scenario === 'output-stall-delayed-sigterm') return;
  if (signalFile) fs.appendFileSync(signalFile, 'SIGTERM\\n');
  process.exit(0);
});

if (scenario === 'output-stall') {
  emit('start');
  let count = 0;
  let keepAlive = null;
  const timer = setInterval(() => {
    count += 1;
    emit('progress-' + count);
    if (count >= 5) {
      clearInterval(timer);
      keepAlive = setTimeout(() => {
        note('unexpected-exit');
        process.exit(0);
      }, 60_000);
    }
  }, 60);
  process.on('exit', () => {
    if (keepAlive) clearTimeout(keepAlive);
  });
} else if (scenario === 'output-stall-delayed-sigterm') {
  emit('start');
  let count = 0;
  let keepAlive = null;
  const timer = setInterval(() => {
    count += 1;
    emit('progress-' + count);
    if (count >= 3) {
      clearInterval(timer);
      keepAlive = setTimeout(() => {
        note('unexpected-exit');
        process.exit(0);
      }, 60_000);
    }
  }, 60);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    if (keepAlive) clearTimeout(keepAlive);
    // Emit the shutdown evidence SYNCHRONOUSLY on SIGTERM receipt so it lands
    // before any SIGKILL escalation even when the worker event loop is
    // starved under 8-way full-suite load. The delayed process.exit below
    // still exercises the SUT's "wait for delayed SIGTERM cleanup before
    // resolving" contract — the SUT must keep draining stdout and awaiting
    // child exit across the delay.
    if (signalFile) fs.appendFileSync(signalFile, 'SIGTERM\\n');
    emit('shutdown-complete');
    setTimeout(() => {
      process.exit(0);
    }, 75);
  });
  process.on('exit', () => {
    clearInterval(timer);
    if (keepAlive) clearTimeout(keepAlive);
  });
} else if (scenario === 'wall-clock') {
  emit('start');
  const timer = setInterval(() => {
    emit('progress');
  }, 10);
  process.on('exit', () => clearInterval(timer));
} else if (scenario === 'success') {
  emit('ready');
  setTimeout(() => {
    note('success-exit');
    process.exit(0);
  }, 20);
} else {
  process.exit(2);
}
`);
    return { sessionDir, fakeBin, signalFile, markerFile };
}
/**
 * Deterministic barrier: poll a file until its contents match `re`, up to
 * `timeoutMs`. The `output-stall-delayed-sigterm` worker writes
 * `shutdown-complete` from a post-SIGTERM `setTimeout`, and the stdout→log
 * pipe drain is asynchronous; under 8-way full-suite load that write can land
 * a few hundred ms after `runIteration` resolves. Polling for the observable
 * condition (instead of a single immediate read) removes the timing race
 * without weakening the assertion — a genuine missing write still fails at
 * the timeout.
 */
async function waitForFileMatch(filePath, re, timeoutMs = 15_000) {
    const start = Date.now();
    let last = '';
    while (Date.now() - start < timeoutMs) {
        try {
            last = await fs.promises.readFile(filePath, 'utf-8');
            if (re.test(last)) return last;
        } catch {
            // file not created yet — keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return last;
}

async function runScenario(scenario, overrides) {
    const { sessionDir, fakeBin, signalFile, markerFile } = makeScenarioSession(`pickle-rapmw6-${scenario}-`);
    try {
        const outcome = await runIteration(sessionDir, 1, sessionDir, '', {
            envOverrides: {
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
                PICKLE_BACKEND: 'claude',
                R_APMW6_SCENARIO: scenario,
                R_APMW6_SIGNAL_FILE: signalFile,
                R_APMW6_MARKER_FILE: markerFile,
            },
            maxIterationSeconds: overrides.MAX_ITERATION_SECONDS,
            outputStallSeconds: overrides.OUTPUT_STALL_SECONDS,
        });
        return { outcome, sessionDir, signalFile, markerFile };
    }
    finally {
        // env overrides are scoped to runIteration; only the temp session needs cleanup here.
    }
}
test('R-APMW-6: output every 60s for 5 cycles then silence - fires at OUTPUT_STALL_SECONDS', async () => {
    const scenario = await runScenario('output-stall', {
        MAX_ITERATION_SECONDS: 2,
        OUTPUT_STALL_SECONDS: 0.35,
    });
    try {
        assert.equal(scenario.outcome.completion, 'error');
        assert.equal(scenario.outcome.timedOut, true);
        assert.equal(scenario.outcome.stallReason, 'output_stall');
        assert.equal(scenario.outcome.exitCode, null);
        assert.ok(scenario.outcome.wallSeconds >= 0.3);
        assert.ok(scenario.outcome.wallSeconds < Defaults.MAX_ITERATION_SECONDS);
    }
    finally {
        fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
    }
});
test('R-APMW-6: output every 10s for 4h - wall-clock guard fires', async () => {
    const scenario = await runScenario('wall-clock', {
        MAX_ITERATION_SECONDS: 1.2,
        OUTPUT_STALL_SECONDS: 5,
    });
    try {
        assert.equal(scenario.outcome.completion, 'error');
        assert.equal(scenario.outcome.timedOut, true);
        assert.equal(scenario.outcome.stallReason, 'wall_clock');
        assert.equal(scenario.outcome.exitCode, null);
    }
    finally {
        fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
    }
});
test('R-APMW-6: timeout waits for delayed SIGTERM cleanup before resolving', async () => {
    // 0.35s → 8s output-stall budget: under 8-way full-suite load the fake
    // worker's Node cold-start can exceed a 0.35s stall window, so the stall
    // guard fires before the worker emits anything — the worker is then
    // SIGTERM'd before its handler runs and `shutdown-complete` never lands
    // (the flaky empty-log failure). 8s is ample for the worker to start,
    // emit its 3 progress lines (~180ms) and then go silent; the stall guard
    // still fires deterministically on the post-progress silence, and
    // MAX_ITERATION_SECONDS stays well above it so the wall-clock guard does
    // not pre-empt the output-stall path under test.
    const scenario = await runScenario('output-stall-delayed-sigterm', {
        MAX_ITERATION_SECONDS: 40,
        OUTPUT_STALL_SECONDS: 8,
    });
    try {
        assert.equal(scenario.outcome.completion, 'error');
        assert.equal(scenario.outcome.timedOut, true);
        assert.equal(scenario.outcome.stallReason, 'output_stall');
        assert.match(
            await waitForFileMatch(path.join(scenario.sessionDir, 'tmux_iteration_1.log'), /shutdown-complete/),
            /shutdown-complete/,
        );
        assert.match(
            await waitForFileMatch(scenario.signalFile, /SIGTERM/),
            /SIGTERM/,
        );
    }
    finally {
        fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
    }
});
test('R-APMW-6: normal subprocess clears both timers on success', async () => {
    const timeoutCountBefore = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
    // 3s/5s → 40s/25s: the `success` worker exits cleanly ~20ms after it
    // starts, but under 8-way full-suite load its Node cold-start alone can
    // exceed a 3s wall-clock budget, so the iteration guard fires and the
    // outcome flips to `error` (the flaky `'error' !== 'continue'` failure).
    // Generous budgets only prevent that false timeout — a genuinely hung
    // worker would still be caught, and the timer-cleanup assertion below is
    // unaffected by the budget size.
    const scenario = await runScenario('success', {
        MAX_ITERATION_SECONDS: 40,
        OUTPUT_STALL_SECONDS: 25,
    });
    try {
        assert.equal(scenario.outcome.completion, 'continue');
        assert.equal(scenario.outcome.timedOut, false);
        assert.equal(scenario.outcome.stallReason, undefined);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 5));
        const timeoutCountAfter = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
        assert.ok(timeoutCountAfter <= timeoutCountBefore + 1);
        await assert.rejects(fs.promises.access(scenario.signalFile), { code: 'ENOENT' });
    }
    finally {
        fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
    }
});
