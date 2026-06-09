// @tier: integration
// SERIAL: R-MWIS-1 drives a real subprocess (fake-node `claude`) through
// runIteration's spawn/wait path. Under the fast tier's 8-way concurrency the
// fake-node cold-start is starved and the bounded-resolution assertion slips;
// listed in tests/integration/.serial-tests.json to run serialized.
//
// R-MWIS-1 — process-exit is the PRIMARY worker-completion signal.
//
// Proves: a scripted worker that EXITS (code 0 AND non-zero) while writing
// ZERO bytes to its session log causes BOUNDED outcome processing inside
// runIteration — never a 0% CPU hang. The exit observation is independent of
// log bytes / completion-token presence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIteration } from '../bin/mux-runner.js';

// Bounded-resolution proof: a hang would never settle, so we race runIteration
// against this wall. It is far below any wall-clock / output-stall guard
// (those are set to 30s below) yet far above worst-case fake-node cold-start,
// so a PASS proves "exit was observed", not "a timeout guard fired".
const BOUND_MS = 10_000;
const ITERATION_BUDGET_SECONDS = 30;
const STALL_BUDGET_SECONDS = 30;

function buildState(sessionDir) {
  return {
    active: true,
    // Live pid so the phantom-demotion guard does not flip this active fixture
    // inactive on read (which would short-circuit runIteration to 'inactive').
    pid: process.pid,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 5,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1_700_000_000,
    completion_promise: null,
    original_prompt: 'R-MWIS-1 test',
    current_ticket: null,
    history: [],
    started_at: '2026-06-08T00:00:00.000Z',
    session_dir: sessionDir,
    backend: 'claude',
    schema_version: 3,
  };
}

// Fake `claude`: exits IMMEDIATELY with the configured code, writing ZERO bytes
// to stdout/stderr (no console.log, no process.stdout.write). This reproduces a
// silent 0-byte worker exit / render-lag.
const SILENT_CLAUDE_SOURCE = `#!/usr/bin/env node
process.exit(Number(process.env.R_MWIS_EXIT_CODE || '0'));
`;

function makeSilentExitSession(prefix) {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(sessionDir, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'templates', '_pickle-manager-prompt.md'),
    '# Pickle\n\n$ARGUMENTS\n',
  );
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(buildState(sessionDir)));

  const fakeBin = path.join(sessionDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const claudePath = path.join(fakeBin, 'claude');
  fs.writeFileSync(claudePath, SILENT_CLAUDE_SOURCE);
  fs.chmodSync(claudePath, 0o755);

  return { sessionDir, fakeBin };
}

async function runSilentExit(exitCode) {
  const { sessionDir, fakeBin } = makeSilentExitSession(`pickle-mwis1-${exitCode}-`);

  const iteration = runIteration(sessionDir, 1, sessionDir, '', {
    envOverrides: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      PICKLE_BACKEND: 'claude',
      R_MWIS_EXIT_CODE: String(exitCode),
    },
    maxIterationSeconds: ITERATION_BUDGET_SECONDS,
    outputStallSeconds: STALL_BUDGET_SECONDS,
  });

  let boundTimer;
  const bound = new Promise((_resolve, reject) => {
    boundTimer = setTimeout(
      () => reject(new Error(`runIteration did not settle within ${BOUND_MS}ms — 0% CPU hang on silent exit ${exitCode}`)),
      BOUND_MS,
    );
    boundTimer.unref();
  });

  try {
    const outcome = await Promise.race([iteration, bound]);
    return { outcome, sessionDir };
  } finally {
    clearTimeout(boundTimer);
  }
}

test('R-MWIS-1: worker exit 0 with 0-byte log resolves bounded (not a hang)', async () => {
  const { outcome, sessionDir } = await runSilentExit(0);
  try {
    // Exit observed → bounded outcome, never a stall/wall-clock timeout.
    assert.equal(outcome.timedOut, false, 'silent exit must NOT be classified as a timeout');
    assert.equal(outcome.stallReason, undefined, 'silent exit must NOT trip the stall guard');
    assert.equal(outcome.exitCode, 0, 'exit code 0 must be observed via child exit/wait');
    // classifyCompletion('') → 'continue': a valid, non-error, bounded outcome.
    assert.equal(outcome.completion, 'continue');

    // Prove the worker truly wrote 0 bytes — the exit, not log output, drove resolution.
    const logPath = path.join(sessionDir, 'tmux_iteration_1.log');
    assert.ok(fs.existsSync(logPath), 'iteration log file should exist');
    assert.equal(fs.statSync(logPath).size, 0, 'worker wrote ZERO bytes to its session log');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-MWIS-1: worker non-zero exit (code 3) with 0-byte log resolves bounded (not a hang)', async () => {
  const { outcome, sessionDir } = await runSilentExit(3);
  try {
    assert.equal(outcome.timedOut, false, 'silent non-zero exit must NOT be classified as a timeout');
    assert.equal(outcome.stallReason, undefined, 'silent non-zero exit must NOT trip the stall guard');
    assert.equal(outcome.exitCode, 3, 'non-zero exit code must be observed via child exit/wait');
    assert.equal(outcome.completion, 'continue');

    const logPath = path.join(sessionDir, 'tmux_iteration_1.log');
    assert.ok(fs.existsSync(logPath), 'iteration log file should exist');
    assert.equal(fs.statSync(logPath).size, 0, 'worker wrote ZERO bytes to its session log');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
