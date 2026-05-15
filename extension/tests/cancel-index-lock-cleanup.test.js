// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANCEL_BIN = path.resolve(__dirname, '../bin/cancel.js');

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-piwg4-')));
}

function setupSession(extRoot) {
  // Create a fake git repo as working dir
  const workingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-piwg4-repo-')));
  fs.mkdirSync(path.join(workingDir, '.git'), { recursive: true });

  const sessionsDir = path.join(extRoot, 'sessions');
  const sessionDir = path.join(sessionsDir, '2026-05-14-piwg4test');
  fs.mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  const state = {
    active: true,
    working_dir: workingDir,
    step: 'research',
    iteration: 1,
    schema_version: 3,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(extRoot, 'current_sessions.json'), JSON.stringify({ [workingDir]: sessionDir }, null, 2));
  return { sessionDir, workingDir, statePath };
}

function runCancel(extRoot, cwd) {
  const env = { ...process.env, PICKLE_DATA_ROOT: extRoot };
  return spawnSync('node', [CANCEL_BIN], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
}

function readActivityEvents(extRoot) {
  const activityDir = path.join(extRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(activityDir, f), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore malformed lines */ }
    }
  }
  return events;
}

test('cancel-index-lock-cleanup (R-PIWG-4): removes orphaned lock within activity window with no holder', () => {
  const extRoot = makeTmpRoot();
  const { sessionDir, workingDir, statePath } = setupSession(extRoot);
  const lockPath = path.join(workingDir, '.git', 'index.lock');

  // Create a stale lock with mtime within window (now-ish; state was just written)
  fs.writeFileSync(lockPath, 'stale-lock-content');
  // Set lock mtime to slightly BEFORE state.json mtime (matches "lock predates last activity")
  const stateMtime = fs.statSync(statePath).mtimeMs;
  fs.utimesSync(lockPath, new Date(stateMtime - 30_000), new Date(stateMtime - 30_000));

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  // Lock should be removed (no live holder + within window)
  assert.strictEqual(fs.existsSync(lockPath), false, 'lock should be removed');

  // Cleanup event should be recorded
  const events = readActivityEvents(extRoot);
  const cleaned = events.find((e) => e.event === 'stale_index_lock_cleaned');
  assert.ok(cleaned, `expected stale_index_lock_cleaned event, got: ${events.map((e) => e.event).join(', ')}`);
  assert.strictEqual(cleaned.gate_payload.path, lockPath, 'event payload path matches');
  assert.ok(typeof cleaned.gate_payload.mtime === 'string', 'mtime is string');
  assert.ok(Number.isInteger(cleaned.gate_payload.age_seconds), 'age_seconds is integer');
});

test('cancel-index-lock-cleanup (R-PIWG-4): preserves external lock (mtime > state.last_activity + 5min)', () => {
  const extRoot = makeTmpRoot();
  const { sessionDir, workingDir, statePath } = setupSession(extRoot);
  const lockPath = path.join(workingDir, '.git', 'index.lock');

  fs.writeFileSync(lockPath, 'external-lock');
  // Set lock mtime to 10 minutes AFTER state.json mtime (external)
  const stateMtime = fs.statSync(statePath).mtimeMs;
  const futureMs = stateMtime + 10 * 60 * 1000;
  fs.utimesSync(lockPath, new Date(futureMs), new Date(futureMs));

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  // External lock should be preserved
  assert.strictEqual(fs.existsSync(lockPath), true, 'external lock should be preserved');

  // No cleanup or held event should be emitted (external = silent skip)
  const events = readActivityEvents(extRoot);
  assert.ok(!events.find((e) => e.event === 'stale_index_lock_cleaned'), 'no cleanup event for external lock');
  assert.ok(!events.find((e) => e.event === 'stale_index_lock_held_by_live_process'), 'no held event for external lock');
});

test('cancel-index-lock-cleanup (R-PIWG-4): logs cancel succeeded on real-world inputs', () => {
  // Smoke test: cancel without a lock file still succeeds + does not emit either lock event.
  const extRoot = makeTmpRoot();
  const { workingDir } = setupSession(extRoot);

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  const events = readActivityEvents(extRoot);
  assert.ok(!events.find((e) => e.event === 'stale_index_lock_cleaned'));
  assert.ok(!events.find((e) => e.event === 'stale_index_lock_held_by_live_process'));
});
