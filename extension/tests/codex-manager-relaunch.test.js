// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    evaluateCodexManagerRelaunch,
    recordCodexManagerRelaunch,
} from '../services/codex-manager-relaunch.js';
import { Defaults } from '../types/index.js';

const pendingTickets = [
    { id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    { id: 'pending', status: 'Todo', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function stateFixture(overrides = {}) {
    return {
        active: true,
        step: 'implement',
        iteration: 1,
        max_iterations: 100,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        max_time_minutes: 720,
        working_dir: process.cwd(),
        backend: 'codex',
        codex_manager_relaunch_count: 3,
        ...overrides,
    };
}

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter(entry => entry.endsWith('.jsonl'))
        .flatMap(entry => fs.readFileSync(path.join(activityDir, entry), 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line)));
}

test('codex-manager-relaunch exports evaluator and recorder', () => {
    assert.equal(typeof evaluateCodexManagerRelaunch, 'function');
    assert.equal(typeof recordCodexManagerRelaunch, 'function');
});

test('codex relaunch below cap returns eligible decision for runner call sites', () => {
    const decision = evaluateCodexManagerRelaunch(stateFixture(), pendingTickets, null);

    assert.equal(decision.shouldRelaunch, true);
    assert.equal(decision.reason, 'eligible');
    assert.equal(decision.pendingCount, 1);
    assert.equal(decision.nextRelaunchCount, 4);
});

test('codex relaunch below cap returns simple interface decision', () => {
    const decision = evaluateCodexManagerRelaunch(stateFixture(), true);

    assert.equal(decision.should_relaunch, true);
    assert.equal(decision.reason, 'below_cap');
    assert.equal(decision.current_count, 3);
    assert.equal(decision.cap, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
});

test('codex at cap does not relaunch', () => {
    const state = stateFixture({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP });
    const runnerDecision = evaluateCodexManagerRelaunch(state, pendingTickets, null);
    const simpleDecision = evaluateCodexManagerRelaunch(state, true);

    assert.equal(runnerDecision.shouldRelaunch, false);
    assert.equal(runnerDecision.reason, 'cap_exceeded');
    assert.equal(simpleDecision.should_relaunch, false);
    assert.equal(simpleDecision.reason, 'at_cap');
});

test('claude backend does not relaunch', () => {
    const state = stateFixture({ backend: 'claude' });
    const runnerDecision = evaluateCodexManagerRelaunch(state, pendingTickets, null);
    const simpleDecision = evaluateCodexManagerRelaunch(state, true);

    assert.equal(runnerDecision.shouldRelaunch, false);
    assert.equal(runnerDecision.reason, 'not_codex');
    assert.equal(simpleDecision.should_relaunch, false);
    assert.equal(simpleDecision.reason, 'wrong_backend');
});

test('no pending work does not relaunch', () => {
    const decision = evaluateCodexManagerRelaunch(
        stateFixture(),
        [{ id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null }],
        null,
    );

    assert.equal(decision.shouldRelaunch, false);
    assert.equal(decision.reason, 'no_pending');
});

test('recordCodexManagerRelaunch persists counter and emits activity event', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const statePath = path.join(sessionDir, 'state.json');

    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        fs.writeFileSync(statePath, JSON.stringify(stateFixture({ codex_manager_relaunch_count: 3 }), null, 2));

        const decision = evaluateCodexManagerRelaunch(JSON.parse(fs.readFileSync(statePath, 'utf-8')), pendingTickets, null);
        assert.equal(decision.shouldRelaunch, true);

        recordCodexManagerRelaunch(statePath, sessionDir, decision, 7, () => {});

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(persisted.codex_manager_relaunch_count, 4);

        const relaunchEvent = readActivityEvents(dataRoot).find(event => event.event === 'codex_manager_relaunch');
        assert.ok(relaunchEvent);
        assert.equal(relaunchEvent.iteration, 7);
        assert.equal(relaunchEvent.session, path.basename(sessionDir));
    } finally {
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
