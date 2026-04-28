// Tests for the IterationOutcome shape returned by runIteration (ticket ff3a5ae3).
// Covers: shape contract, timing fields on the inactive early-return path, and
// the documented completion-value union. The hang-guard and spawn-error resolve
// paths require a live `claude` subprocess and are covered by integration runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFileSync } from 'node:child_process';

import { runIteration, commitPendingProbe, COMMIT_PENDING_HANDOFF_TEXT } from '../bin/mux-runner.js';

function makeInactiveSession() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-')));
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: false, step: 'implement', iteration: 0 }));
    return dir;
}

test('IterationOutcome: inactive early-return produces all four fields', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.ok('completion' in outcome, 'missing completion field');
        assert.ok('timedOut' in outcome, 'missing timedOut field');
        assert.ok('exitCode' in outcome, 'missing exitCode field');
        assert.ok('wallSeconds' in outcome, 'missing wallSeconds field');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: inactive path sets timedOut=false, exitCode=null, wallSeconds=0', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(outcome.completion, 'inactive');
        assert.equal(outcome.timedOut, false);
        assert.equal(outcome.exitCode, null);
        assert.equal(outcome.wallSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: wallSeconds is a finite non-negative number (never NaN)', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(typeof outcome.wallSeconds, 'number');
        assert.ok(Number.isFinite(outcome.wallSeconds), 'wallSeconds must be finite');
        assert.ok(outcome.wallSeconds >= 0, 'wallSeconds must be non-negative');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: completion value is from the documented string union', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        const allowed = new Set(['task_completed', 'review_clean', 'continue', 'error', 'inactive']);
        assert.ok(allowed.has(outcome.completion), `unexpected completion: ${outcome.completion}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: inactive path never populates exitCode with a number', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        // exitCode is null until proc.on('close') provides a code; the
        // inactive early-return predates the spawn, so it must be null.
        assert.equal(outcome.exitCode, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: missing state.json throws a descriptive error (not an outcome)', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-miss-')));
  try {
    await assert.rejects(
      runIteration(dir, 1, dir, ''),
      /Failed to read state.json/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IterationOutcome: runIteration honors a higher-iteration inactive orphan tmp state', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-orphan-')));
    try {
        const statePath = path.join(dir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            command_template: '../stale-template.md',
        }));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
            active: false,
            step: 'review',
            iteration: 3,
        }));

        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(outcome.completion, 'inactive');
        assert.equal(outcome.timedOut, false);
        assert.equal(outcome.exitCode, null);
        assert.equal(outcome.wallSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// commit-pending health probe: codex-only nudge when the worker has uncommitted
// edits and the iteration counter has stagnated past the threshold. Happy path:
// trigger conditions met → handoff.txt is written with the documented nudge.
// ---------------------------------------------------------------------------

function initGitRepo(repoDir) {
    const opts = { cwd: repoDir, stdio: 'ignore' };
    execFileSync('git', ['init', '--quiet'], opts);
    execFileSync('git', ['config', 'user.email', 'probe@test.local'], opts);
    execFileSync('git', ['config', 'user.name', 'Probe Test'], opts);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# baseline\n');
    execFileSync('git', ['add', '.'], opts);
    execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], opts);
}

test('commitPendingProbe: codex + uncommitted edits + stagnation → fires and writes handoff.txt', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-probe-fire-')));
    const workingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-probe-repo-')));
    try {
        initGitRepo(workingDir);

        // Seed the trigger state: codex backend, advanced iteration counter,
        // last_progress lagging, uncommitted edit in the working tree.
        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'codex',
            step: 'implement',
            iteration: 5,
            working_dir: workingDir,
        }));
        // Uncommitted edit (tracked file modification — git diff --stat picks it up).
        fs.writeFileSync(path.join(workingDir, 'README.md'), '# baseline\nuncommitted edit\n');

        const logs = [];
        const result = commitPendingProbe({
            sessionDir,
            workingDir,
            backend: 'codex',
            iteration: 5,
            lastProgressIteration: 2, // stagnation = 3, threshold 2 → trips
            threshold: 2,
            pid: process.pid,
            log: (msg) => logs.push(msg),
        });

        assert.equal(result, 'fired', `expected fired, got ${result}`);

        const handoffPath = path.join(sessionDir, 'handoff.txt');
        assert.ok(fs.existsSync(handoffPath), 'handoff.txt should be written');

        const content = fs.readFileSync(handoffPath, 'utf-8');
        assert.match(content, /CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING/);
        assert.match(content, /git add <files>/);
        assert.match(content, /git commit -m/);
        assert.match(content, /# DEFERRED:/);
        assert.match(content, /<promise>I AM DONE<\/promise>/);
        // Stagnation count is interpolated into the body — N is replaced with the
        // actual count so the worker sees a concrete number, not a placeholder.
        assert.ok(!content.includes('for N iterations'), 'N placeholder should be replaced with actual count');
        assert.match(content, /for 3 iterations/);

        // Probe activation is logged through the injected log function.
        assert.ok(
            logs.some(m => m.includes('commit-pending probe FIRED')),
            'probe firing should be logged',
        );

        // Sanity: COMMIT_PENDING_HANDOFF_TEXT is the canonical template.
        assert.ok(
            COMMIT_PENDING_HANDOFF_TEXT.includes('CIRCUIT BREAKER HEALTH PROBE'),
            'exported template constant should match the documented header',
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});
