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
async function withPatchedTimeoutDefaults(overrides, run) {
    const defaults = Defaults;
    const original = {
        MAX_ITERATION_SECONDS: defaults.MAX_ITERATION_SECONDS,
        OUTPUT_STALL_SECONDS: defaults.OUTPUT_STALL_SECONDS,
    };
    defaults.MAX_ITERATION_SECONDS = overrides.MAX_ITERATION_SECONDS;
    defaults.OUTPUT_STALL_SECONDS = overrides.OUTPUT_STALL_SECONDS;
    try {
        return await run();
    }
    finally {
        defaults.MAX_ITERATION_SECONDS = original.MAX_ITERATION_SECONDS;
        defaults.OUTPUT_STALL_SECONDS = original.OUTPUT_STALL_SECONDS;
    }
}
async function runScenario(scenario, overrides) {
    const { sessionDir, fakeBin, signalFile, markerFile } = makeScenarioSession(`pickle-rapmw6-${scenario}-`);
    const oldPath = process.env.PATH;
    const oldBackend = process.env.PICKLE_BACKEND;
    const oldScenario = process.env.R_APMW6_SCENARIO;
    const oldSignalFile = process.env.R_APMW6_SIGNAL_FILE;
    const oldMarkerFile = process.env.R_APMW6_MARKER_FILE;
    try {
        process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ''}`;
        process.env.PICKLE_BACKEND = 'claude';
        process.env.R_APMW6_SCENARIO = scenario;
        process.env.R_APMW6_SIGNAL_FILE = signalFile;
        process.env.R_APMW6_MARKER_FILE = markerFile;
        const outcome = await withPatchedTimeoutDefaults(overrides, async () => (runIteration(sessionDir, 1, sessionDir, '')));
        return { outcome, sessionDir, signalFile, markerFile };
    }
    finally {
        if (oldPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = oldPath;
        if (oldBackend === undefined)
            delete process.env.PICKLE_BACKEND;
        else
            process.env.PICKLE_BACKEND = oldBackend;
        if (oldScenario === undefined)
            delete process.env.R_APMW6_SCENARIO;
        else
            process.env.R_APMW6_SCENARIO = oldScenario;
        if (oldSignalFile === undefined)
            delete process.env.R_APMW6_SIGNAL_FILE;
        else
            process.env.R_APMW6_SIGNAL_FILE = oldSignalFile;
        if (oldMarkerFile === undefined)
            delete process.env.R_APMW6_MARKER_FILE;
        else
            process.env.R_APMW6_MARKER_FILE = oldMarkerFile;
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
        assert.match(await fs.promises.readFile(scenario.markerFile, 'utf-8'), /emit:progress/);
        assert.match(await fs.promises.readFile(scenario.signalFile, 'utf-8'), /SIGTERM/);
    }
    finally {
        fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
    }
});
test('R-APMW-6: normal subprocess clears both timers on success', async () => {
    const timeoutCountBefore = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
    const scenario = await runScenario('success', {
        MAX_ITERATION_SECONDS: 3,
        OUTPUT_STALL_SECONDS: 5,
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
