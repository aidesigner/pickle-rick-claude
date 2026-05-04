// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyDecision } from '../hooks/handlers/stop-hook.js';
import { StateManager } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'stop-hook-states.json'), 'utf-8'),
);

// Spawn a process that exits immediately to get a reliably dead PID.
const _deadPidResult = spawnSync(process.execPath, ['--eval', ''], { timeout: 5_000 });
const DEAD_PID = _deadPidResult.pid;
const ALIVE_PID = process.pid;

const MAX_ITER = 10;
const STALE_OFFSET_SECONDS = 6 * 60; // 6 min — past the 5-min orphan-demotion threshold

function buildState({ pid, active, iteration }) {
  return {
    schema_version: 3,
    active,
    working_dir: process.cwd(),
    step: 'research',
    iteration,
    max_iterations: MAX_ITER,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'matrix test',
    current_ticket: null,
    history: [],
    started_at: new Date(Date.now() - 30_000).toISOString(),
    session_dir: os.tmpdir(),
    tmux_mode: false,
    pid,
    activity: [],
    backend: 'claude',
    teams_mode: false,
    consecutive_short_responses: 0,
    false_epic_completed_count: 0,
  };
}

const sm = new StateManager();

function runCell({ pidLabel, active, mtime, iteration }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-'));
  try {
    const stateFile = path.join(tmpDir, 'state.json');
    const pid =
      pidLabel === 'null' ? null : pidLabel === 'alive' ? ALIVE_PID : DEAD_PID;

    fs.writeFileSync(stateFile, JSON.stringify(buildState({ pid, active, iteration })));

    if (mtime === 'stale') {
      const staleTimeSec = Date.now() / 1000 - STALE_OFFSET_SECONDS;
      fs.utimesSync(stateFile, staleTimeSec, staleTimeSec);
    }

    // StateManager.read() runs full recovery: orphan-paused demotion (pid=null + stale)
    // and dead-pid demotion. Mirrors what the stop-hook binary does before classifyDecision.
    const recovered = sm.read(stateFile);

    // Mirror approveEarlyIfNeeded: inactive state always approves before reaching classifyDecision.
    if (recovered.active !== true) return 'approve';

    return classifyDecision(recovered, '', '').decision;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 60-cell parametrized matrix
// ---------------------------------------------------------------------------

for (const [key, oracle] of Object.entries(FIXTURES)) {
  const [pidLabel, activeLabel, mtimeLabel, iterLabel] = key.split(':');
  const active = activeLabel === 'true';
  const iteration = parseInt(iterLabel, 10);

  test(key, () => {
    const got = runCell({ pidLabel, active, mtime: mtimeLabel, iteration });
    assert.equal(
      got,
      oracle.expected,
      `(pid=${pidLabel}, active=${activeLabel}, mtime=${mtimeLabel}, iteration=${iterLabel}) expected=${oracle.expected} got=${got}`,
    );
  });
}

// ---------------------------------------------------------------------------
// xfail placeholder — ab62807f already landed so all 60 live cells pass.
// Remove this todo when Section D axes are defined.
// ---------------------------------------------------------------------------

test('stop-hook state matrix: Section D expansion cells (xfail placeholder)', (t) => {
  t.todo('Section D cells not yet defined; extend matrix when new state axes are added');
});
