// @tier: fast
// R-RTRC-1: Forward-reference hygiene section in refinement-team analyst prompts.
// AC-RTRC-02 — `grep -c "Forward-reference hygiene" extension/src/bin/spawn-refinement-team.ts` >= 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_REFINEMENT_TS = path.resolve(__dirname, '../src/bin/spawn-refinement-team.ts');

test('R-RTRC-1: spawn-refinement-team source contains Forward-reference hygiene section', () => {
    const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
    const occurrences = content.split('Forward-reference hygiene').length - 1;
    assert.ok(occurrences >= 1, 'expected at least 1 Forward-reference hygiene occurrence');
});

test('R-RTRC-1: hygiene section instructs ONLY-when-resolves backticking for paths', () => {
    const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
    assert.match(content, /git ls-files/);
    assert.match(content, /Backtick.*ONLY when/i);
});

test('R-RTRC-1: hygiene section forbids stdlib/external-package backticks', () => {
    const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
    // Must explicitly mention stdlib/external constraint to prevent false-positive resolver reports.
    assert.match(content, /stdlib|external-package/i);
});

test('R-RTRC-1: hygiene section references R-RTRC-7 annotation schema', () => {
    const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
    assert.match(content, /R-RTRC-7/);
    assert.match(content, /\(created by ticket/);
});

test('R-RTRC-1: annotation schema mandates exactly one ASCII space separator', () => {
    const content = fs.readFileSync(SPAWN_REFINEMENT_TS, 'utf-8');
    // Doc string MUST tell analysts about the strict separator rule (R-RTRC-7).
    assert.match(content, /(exactly one|one ASCII space)/i);
});
