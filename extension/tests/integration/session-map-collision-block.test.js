// @tier: integration
/**
 * R-CCPM-4: session-map cwd-collision protection in updateSessionMap.
 *
 * Tests that updateSessionMap refuses to overwrite a live parent's map entry
 * (alive PID + different sessionPath) and emits session_map_collision_blocked.
 * Covers: new-session path, resume path, dead-PID no-block, legacy string shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SETUP_JS = path.join(ROOT, 'bin/setup.js');

function readCollisionEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .flatMap((f) =>
      fs.readFileSync(path.join(activityDir, f), 'utf-8')
        .trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((e) => e.event === 'session_map_collision_blocked');
}

// R-PNTR-4: a new build session must run under tmux; default these collision
// tests onto --tmux unless they already select a mode (--tmux/--paused/--resume).
function withTmuxDefault(args) {
  const hasMode = args.some((a) => a === '--tmux' || a === '--paused' || a === '--resume');
  return hasMode ? args : ['--tmux', ...args];
}

function spawnSetup(args, env, cwd) {
  return spawnSync(process.execPath, [SETUP_JS, ...withTmuxDefault(args)], {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, FORCE_COLOR: '0', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function makeMinimalState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'prd',
    iteration: 0,
    max_iterations: 50,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'collision test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    min_iterations: 0,
    command_template: null,
    chain_meeseeks: false,
    schema_version: 4,
    backend: 'claude',
    worker_backend: null,
    pipeline_continue_on_phase_fail: true,
    teams_mode: false,
    max_parallel: undefined,
    archaeology: null,
    tickets_version: 0,
    last_course_correction: null,
    phase_personas_active: false,
    flags: {},
    readiness: { cycle_history: [] },
    codex_version_seen: null,
    orphans_detected: [],
    invocation_source: 'operator',
    parent_session_hash: null,
  };
}

// ── new-session path collision ───────────────────────────────────────────────

test('session-map-collision-block: alive PID blocks orphan new-session setup.js', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-new-'));
  const sessionsDir = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const parentSessionPath = path.join(sessionsDir, 'parent-session');
    const cwd = process.cwd();

    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [cwd]: { sessionPath: parentSessionPath, pid: process.pid } }),
    );

    const result = spawnSetup(['--task', 'orphan new-session collision test'], { PICKLE_DATA_ROOT: dataRoot });

    assert.notEqual(
      result.status, 0,
      `orphan setup.js must exit non-zero on collision; got ${result.status}\nstderr: ${result.stderr}`,
    );

    // Parent's map entry must be intact.
    const map = JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
    assert.equal(map[cwd].sessionPath, parentSessionPath, 'parent sessionPath must be preserved');
    assert.equal(map[cwd].pid, process.pid, 'parent pid must be preserved');

    // Exactly one collision event with correct payload.
    const events = readCollisionEvents(dataRoot);
    assert.equal(events.length, 1, `expected 1 collision event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.cwd, cwd, 'event cwd must match');
    assert.equal(ev.existing_session_path, parentSessionPath, 'event existing_session_path must match parent');
    assert.equal(ev.existing_pid, process.pid, 'event existing_pid must match parent pid');
    assert.ok(
      typeof ev.attempted_pid === 'number' && ev.attempted_pid > 0,
      'event attempted_pid must be a positive integer',
    );
    assert.ok(
      ev.attempted_session_path !== parentSessionPath,
      'event attempted_session_path must differ from parent',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── resume path collision ────────────────────────────────────────────────────

test('session-map-collision-block: alive PID blocks orphan resume-path setup.js', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-resume-'));
  const sessionsDir = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const cwd = process.cwd();
    // session-A is the "parent" whose entry is in the map (alive PID).
    const sessionA = path.join(sessionsDir, 'session-a');
    fs.mkdirSync(sessionA, { recursive: true });
    // session-B has a valid state.json — we'll try to resume it while A owns the map.
    const sessionB = path.join(sessionsDir, 'session-b');
    fs.mkdirSync(sessionB, { recursive: true });
    fs.writeFileSync(
      path.join(sessionB, 'state.json'),
      JSON.stringify(makeMinimalState(sessionB, cwd)),
    );

    // Map: cwd → session-A with alive PID (current test process).
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [cwd]: { sessionPath: sessionA, pid: process.pid } }),
    );

    const result = spawnSetup(['--resume', sessionB], { PICKLE_DATA_ROOT: dataRoot });

    assert.notEqual(
      result.status, 0,
      `resume-path must exit non-zero on collision; got ${result.status}\nstderr: ${result.stderr}`,
    );

    // Map entry for cwd must still point to session-A.
    const map = JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
    assert.equal(map[cwd].sessionPath, sessionA, 'parent sessionPath must be preserved after resume collision');

    // Exactly one collision event.
    const events = readCollisionEvents(dataRoot);
    assert.equal(events.length, 1, `expected 1 collision event on resume path, got ${events.length}`);
    assert.equal(events[0].existing_session_path, sessionA);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── dead PID — no false positive ─────────────────────────────────────────────

test('session-map-collision-block: dead PID allows overwrite — no false positive', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-dead-'));
  const sessionsDir = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const cwd = process.cwd();
    const oldSessionPath = path.join(sessionsDir, 'old-session');

    // Write a map entry with a dead PID (99999999 is reliably absent).
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [cwd]: { sessionPath: oldSessionPath, pid: 99999999 } }),
    );

    const result = spawnSetup(['--task', 'dead pid allows overwrite'], { PICKLE_DATA_ROOT: dataRoot });

    assert.equal(result.status, 0, `setup.js must succeed with dead PID; stderr: ${result.stderr}`);

    // Map entry should be updated (no longer points to old session).
    const map = JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
    assert.ok(map[cwd], 'map must have a cwd entry');
    assert.notEqual(map[cwd].sessionPath, oldSessionPath, 'map must be updated with new session, not old one');

    // No collision event emitted.
    const events = readCollisionEvents(dataRoot);
    assert.equal(events.length, 0, `no collision event expected for dead PID, got ${events.length}`);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── legacy string-shape entry ────────────────────────────────────────────────

test('session-map-collision-block: legacy string-shape entry is not blocked (readMappedPid returns null)', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-str-'));
  const sessionsDir = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const cwd = process.cwd();
    const oldStringPath = path.join(sessionsDir, 'legacy-string-session');

    // Write a map entry in the OLD string-value format (legacy shape — no pid field).
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [cwd]: oldStringPath }),
    );

    const result = spawnSetup(['--task', 'legacy string shape test'], { PICKLE_DATA_ROOT: dataRoot });

    assert.equal(result.status, 0, `setup.js must succeed with legacy string entry; stderr: ${result.stderr}`);

    // No collision event should be emitted for a string entry (readMappedPid returns null).
    const events = readCollisionEvents(dataRoot);
    assert.equal(events.length, 0, `no collision event expected for string-shape entry, got ${events.length}`);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
