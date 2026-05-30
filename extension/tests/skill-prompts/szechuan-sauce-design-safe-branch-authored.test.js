// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// R-PIAP-B4 — Branch-authored visual code is flag-only.
// In design-safe mode, a finding that is BOTH (a) in a visual file AND
// (b) introduced/modified by the branch under review is demoted to
// report-only: written to the findings report, never auto-fixed, reverted,
// or selected as the iteration's actioned violation. Non-visual findings and
// pre-existing (non-branch-authored) lines follow the normal fix path.

const SZECHUAN_PATH = path.resolve(import.meta.dirname, '../../../.claude/commands/szechuan-sauce.md');
const ANATOMY_PATH = path.resolve(import.meta.dirname, '../../../.claude/commands/anatomy-park.md');

function readSzechuan() {
    return fs.readFileSync(SZECHUAN_PATH, 'utf-8');
}

function readAnatomy() {
    return fs.readFileSync(ANATOMY_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// AC-PIAP-B4-1: szechuan-sauce demotes branch-authored visual findings to
// report-only (kept in the report, excluded from selection), while non-visual
// bugs still flow through the normal fix path.
// ---------------------------------------------------------------------------

test('AC-PIAP-B4-1: szechuan-sauce Override 1 describes branch-authorship determination', () => {
    const content = readSzechuan();
    const workerStart = content.indexOf('## WORKER MODE');
    const worker = content.slice(workerStart);
    assert.ok(worker.includes('branch-authorship check'), 'Override 1 must describe a branch-authorship check');
    // Branch base comes from start_commit; authorship determined via git diff against it.
    assert.ok(worker.includes('start_commit'), 'Override 1 must read start_commit as the branch base');
    assert.ok(
        worker.includes('git diff <start_commit> HEAD'),
        'Override 1 must diff against start_commit to determine branch-authored lines'
    );
    assert.ok(
        worker.includes('[report-only: intentional design choice]'),
        'Override 1 must tag branch-authored visual findings report-only'
    );
    // Fallback errs toward protection when start_commit is absent.
    assert.ok(
        worker.includes('absent') || worker.includes('null'),
        'Override 1 must define a fallback when start_commit is missing'
    );
});

test('AC-PIAP-B4-1: szechuan-sauce step 2.5 records report-only findings without silencing them', () => {
    const content = readSzechuan();
    assert.ok(
        content.includes('## Report-Only Findings (design-safe)'),
        'step 2.5 must write report-only findings to a dedicated gap_analysis section'
    );
    assert.ok(
        content.includes('intentional design choice'),
        'step 2.5 must define the intentional design choice category'
    );
    // Report-only is a demotion, NOT a drop — nothing is silenced.
    const idx = content.indexOf('## Report-Only Findings (design-safe)');
    const region = content.slice(idx - 800, idx + 200);
    assert.ok(
        region.includes('demotion, NOT a drop') || region.includes('demotion, not a drop'),
        'step 2.5 must clarify report-only is a demotion, not a drop'
    );
});

test('AC-PIAP-B4-1: szechuan-sauce step 3 excludes report-only findings from selection', () => {
    const content = readSzechuan();
    assert.ok(
        content.includes(
            'NOT in the failed approaches list from the handoff and is NOT tagged `[report-only: intentional design choice]`'
        ),
        'step 3 selection must exclude report-only findings'
    );
});

// ---------------------------------------------------------------------------
// AC-PIAP-B4-2: design-safe anatomy-park never selects a report-only
// (branch-authored visual) finding as the iteration's actioned fix.
// ---------------------------------------------------------------------------

test('AC-PIAP-B4-2: anatomy-park Phase 2 skips report-only findings in design-safe mode', () => {
    const content = readAnatomy();
    const fixStart = content.indexOf('#### PHASE 2: FIX');
    assert.ok(fixStart !== -1, 'anatomy-park must have a PHASE 2: FIX section');
    const fix = content.slice(fixStart, fixStart + 1200);
    assert.ok(fix.includes('design_safe: true'), 'Phase 2 must gate on design_safe: true');
    assert.ok(fix.includes('microverse.json'), 'Phase 2 must read design_safe from microverse.json');
    assert.ok(
        fix.includes('[report-only: intentional design choice]'),
        'Phase 2 must reference the report-only tag'
    );
    assert.ok(
        fix.includes('skip'),
        'Phase 2 must skip report-only findings when selecting the actioned fix'
    );
});

// ---------------------------------------------------------------------------
// AC-PIAP-B4-3: a non-visual finding in a UI-primary branch is still flagged
// and actioned normally — the report-only demotion is scoped to visual files
// AND branch-authored lines, and does not change the normal scoring path.
// ---------------------------------------------------------------------------

test('AC-PIAP-B4-3: szechuan-sauce keeps the normal scoring path for non-visual findings', () => {
    const content = readSzechuan();
    const workerStart = content.indexOf('## WORKER MODE');
    const worker = content.slice(workerStart);
    // The branch-authorship demotion must be explicitly scoped so non-visual
    // and pre-existing findings are unaffected.
    assert.ok(
        worker.includes('Non-visual findings and findings on pre-existing'),
        'Override 1 must state non-visual / pre-existing findings are unaffected'
    );
    // The standard confidence/priority selection language must still be present.
    assert.ok(
        worker.includes('confidence≥80 candidates'),
        'normal confidence-gated selection must remain intact'
    );
    assert.ok(
        worker.includes('P0 > P1 > P2 > P3 > P4'),
        'normal priority ordering must remain intact'
    );
});

test('AC-PIAP-B4-3: anatomy-park selects non-visual findings normally in design-safe mode', () => {
    const content = readAnatomy();
    const fixStart = content.indexOf('#### PHASE 2: FIX');
    const fix = content.slice(fixStart, fixStart + 1200);
    assert.ok(
        fix.includes('Non-visual findings and pre-existing-line findings are selected normally'),
        'Phase 2 must state non-visual / pre-existing findings are selected normally'
    );
});
