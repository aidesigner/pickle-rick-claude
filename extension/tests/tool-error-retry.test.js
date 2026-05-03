// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../hooks/handlers/tool-error.js');

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function baseState(sessionDir) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: '37c8648b',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
  };
}

function makeHarness() {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-error-')));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState(sessionDir)));
  fs.writeFileSync(path.join(tmpDir, 'current_sessions.json'), JSON.stringify({ [process.cwd()]: sessionDir }));
  return { tmpDir, sessionDir, stateFile, errorFile: path.join(sessionDir, 'last-tool-error.json') };
}

function runHandler(harness, payload) {
  const env = {
    ...process.env,
    EXTENSION_DIR: harness.tmpDir,
    PICKLE_STATE_FILE: harness.stateFile,
    FORCE_COLOR: '0',
  };
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input: JSON.stringify({
      session_id: 'session',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'tool-1',
      cwd: process.cwd(),
      ...payload,
    }),
    encoding: 'utf-8',
    env,
  });
  return JSON.parse(stdout.trim());
}

function readErrorState(harness) {
  return JSON.parse(fs.readFileSync(harness.errorFile, 'utf8'));
}

test('tool-error.first-failure writes count=1 and required schema fields', () => {
  const harness = makeHarness();
  try {
    const result = runHandler(harness, { error: 'Command failed at /tmp/project/src/app.ts:12:4' });
    assert.equal(result.decision, 'approve');

    const state = readErrorState(harness);
    assert.equal(typeof state.ts, 'string');
    assert.equal(state.tool, 'Bash');
    assert.equal(state.error_signature, 'Command failed at <PATH>:<N>:<N>');
    assert.equal(state.retry_count, 1);
    assert.deepEqual(Object.keys(state).sort(), ['error_signature', 'retry_count', 'tool', 'ts']);
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('tool-error.increment increments retry_count for the same tool and signature', () => {
  const harness = makeHarness();
  try {
    runHandler(harness, { error: 'Command exited with code 1 in /tmp/a/file.ts:10:2' });
    runHandler(harness, { error: 'Command exited with code 1 in /Users/person/project/file.ts:55:9' });

    const state = readErrorState(harness);
    assert.equal(state.tool, 'Bash');
    assert.equal(state.retry_count, 2);
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('tool-error.reset resets retry_count when the signature changes', () => {
  const harness = makeHarness();
  try {
    runHandler(harness, { error: 'Command exited with code 1' });
    runHandler(harness, { error: 'Command exited with code 2' });

    const state = readErrorState(harness);
    assert.equal(state.error_signature, 'Command exited with code 2');
    assert.equal(state.retry_count, 1);
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});
