// Tests for the IterationOutcome shape returned by runIteration (ticket ff3a5ae3).
// Covers: shape contract, timing fields on the inactive early-return path, and
// the documented completion-value union. The hang-guard and spawn-error resolve
// paths require a live `claude` subprocess and are covered by integration runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIteration } from '../bin/mux-runner.js';

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
