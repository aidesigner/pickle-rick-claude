import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPLAY_BIN = path.resolve(import.meta.dirname, '../bin/replay-bundle-iter-stats.js');

test('replay-stats.baseline: two-session input writes per-session and per-runner totals', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-replay-stats-'));
  const activityDir = path.join(tmpRoot, 'activity');
  const output = path.join(tmpRoot, 'bundle', 'wasted-iter-baseline.json');
  fs.mkdirSync(activityDir, { recursive: true });
  fs.writeFileSync(path.join(activityDir, '2026-05-03.jsonl'), [
    JSON.stringify({ event: 'wasted_iter', source: 'pickle', session: 's1', runner: 'microverse', wasted: true }),
    JSON.stringify({ event: 'wasted_iter', source: 'pickle', session: 's1', runner: 'microverse', wasted: false }),
    JSON.stringify({ event: 'wasted_iter', source: 'pickle', session: 's2', runner: 'mux', wasted: true }),
    JSON.stringify({ event: 'iteration_end', source: 'pickle', session: 's2', runner: 'mux', wasted: true }),
    '',
  ].join('\n'));

  try {
    const result = spawnSync(process.execPath, [REPLAY_BIN, '--activity-dir', activityDir, '--output', output], {
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(output), true);

    const baseline = JSON.parse(fs.readFileSync(output, 'utf-8'));
    assert.deepEqual(baseline.totals, { iterations: 3, wasted: 2 });
    assert.deepEqual(baseline.per_session.s1, { iterations: 2, wasted: 1 });
    assert.deepEqual(baseline.per_session.s2, { iterations: 1, wasted: 1 });
    assert.deepEqual(baseline.per_runner.microverse, { iterations: 2, wasted: 1 });
    assert.deepEqual(baseline.per_runner.mux, { iterations: 1, wasted: 1 });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
