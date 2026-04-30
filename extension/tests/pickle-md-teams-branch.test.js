import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE_MD = path.resolve(__dirname, '../../.claude/commands/pickle.md');

const text = fs.readFileSync(PICKLE_MD, 'utf-8');

test('pickle.md: contains teams_mode branch selector', () => {
    assert.match(text, /teams_mode/, 'pickle.md should branch on state.teams_mode');
});

test('pickle.md: references TeamCreate, TeamDelete, and Agent primitives', () => {
    assert.match(text, /TeamCreate/, 'should call TeamCreate');
    assert.match(text, /TeamDelete/, 'should call TeamDelete');
    assert.match(text, /\bAgent\b/, 'should mention the Agent tool');
});

test('pickle.md: references morty-implementer subagent', () => {
    assert.match(text, /morty-implementer/, 'should spawn morty-implementer subagent');
});

test('pickle.md: drives completion via TaskUpdate notifications', () => {
    assert.match(text, /TaskUpdate/, 'should mention TaskUpdate completion signal');
});

test('pickle.md: invokes validate-teams-ticket validator', () => {
    assert.match(text, /validate-teams-ticket/, 'should invoke the validator CLI');
});

test('pickle.md: teams brief injects project context before lifecycle guidance', () => {
    const phaseStart = text.indexOf('## Phase 3.B');
    const contextPath = text.indexOf('${SESSION_ROOT}/project-context.md', phaseStart);
    const contextBlock = text.indexOf('## Project Context', phaseStart);
    const placement = text.indexOf('before the phase instructions / 8-phase lifecycle guidance', phaseStart);

    assert.ok(phaseStart >= 0, 'should include Phase 3.B');
    assert.ok(contextPath > phaseStart, 'teams brief should reference project-context.md');
    assert.ok(contextBlock > contextPath, 'teams brief should name the Project Context block');
    assert.ok(placement > contextBlock, 'teams brief should require placement before lifecycle guidance');
});

test('pickle.md: legacy spawn-morty.js path remains for non-teams mode', () => {
    assert.match(text, /spawn-morty\.js/, 'legacy spawn-morty.js path should remain');
});

test('pickle.md: under 300 lines', () => {
    const lines = text.split('\n').length;
    assert.ok(lines < 300, `pickle.md is ${lines} lines, must stay under 300`);
});
