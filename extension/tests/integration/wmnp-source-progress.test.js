// @tier: integration
//
// AC-R-WMNP-1: the per-spawn no-progress signal must count working-tree SOURCE
// deltas (git status/diff signature change vs the prior spawn), OR'd with the
// existing artifact-count signal. A worker that lands real source work each spawn
// but writes zero new lifecycle artifacts MUST NOT accrue zero_progress_count and
// MUST NOT be auto-skipped. The inverse (no source change + no artifact change)
// MUST still accrue zero-progress and fire at K. Throwaway temp fixtures only —
// never the live orchestration state.json.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function makeV5RawState(dir) {
  return {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'AC-R-WMNP-1 source-progress test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
    activity: [],
  };
}

function setupSession(prefix) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir), null, 2));
  return { sessionDir, statePath };
}

function readProgress(statePath, ticketId) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return s.worker_artifact_progress?.[ticketId] ?? null;
}

function countEmissions(statePath) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === 'worker_artifact_progress_zero');
}

// A scripted worker that produces a NEW source signature on every spawn (it landed
// real working-tree work each time) while writing ZERO new artifact files.
function makeChangingSig() {
  let n = 0;
  return () => `source-state-${n++}`;
}

test('AC-R-WMNP-1: changing source signature each spawn never accrues zero-progress (no auto-skip)', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-source-progress-');
  const ticketId = 'src01';
  const changingSig = makeChangingSig();
  try {
    // 5 consecutive spawns: zero artifact growth (beforeCount = afterCount = 0)
    // but the source signature changes every spawn. K=3 / skip-K=5 must never trip.
    let r;
    for (let i = 0; i < 5; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: changingSig,
      });
    }
    // Spawn 1 establishes the baseline (no prior signature → counts as one
    // zero-progress); every subsequent spawn changes the signature → resets to 0.
    assert.equal(r.zeroProgressCount, 0, 'ongoing source work keeps zero_progress_count at 0');
    assert.equal(countEmissions(statePath).length, 0, 'no worker_artifact_progress_zero emission while source advances');
    const persisted = readProgress(statePath, ticketId);
    assert.equal(persisted.spawn_count, 5, 'all 5 spawns counted');
    assert.equal(persisted.last_source_signature, 'source-state-4', 'freshest signature persisted');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1 inverse: identical source signature + no artifacts accrues zero-progress and fires at K', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-stuck-');
  const ticketId = 'stuck01';
  try {
    let r;
    for (let i = 0; i < 3; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: () => 'frozen-tree', // never changes → genuinely stuck
      });
    }
    assert.equal(r.zeroProgressCount, 3, 'frozen source + no artifacts accrues zero-progress');
    assert.ok(r.fired, 'fires at exactly K=3');
    assert.equal(countEmissions(statePath).length, 1, 'exactly one emission at the threshold');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1: null signature (git unavailable) falls back to artifact-count signal, never a false reset', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-nullsig-');
  const ticketId = 'nullsig01';
  try {
    let r;
    for (let i = 0; i < 3; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: () => null, // probe failed every spawn
      });
    }
    // With no usable signature, behavior must match the legacy artifact-only path:
    // zero artifact growth accrues zero-progress and still fires at K.
    assert.equal(r.zeroProgressCount, 3, 'null signature does not mask a genuinely stuck worker');
    assert.ok(r.fired, 'still fires at K under null-signature fallback');
    const persisted = readProgress(statePath, ticketId);
    assert.equal(persisted.last_source_signature, undefined, 'no signature persisted when every probe returned null');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1: computeSourceTreeSignature detects a real working-tree delta', async () => {
  const { computeSourceTreeSignature } = await import('../../bin/mux-runner.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-realgit-'));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 10_000 });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    const sigClean = computeSourceTreeSignature(repo);
    assert.equal(typeof sigClean, 'string', 'returns a string signature for a real repo');

    // Land new source work — an untracked file the status probe must observe.
    fs.writeFileSync(path.join(repo, 'analyzer.ts'), 'export const x = 1;\n');
    const sigAfterNew = computeSourceTreeSignature(repo);
    assert.notEqual(sigAfterNew, sigClean, 'new source file changes the signature');

    // Grow a tracked file — the numstat probe must observe the churn.
    fs.appendFileSync(path.join(repo, 'seed.txt'), 'more\n');
    const sigAfterGrow = computeSourceTreeSignature(repo);
    assert.notEqual(sigAfterGrow, sigAfterNew, 'growing a tracked file changes the signature');

    assert.equal(computeSourceTreeSignature(path.join(repo, 'nope')), null, 'non-repo dir → null (artifact-count fallback)');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
