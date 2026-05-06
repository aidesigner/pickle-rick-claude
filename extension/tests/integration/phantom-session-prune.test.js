// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveStateFile } from '../../hooks/resolve-state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-prune-'));
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .flatMap((file) => fs.readFileSync(path.join(activityDir, file), 'utf-8').trim().split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

test('phantom map prune: resolveStateFile prunes missing session dir and emits phantom_session_demoted', () => {
  const dataRoot = tmpDir();
  const originalDataRoot = process.env.PICKLE_DATA_ROOT;
  const originalStateFile = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    delete process.env.PICKLE_STATE_FILE;
    const liveSessionDir = path.join(dataRoot, 'sessions', 'live-session');
    fs.mkdirSync(liveSessionDir, { recursive: true });
    const liveStateFile = path.join(liveSessionDir, 'state.json');
    fs.writeFileSync(liveStateFile, JSON.stringify({
      active: true,
      working_dir: process.cwd(),
      step: 'implement',
      iteration: 2,
      max_iterations: 5,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000) - 30,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: liveSessionDir,
    }));
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({
        [process.cwd()]: {
          sessionPath: path.join(dataRoot, 'sessions', 'missing-session'),
          pid: 99999999,
        },
      }),
    );

    const resolved = resolveStateFile(dataRoot);

    assert.equal(resolved, liveStateFile);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8')),
      {},
    );
    const phantomEvent = readActivityEvents(dataRoot).find((event) => event.event === 'phantom_session_demoted');
    assert.ok(phantomEvent, 'expected phantom_session_demoted activity event');
    assert.equal(phantomEvent.exit_reason, 'orphan-session-dir-missing');
  } finally {
    if (originalDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = originalDataRoot;
    if (originalStateFile === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = originalStateFile;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
