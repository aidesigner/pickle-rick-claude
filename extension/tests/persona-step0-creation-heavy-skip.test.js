// @tier: fast
// R-FRA-3: Persona Step 0 creation-heavy bundle heuristic present in persona.md.
// Created by ticket 4d100a28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PERSONA_SOURCE = path.resolve(REPO_ROOT, 'persona.md');

test('R-FRA-3: persona.md contains creation-heavy bundle Step 0 block', () => {
    const content = fs.readFileSync(PERSONA_SOURCE, 'utf-8');
    const hits = (content.match(/creation-heavy bundle/g) ?? []).length;
    assert.ok(hits >= 1, `expected ≥1 'creation-heavy bundle' occurrence in ${PERSONA_SOURCE}, got ${hits}`);
});

test('R-FRA-3: persona.md contains literal threshold "ticket count > 10"', () => {
    const content = fs.readFileSync(PERSONA_SOURCE, 'utf-8');
    assert.match(content, /> 10/, `expected literal '> 10' in ${PERSONA_SOURCE}`);
});

test('R-FRA-3: persona.md contains literal threshold "> 50%"', () => {
    const content = fs.readFileSync(PERSONA_SOURCE, 'utf-8');
    assert.match(content, /> 50%/, `expected literal '> 50%' in ${PERSONA_SOURCE}`);
});

test('R-FRA-3: persona.md documents reason-string format matching required regex shape', () => {
    const content = fs.readFileSync(PERSONA_SOURCE, 'utf-8');
    // Verify the documented format example matches the canonical regex shape:
    // ^creation-heavy bundle: \d+ tickets, \d+/\d+ forward-creating under (extension/tests/|extension/scripts/)
    const reasonFormatRe = /creation-heavy bundle: \d+ tickets, \d+\/\d+ forward-creating under extension\/(tests|scripts)\//;
    assert.match(content, reasonFormatRe, `expected a reason-string example matching the canonical regex shape in ${PERSONA_SOURCE}`);
});
