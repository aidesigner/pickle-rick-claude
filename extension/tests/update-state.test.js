import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { updateState } from '../bin/update-state.js';

function withTempSession(initialState, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(initialState));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

test('updateState: sets a top-level key', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        updateState('step', 'breakdown', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.step, 'breakdown');
    });
});

test('updateState: preserves existing keys', () => {
    withTempSession({ active: true, step: 'prd', iteration: 3 }, (dir) => {
        updateState('step', 'research', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.active, true);
        assert.equal(state.iteration, 3);
    });
});

test('updateState: sets current_ticket', () => {
    withTempSession({ active: true, current_ticket: null }, (dir) => {
        updateState('current_ticket', 'abc123', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.current_ticket, 'abc123');
    });
});

test('updateState: throws when state.json missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.throws(
            () => updateState('step', 'prd', dir),
            /state\.json not found/
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

test('updateState: valid step "implement" is accepted', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('step', 'implement', dir));
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.step, 'implement');
    });
});

test('updateState: valid step "refactor" is accepted', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('step', 'refactor', dir));
    });
});

test('updateState: invalid step throws with helpful message', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('step', 'bad-step', dir),
            /invalid step/i
        );
    });
});

test('updateState: step validation is case-sensitive ("PRD" is not valid)', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('step', 'PRD', dir),
            /invalid step/i
        );
    });
});

test('updateState: non-step keys bypass step validation', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('custom_key', 'any-value', dir));
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.custom_key, 'any-value');
    });
});
