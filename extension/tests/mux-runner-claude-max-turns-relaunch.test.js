// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  processCompletionBranch,
  processIterationOutcome,
  runIteration,
} from '../bin/mux-runner.js';

function makeTmpDir(prefix = 'pickle-claude-max-turns-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeExecutableNodeScript(filePath, source) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(filePath, 0o755);
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${id}`,
    `title: ${id} fixture`,
    `status: ${status}`,
    'order: 1',
    '---',
    '',
    '# Fixture',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), content);
}

function writeState(sessionDir, overrides = {}) {
  const state = {
    active: true,
    backend: 'claude',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'mux-runner relaunch regression fixture',
    current_ticket: 'ticket-001',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    manager_relaunch_count: 0,
    ...overrides,
  };
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { state, statePath };
}

function buildContext(sessionDir, statePath, outcome, iterLogFile, logs, deactivateCalls) {
  return {
    sessionDir,
    statePath,
    extensionRoot: process.cwd(),
    iteration: 3,
    outcome,
    iterLogFile,
    cbState: null,
    log: message => logs.push(message),
    deactivate: target => deactivateCalls.push(target),
  };
}

async function withFixture(overrides, run) {
  const dir = makeTmpDir();
  try {
    writeTicket(dir, 'ticket-001', 'Todo');
    writeTicket(dir, 'ticket-002', 'Done');
    const { state, statePath } = writeState(dir, overrides?.state);
    const iterLogFile = path.join(dir, 'tmux_iteration_3.log');
    fs.writeFileSync(iterLogFile, overrides?.iterLog ?? '');
    const logs = [];
    const deactivateCalls = [];
    const outcome = {
      completion: 'error',
      timedOut: false,
      exitCode: 0,
      wallSeconds: 12,
      ...(overrides?.outcome ?? {}),
    };
    await run({
      dir,
      state,
      statePath,
      iterLogFile,
      logs,
      deactivateCalls,
      outcome,
      ctx: buildContext(dir, statePath, outcome, iterLogFile, logs, deactivateCalls),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('claude-max-turns-relaunch: claude max-turns exit relaunches instead of tearing down', async () => {
  const oldPath = process.env.PATH;
  const oldBackend = process.env.PICKLE_BACKEND;
  try {
    await withFixture({}, async ({ dir, statePath, logs, deactivateCalls }) => {
      fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'templates', 'pickle.md'), '# Pickle\n\n$ARGUMENTS\n');
      const fakeBin = path.join(dir, 'fake-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      makeExecutableNodeScript(path.join(fakeBin, 'claude'), `
console.log(JSON.stringify({ type: 'assistant', content: 'work' }));
console.log(JSON.stringify({ type: 'result', stop_reason: 'end_turn', terminal_reason: 'completed', is_error: false }));
`);

      process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ''}`;
      process.env.PICKLE_BACKEND = 'claude';

      const outcome = await runIteration(dir, 3, dir, '');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const iterLogFile = path.join(dir, 'tmux_iteration_3.log');
      const ctx = buildContext(dir, statePath, outcome, iterLogFile, logs, deactivateCalls);
      const action = await processIterationOutcome(state, outcome, ctx);
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      assert.equal(outcome.completion, 'error');
      assert.equal(outcome.exitCode, 0);
      assert.equal(action.kind, 'relaunch');
      assert.equal(action.relaunchCount, 1);
      assert.equal(action.pendingTickets, 1);
      assert.equal(deactivateCalls.length, 0);
      assert.equal(persisted.manager_relaunch_count, 1);
      assert.ok(
        logs.some(line => line.includes('claude manager subprocess exited via claude_max_turns with 1 ticket(s) still pending')),
        `expected claude relaunch log, got:\n${logs.join('\n')}`,
      );
      assert.ok(!logs.includes('Subprocess error. Exiting loop.'));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldBackend === undefined) delete process.env.PICKLE_BACKEND;
    else process.env.PICKLE_BACKEND = oldBackend;
  }
});

test('claude-max-turns-relaunch: codex hang-guard relaunch path still works', async () => {
  await withFixture({
    state: { backend: 'codex' },
    outcome: { timedOut: true, exitCode: null, wallSeconds: 14_401 },
    iterLog: 'timed out\n',
  }, async ({ state, ctx, statePath, logs, deactivateCalls }) => {
    const action = await processCompletionBranch(state, 'error', ctx);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(action.kind, 'relaunch');
    assert.equal(deactivateCalls.length, 0);
    assert.equal(persisted.manager_relaunch_count, 1);
    assert.ok(
      logs.some(line => line.includes('codex manager subprocess exited via codex_4h_hang_guard with 1 ticket(s) still pending')),
      `expected codex relaunch log, got:\n${logs.join('\n')}`,
    );
  });
});

test('claude-max-turns-relaunch: genuine subprocess crash still tears down', async () => {
  await withFixture({
    iterLog: '{"type":"result","stop_reason":"error","terminal_reason":"crash","is_error":true}\n',
    outcome: { exitCode: 1, timedOut: false, wallSeconds: 2 },
  }, async ({ state, ctx, logs, deactivateCalls }) => {
    const action = await processCompletionBranch(state, 'error', ctx);

    assert.equal(action.kind, 'break');
    assert.equal(action.reason, 'error');
    assert.equal(deactivateCalls.length, 1);
    assert.ok(logs.includes('Subprocess error. Exiting loop.'));
    assert.ok(
      !logs.some(line => line.includes('relaunching')),
      `did not expect relaunch log, got:\n${logs.join('\n')}`,
    );
  });
});
