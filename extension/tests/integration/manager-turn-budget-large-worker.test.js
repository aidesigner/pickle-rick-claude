// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateManagerIdleBackoff } from '../../hooks/handlers/stop-hook.js';

function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-budget-'));
  fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'log-watcher.js'), '');
  fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
    manager_idle_backoff_fallback_ms: 60_000,
  }, null, 2));

  const sessionDir = path.join(tmpDir, 'session');
  const ticketDir = path.join(sessionDir, 'T1');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `worker_session_${process.pid}.log`), 'alive\n');

  const stateFile = path.join(sessionDir, 'state.json');
  const state = {
    active: true,
    working_dir: process.cwd(),
    step: 'research',
    iteration: 1,
    max_iterations: 200,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'budget simulation',
    current_ticket: 'T1',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    activity: [],
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return { tmpDir, stateFile, state };
}

function withExtensionDir(tmpDir, fn) {
  const previous = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = tmpDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = previous;
  }
}

test('forensic replay: 60min simulated worker wait keeps manager turn count <= 80', () => {
  const fixture = makeFixture();
  try {
    const approvals = withExtensionDir(fixture.tmpDir, () => {
      let approvedTurns = 0;
      for (let nowMs = 0; nowMs <= 60 * 60 * 1000; nowMs += 2_000) {
        const result = evaluateManagerIdleBackoff(
          fixture.state,
          fixture.stateFile,
          'Waiting for Monitor signal.',
          '',
          () => {},
          nowMs,
        );
        if (result?.decision === 'approve') approvedTurns += 1;
      }
      return approvedTurns;
    });

    assert.ok(approvals <= 80, `expected <= 80 synthetic nudges, saw ${approvals}`);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});
