// @tier: fast
// AC-B4: non-blocking readiness false-positive counter on the /pickle-metrics dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractReadinessFalsePositive,
  scanReadinessFalsePositiveEvents,
  buildReadinessFalsePositiveReport,
  READINESS_FALSE_POSITIVE_EVENT_NAME,
} from '../services/metrics-utils.js';

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'metrics.js');

function mkActivityDir(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfp-act-'));
  fs.writeFileSync(path.join(dir, '2026-06-14.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

test('event name constant matches the registered activity event', () => {
  assert.equal(READINESS_FALSE_POSITIVE_EVENT_NAME, 'readiness_false_positive_suppressed');
});

test('extractReadinessFalsePositive normalizes a well-formed event', () => {
  const ev = extractReadinessFalsePositive({
    event: 'readiness_false_positive_suppressed',
    ts: '2026-06-14T10:00:00.000Z',
    session: 's1',
    gate_payload: { suppressed_count: 3, suppressed: ['a', 'b', 'c'] },
  });
  assert.deepEqual(ev, { session: 's1', suppressed_count: 3 });
});

test('extractReadinessFalsePositive returns null for non-matching events', () => {
  assert.equal(extractReadinessFalsePositive({ event: 'readiness_skipped' }), null);
  assert.equal(extractReadinessFalsePositive(null), null);
  assert.equal(extractReadinessFalsePositive('nope'), null);
});

test('buildReadinessFalsePositiveReport aggregates events into a count', () => {
  const events = [
    { session: 's1', suppressed_count: 2 },
    { session: 's2', suppressed_count: 3 },
    { session: 's1', suppressed_count: 1 },
  ];
  const report = buildReadinessFalsePositiveReport(events, '2026-06-01', '2026-06-14');
  assert.equal(report.total_events, 3);
  assert.equal(report.total_suppressed, 6);
  assert.equal(report.since, '2026-06-01');
  assert.equal(report.until, '2026-06-14');
});

test('buildReadinessFalsePositiveReport on zero events is a clean empty counter (non-blocking)', () => {
  const report = buildReadinessFalsePositiveReport([], '2026-06-01', '2026-06-14');
  assert.equal(report.total_events, 0);
  assert.equal(report.total_suppressed, 0);
});

test('scanReadinessFalsePositiveEvents date-windows and filters by event name', () => {
  const dir = mkActivityDir([
    { event: 'readiness_false_positive_suppressed', ts: '2026-06-14T10:00:00.000Z', session: 's1', gate_payload: { suppressed_count: 2 } },
    { event: 'readiness_false_positive_suppressed', ts: '2026-06-14T11:00:00.000Z', session: 's2', gate_payload: { suppressed_count: 5 } },
    { event: 'readiness_skipped', ts: '2026-06-14T12:00:00.000Z', session: 's3', gate_payload: { reason: 'x' } },
    { event: 'readiness_false_positive_suppressed', ts: '2026-06-20T10:00:00.000Z', session: 's4', gate_payload: { suppressed_count: 9 } },
  ]);
  try {
    const events = scanReadinessFalsePositiveEvents(dir, '2026-06-14', '2026-06-14');
    const report = buildReadinessFalsePositiveReport(events, '2026-06-14', '2026-06-14');
    assert.equal(report.total_events, 2);
    assert.equal(report.total_suppressed, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the counter path is NON-BLOCKING: metrics CLI exits 0 even with suppression events', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rfp-data-'));
  const activityDir = path.join(dataRoot, 'activity');
  fs.mkdirSync(activityDir, { recursive: true });
  fs.writeFileSync(
    path.join(activityDir, '2026-06-14.jsonl'),
    JSON.stringify({ event: 'readiness_false_positive_suppressed', ts: '2026-06-14T10:00:00.000Z', session: 's1', gate_payload: { suppressed_count: 4 } }) + '\n',
  );
  try {
    const res = spawnSync(process.execPath, [CLI_PATH, '--since', '2026-06-14'], {
      env: { ...process.env, PICKLE_DATA_ROOT: dataRoot, CLAUDE_PROJECTS_DIR: path.join(dataRoot, 'noproj'), METRICS_REPO_ROOT: path.join(dataRoot, 'norepo') },
      encoding: 'utf-8',
      timeout: 30000,
    });
    assert.equal(res.status, 0, `metrics CLI must exit 0 (non-blocking). stderr: ${res.stderr}`);
    assert.match(res.stdout, /Readiness false positives/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
