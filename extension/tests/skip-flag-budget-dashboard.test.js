// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    extractSkipFlagUse,
    scanSkipFlagEvents,
    buildSkipFlagBudgetReport,
    SKIP_FLAG_EVENT_NAMES,
    SKIP_FLAG_BUDGETS,
    DEFAULT_SKIP_FLAG_BUDGET,
} from '../services/metrics-utils.js';

const EXTENSION_ROOT = path.join(import.meta.dirname, '..');
const META_LINT = path.join(EXTENSION_ROOT, 'scripts', 'audit-skip-flag-unification.sh');
const CLAUDE_MD = path.join(EXTENSION_ROOT, 'CLAUDE.md');

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runMetaLint(env = {}) {
    return spawnSync('bash', [META_LINT], {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, ...env },
    });
}

// --- W5b: meta-lint -------------------------------------------------------

test('meta-lint: clean StateFlags passes (exit 0)', () => {
    const r = runMetaLint();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no non-unified skip flags/);
});

test('meta-lint: a NEW non-unified skip flag is flagged (exit 1)', () => {
    const dir = mkTmp('skipflag-lint-');
    const poisoned = path.join(dir, 'index.ts');
    fs.writeFileSync(
        poisoned,
        [
            'export interface StateFlags {',
            '  skip_quality_gates_reason?: string;',
            '  skip_readiness_reason?: string;',
            '  skip_brandnew_gate_reason?: string;',
            '  [key: string]: unknown;',
            '}',
            '',
        ].join('\n'),
    );
    const r = runMetaLint({ STATE_FLAGS_FILE: poisoned });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
    // the violation reported is the new flag, not a sanctioned survivor
    assert.match(r.stderr, /skip flag 'skip_brandnew_gate_reason'/);
    assert.doesNotMatch(r.stderr, /skip flag 'skip_quality_gates_reason'/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('meta-lint: documented survivors do NOT trip the lint', () => {
    const dir = mkTmp('skipflag-survivors-');
    const f = path.join(dir, 'index.ts');
    fs.writeFileSync(
        f,
        [
            'export interface StateFlags {',
            '  skip_quality_gates_reason?: string;',
            '  skip_readiness_reason?: string;',
            '  skip_ticket_audit_reason?: string;',
            '  skip_smoke_gate_reason?: string;',
            '}',
            '',
        ].join('\n'),
    );
    const r = runMetaLint({ STATE_FLAGS_FILE: f });
    assert.equal(r.status, 0, r.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('meta-lint: missing types file exits 2', () => {
    const r = runMetaLint({ STATE_FLAGS_FILE: '/nonexistent/path/index.ts' });
    assert.equal(r.status, 2);
});

// --- W5b: governance rule text -------------------------------------------

test('extension/CLAUDE.md carries the subtract-before-add governance rule', () => {
    const text = fs.readFileSync(CLAUDE_MD, 'utf-8');
    assert.match(text, /Subtract-before-add/);
    assert.match(text, /skip_quality_gates_reason/);
    assert.match(text, /recurrence budget/i);
    assert.match(text, /never given a second escape hatch|never handed a second escape hatch|never a second escape hatch/i);
});

// --- W5c: extract / scan / budget ----------------------------------------

test('extractSkipFlagUse: normalizes the three event shapes; ignores others', () => {
    assert.deepEqual(
        extractSkipFlagUse({ event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } }),
        { event: 'gate_skipped', source: 'pickle', reason: 'kill_switch' },
    );
    assert.deepEqual(
        extractSkipFlagUse({ event: 'readiness_skipped', source: 'pickle', gate_payload: { reason: 'manifest-bundle' } }),
        { event: 'readiness_skipped', source: 'pickle', reason: 'manifest-bundle' },
    );
    // legacy event carries the flag name under legacy_field, not reason
    assert.deepEqual(
        extractSkipFlagUse({ event: 'skip_flag_legacy_used', source: 'pickle', gate_payload: { legacy_field: 'skip_readiness_reason' } }),
        { event: 'skip_flag_legacy_used', source: 'pickle', reason: 'skip_readiness_reason' },
    );
    assert.equal(extractSkipFlagUse({ event: 'iteration_started', source: 'pickle' }), null);
    assert.equal(extractSkipFlagUse(null), null);
    // missing source defaults to pickle; missing reason -> unspecified
    assert.deepEqual(
        extractSkipFlagUse({ event: 'gate_skipped', gate_payload: {} }),
        { event: 'gate_skipped', source: 'pickle', reason: 'unspecified' },
    );
    assert.equal(SKIP_FLAG_EVENT_NAMES.length, 3);
});

test('buildSkipFlagBudgetReport: counts per {source,reason}', () => {
    const events = [
        { event: 'gate_skipped', source: 'pickle', reason: 'no_project_type_detected' },
        { event: 'gate_skipped', source: 'pickle', reason: 'no_project_type_detected' },
        { event: 'readiness_skipped', source: 'pickle', reason: 'manifest-bundle' },
    ];
    const report = buildSkipFlagBudgetReport(events, SKIP_FLAG_BUDGETS, '2026-06-01', '2026-06-13');
    assert.equal(report.total_uses, 3);
    const npt = report.entries.find((e) => e.reason === 'no_project_type_detected');
    assert.equal(npt.uses, 2);
    assert.equal(npt.source, 'pickle');
    const manifest = report.entries.find((e) => e.reason === 'manifest-bundle');
    assert.equal(manifest.uses, 1);
});

test('buildSkipFlagBudgetReport: over-budget gate flagged as removal candidate', () => {
    // manifest-bundle has no explicit budget -> DEFAULT_SKIP_FLAG_BUDGET (5)
    const events = [];
    for (let i = 0; i < DEFAULT_SKIP_FLAG_BUDGET + 1; i++) {
        events.push({ event: 'readiness_skipped', source: 'pickle', reason: 'manifest-bundle' });
    }
    const report = buildSkipFlagBudgetReport(events, SKIP_FLAG_BUDGETS, '2026-06-01', '2026-06-13');
    const entry = report.entries.find((e) => e.reason === 'manifest-bundle');
    assert.equal(entry.uses, DEFAULT_SKIP_FLAG_BUDGET + 1);
    assert.equal(entry.budget, DEFAULT_SKIP_FLAG_BUDGET);
    assert.equal(entry.over_budget, true);
    assert.equal(entry.removal_candidate, true);
});

test('buildSkipFlagBudgetReport: generous-budget gate stays under (not flagged)', () => {
    // kill_switch is an intentional skip with a large budget
    const events = [];
    for (let i = 0; i < 50; i++) {
        events.push({ event: 'gate_skipped', source: 'pickle', reason: 'kill_switch' });
    }
    const report = buildSkipFlagBudgetReport(events, SKIP_FLAG_BUDGETS, '2026-06-01', '2026-06-13');
    const entry = report.entries.find((e) => e.reason === 'kill_switch');
    assert.equal(entry.over_budget, false);
    assert.equal(entry.removal_candidate, false);
});

test('scanSkipFlagEvents: reads the three event names only, within the date window', () => {
    const dir = mkTmp('skipflag-activity-');
    const lines = [
        // in-window skip-flag events
        JSON.stringify({ ts: '2026-06-10T12:00:00.000Z', event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'no_commits' } }),
        JSON.stringify({ ts: '2026-06-10T13:00:00.000Z', event: 'skip_flag_legacy_used', source: 'pickle', gate_payload: { legacy_field: 'skip_ticket_audit_reason' } }),
        // non-skip event in window -> ignored
        JSON.stringify({ ts: '2026-06-10T14:00:00.000Z', event: 'iteration_started', source: 'pickle' }),
        // out-of-window skip event -> ignored
        JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } }),
        'not json',
    ];
    fs.writeFileSync(path.join(dir, '2026-06-10.jsonl'), lines.join('\n') + '\n');

    const events = scanSkipFlagEvents(dir, '2026-06-01', '2026-06-13');
    assert.equal(events.length, 2);
    const reasons = events.map((e) => e.reason).sort();
    assert.deepEqual(reasons, ['no_commits', 'skip_ticket_audit_reason']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('scanSkipFlagEvents: missing activity dir returns []', () => {
    assert.deepEqual(scanSkipFlagEvents('/nonexistent/activity', '2026-06-01', '2026-06-13'), []);
});

// --- W5c: end-to-end metrics CLI --json includes skip_flag_budget --------

test('metrics --json emits skip_flag_budget from the activity dir', () => {
    const dataRoot = mkTmp('skipflag-dataroot-');
    const activityDir = path.join(dataRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    fs.writeFileSync(
        path.join(activityDir, '2026-06-10.jsonl'),
        [
            JSON.stringify({ ts: '2026-06-10T12:00:00.000Z', event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'no_commits' } }),
            JSON.stringify({ ts: '2026-06-10T12:05:00.000Z', event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'no_commits' } }),
        ].join('\n') + '\n',
    );

    const CLI = path.join(EXTENSION_ROOT, 'bin', 'metrics.js');
    const r = spawnSync(process.execPath, [CLI, '--json', '--since', '2026-06-10'], {
        encoding: 'utf-8',
        timeout: 45000,
        env: {
            ...process.env,
            PICKLE_DATA_ROOT: dataRoot,
            // isolate token/loc scanning so the run is fast and deterministic
            CLAUDE_PROJECTS_DIR: path.join(dataRoot, 'no-projects'),
            METRICS_REPO_ROOT: path.join(dataRoot, 'no-repos'),
        },
    });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.skip_flag_budget, 'expected skip_flag_budget key in --json output');
    assert.equal(parsed.skip_flag_budget.total_uses, 2);
    const entry = parsed.skip_flag_budget.entries.find((e) => e.reason === 'no_commits');
    assert.equal(entry.uses, 2);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

// --- B-CSOR T40: citadel-mechanical recurrence budget --------------------

test('SKIP_FLAG_BUDGETS: citadel-mechanical::skip_quality_gates resolves to 3', () => {
    assert.equal(SKIP_FLAG_BUDGETS['citadel-mechanical::skip_quality_gates'], 3);
    // tighter than the default so routine operator bypasses surface as a smell sooner
    assert.ok(SKIP_FLAG_BUDGETS['citadel-mechanical::skip_quality_gates'] < DEFAULT_SKIP_FLAG_BUDGET);
});

test('buildSkipFlagBudgetReport: citadel-mechanical bypass flagged over its budget of 3', () => {
    const events = [];
    for (let i = 0; i < 4; i++) {
        events.push({ event: 'gate_skipped', source: 'citadel-mechanical', reason: 'skip_quality_gates' });
    }
    const report = buildSkipFlagBudgetReport(events, SKIP_FLAG_BUDGETS, '2026-06-01', '2026-06-16');
    const entry = report.entries.find((e) => e.source === 'citadel-mechanical' && e.reason === 'skip_quality_gates');
    assert.ok(entry, 'expected a citadel-mechanical entry');
    assert.equal(entry.uses, 4);
    assert.equal(entry.budget, 3);
    assert.equal(entry.over_budget, true);
    assert.equal(entry.removal_candidate, true);
});

test('buildSkipFlagBudgetReport: citadel-mechanical bypass at budget (3) is NOT flagged', () => {
    const events = [];
    for (let i = 0; i < 3; i++) {
        events.push({ event: 'gate_skipped', source: 'citadel-mechanical', reason: 'skip_quality_gates' });
    }
    const report = buildSkipFlagBudgetReport(events, SKIP_FLAG_BUDGETS, '2026-06-01', '2026-06-16');
    const entry = report.entries.find((e) => e.source === 'citadel-mechanical' && e.reason === 'skip_quality_gates');
    assert.equal(entry.uses, 3);
    assert.equal(entry.over_budget, false);
    assert.equal(entry.removal_candidate, false);
});
