// @tier: integration
// R-PIWG-1 — HEAD-pin mismatch detection at session bootstrap and per-iteration re-check.
// Verifies: (1) setup.js captures pinned_branch + pinned_sha; (2) external git checkout
// triggers abort + head_mismatch_detected event; (3) pipeline-internal commits on same
// branch do NOT trigger; (4) pipeline-runner surfaces mismatch to stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_BIN = path.resolve(__dirname, '../../bin/setup.js');

import { checkHeadPinMismatch } from '../../bin/mux-runner.js';
import { logPhaseHaltReason } from '../../bin/pipeline-runner.js';

function makeTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function writeStateJson(statePath, overrides = {}) {
  const state = {
    active: true,
    schema_version: 3,
    working_dir: path.dirname(statePath),
    iteration: 0,
    max_iterations: 15,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    activity: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: false,
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Scenario 1 (AC-PIWG-1.a): setup.js bootstrap captures pinned_branch and pinned_sha
test('head-pin-mismatch: bootstrap captures pinned_branch and pinned_sha (AC-PIWG-1.a)', () => {
  const repoDir = makeTmpDir('head-pin-sc1-repo-');
  const dataDir = makeTmpDir('head-pin-sc1-data-');
  try {
    makeGitRepo(repoDir);

    const output = execFileSync(process.execPath, [SETUP_BIN, '--tmux', 'head-pin test prompt'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataDir },
    });

    const match = output.match(/SESSION_ROOT=(.+)/);
    assert.ok(match, `SESSION_ROOT not found in setup output:\n${output}`);
    const sessionRoot = match[1].trim();
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));

    assert.ok(
      typeof state.pinned_branch === 'string' || state.pinned_branch === null,
      `pinned_branch must be string or null, got ${JSON.stringify(state.pinned_branch)}`,
    );
    assert.equal(state.pinned_branch, 'main', 'Expected pinned_branch to be "main"');
    assert.ok(
      typeof state.pinned_sha === 'string' && state.pinned_sha.length > 0,
      `pinned_sha must be non-empty string, got ${JSON.stringify(state.pinned_sha)}`,
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Scenario 2 (AC-PIWG-1.b + AC-PIWG-1.c + AC-PIWG-1.e): external git checkout triggers abort + event
test('head-pin-mismatch: external checkout triggers abort and head_mismatch_detected event (AC-PIWG-1.b/c/e)', () => {
  const repoDir = makeTmpDir('head-pin-sc2-repo-');
  const sessionDir = makeTmpDir('head-pin-sc2-sess-');
  try {
    const initialSha = makeGitRepo(repoDir);
    const statePath = path.join(sessionDir, 'state.json');
    writeStateJson(statePath, {
      working_dir: repoDir,
      pinned_branch: 'main',
      pinned_sha: initialSha,
    });

    // Simulate external git checkout of a different branch
    execFileSync('git', ['checkout', '-b', 'feature/external'], { cwd: repoDir, stdio: 'pipe' });

    const logLines = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const result = checkHeadPinMismatch(state, repoDir, sessionDir, statePath, msg => logLines.push(msg));

    assert.equal(result, true, 'checkHeadPinMismatch should return true on external branch switch');

    // AC-PIWG-1.b: exit_reason set to working_tree_modified_externally
    const updated = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(
      updated.exit_reason,
      'working_tree_modified_externally',
      'exit_reason should be working_tree_modified_externally',
    );

    // AC-PIWG-1.c: head_mismatch_detected activity event with required payload fields
    const events = updated.activity ?? [];
    const evt = events.find(e => e.event === 'head_mismatch_detected');
    assert.ok(evt, `head_mismatch_detected event not found in state.activity: ${JSON.stringify(events)}`);
    assert.equal(evt.gate_payload.pinned_branch, 'main');
    assert.equal(evt.gate_payload.observed_branch, 'feature/external');
    assert.ok(evt.gate_payload.pinned_sha?.length > 0, 'pinned_sha must be non-empty');
    assert.ok(evt.gate_payload.observed_sha?.length > 0, 'observed_sha must be non-empty');
    assert.ok(typeof evt.gate_payload.detected_at_phase === 'string', 'detected_at_phase must be string');

    // AC-PIWG-1.e: log output contains pinned and observed branch values
    const logStr = logLines.join('\n');
    assert.ok(logStr.includes('pinned_branch=main'), `Expected "pinned_branch=main" in log: ${logStr}`);
    assert.ok(
      logStr.includes('observed_branch=feature/external'),
      `Expected "observed_branch=feature/external" in log: ${logStr}`,
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Scenario 3 (AC-PIWG-1.d): pipeline-internal commit on same branch does NOT trigger mismatch
test('head-pin-mismatch: pipeline-internal commit on same branch does not trigger (AC-PIWG-1.d)', () => {
  const repoDir = makeTmpDir('head-pin-sc3-repo-');
  const sessionDir = makeTmpDir('head-pin-sc3-sess-');
  try {
    const initialSha = makeGitRepo(repoDir);
    const statePath = path.join(sessionDir, 'state.json');
    writeStateJson(statePath, {
      working_dir: repoDir,
      pinned_branch: 'main',
      pinned_sha: initialSha,
    });

    // Simulate pipeline-internal commit (same branch, SHA advances)
    fs.writeFileSync(path.join(repoDir, 'work.txt'), 'pipeline work\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'pipeline commit', '--no-gpg-sign'], { cwd: repoDir, stdio: 'pipe' });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const result = checkHeadPinMismatch(state, repoDir, sessionDir, statePath, () => {});

    // Branch is still 'main' — no mismatch should be detected
    assert.equal(result, false, 'checkHeadPinMismatch should NOT trigger for pipeline-internal commits on same branch');

    const updated = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok(
      !updated.exit_reason || updated.exit_reason !== 'working_tree_modified_externally',
      'exit_reason should NOT be working_tree_modified_externally',
    );
    const events = updated.activity ?? [];
    assert.ok(
      !events.find(e => e.event === 'head_mismatch_detected'),
      'head_mismatch_detected should NOT be emitted for same-branch commits',
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Scenario 4 (AC-PIWG-1.e): pipeline-runner's logPhaseHaltReason surfaces mismatch to stderr
test('head-pin-mismatch: pipeline-runner stderr contains pinned and observed branch (AC-PIWG-1.e)', () => {
  const sessionDir = makeTmpDir('head-pin-sc4-sess-');
  try {
    const statePath = path.join(sessionDir, 'state.json');
    writeStateJson(statePath, {
      active: false,
      exit_reason: 'working_tree_modified_externally',
      pinned_branch: 'main',
      pinned_sha: 'abc1234abc1234',
      head_pin_mismatch_detail: {
        pinned_branch: 'main',
        observed_branch: 'feature/external',
        pinned_sha: 'abc1234abc1234',
        observed_sha: 'def5678def5678',
      },
    });

    // Capture process.stderr writes during logPhaseHaltReason call
    const stderrCapture = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return origWrite(chunk, ...args);
    };

    let outcome;
    try {
      outcome = logPhaseHaltReason({ statePath }, 'pickle', 1, () => {});
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(outcome, 'abort', 'logPhaseHaltReason should return "abort" on HEAD mismatch');

    const stderrOutput = stderrCapture.join('');
    assert.ok(
      stderrOutput.includes('pinned_branch=main'),
      `Expected "pinned_branch=main" in stderr: ${stderrOutput}`,
    );
    assert.ok(
      stderrOutput.includes('observed_branch=feature/external'),
      `Expected "observed_branch=feature/external" in stderr: ${stderrOutput}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
