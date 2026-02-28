import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    parseSessionLine,
    scanSessionFiles,
    parseGitLogOutput,
    shortenSlug,
    formatNumber,
    buildReport,
} from '../services/metrics-utils.js';
import { parseMetricsArgs } from '../bin/metrics.js';

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'metrics.js');

function runMetricsCli(args, env = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, ...env },
    });
}

function makeTempProjectsDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-'));
    const cacheFile = path.join(root, 'metrics-cache.json');
    return { root, cacheFile };
}

function writeSessionLine(dir, slug, jsonlFilename, line) {
    const slugDir = path.join(dir, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.appendFileSync(path.join(slugDir, jsonlFilename), JSON.stringify(line) + '\n');
}

function makeAssistantLine(timestamp, input, output, cacheRead = 0, cacheCreate = 0) {
    return {
        type: 'assistant',
        timestamp,
        message: {
            usage: {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheCreate,
            },
        },
    };
}

// ---------------------------------------------------------------------------
// parseSessionLine
// ---------------------------------------------------------------------------

test('parseSessionLine: valid assistant line', () => {
    const line = JSON.stringify(makeAssistantLine('2026-02-28T10:00:00Z', 100, 200, 50, 25));
    const result = parseSessionLine(line);
    assert.ok(result);
    assert.equal(result.timestamp, '2026-02-28T10:00:00Z');
    assert.equal(result.usage.input, 100);
    assert.equal(result.usage.output, 200);
    assert.equal(result.usage.cache_read, 50);
    assert.equal(result.usage.cache_create, 25);
});

test('parseSessionLine: non-assistant type returns null', () => {
    const line = JSON.stringify({ type: 'human', timestamp: '2026-02-28T10:00:00Z', message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: corrupt JSON returns null', () => {
    assert.equal(parseSessionLine('NOT VALID JSON {{{'), null);
});

test('parseSessionLine: missing usage returns null', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-02-28T10:00:00Z', message: {} });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: missing timestamp returns null', () => {
    const line = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: numeric timestamp returns null', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: 12345, message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

test('formatNumber: 0 returns "0"', () => {
    assert.equal(formatNumber(0), '0');
});

test('formatNumber: 999 returns "999"', () => {
    assert.equal(formatNumber(999), '999');
});

test('formatNumber: 1000 returns "1.0K"', () => {
    assert.equal(formatNumber(1000), '1.0K');
});

test('formatNumber: 1234567 returns "1.2M"', () => {
    assert.equal(formatNumber(1234567), '1.2M');
});

test('formatNumber: 1234567890 returns "1.2B"', () => {
    assert.equal(formatNumber(1234567890), '1.2B');
});

test('formatNumber: NaN returns "0"', () => {
    assert.equal(formatNumber(NaN), '0');
});

test('formatNumber: Infinity returns "0"', () => {
    assert.equal(formatNumber(Infinity), '0');
});

test('formatNumber: negative number', () => {
    assert.equal(formatNumber(-1500), '-1.5K');
});

// ---------------------------------------------------------------------------
// shortenSlug
// ---------------------------------------------------------------------------

test('shortenSlug: strips user prefix', () => {
    const username = os.userInfo().username;
    const slug = `-Users-${username}-myproject`;
    assert.equal(shortenSlug(slug), 'myproject');
});

test('shortenSlug: replaces loanlight- prefix', () => {
    const username = os.userInfo().username;
    const slug = `-Users-${username}-loanlight-api`;
    assert.equal(shortenSlug(slug), 'l/api');
});

test('shortenSlug: passthrough for unmatched slug', () => {
    assert.equal(shortenSlug('other-project'), 'other-project');
});

test('shortenSlug: handles loanlight- without user prefix', () => {
    assert.equal(shortenSlug('loanlight-shared'), 'l/shared');
});

// ---------------------------------------------------------------------------
// parseGitLogOutput
// ---------------------------------------------------------------------------

test('parseGitLogOutput: normal two-commit output', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 3 files changed, 50 insertions(+), 10 deletions(-)',
        '2026-02-28T09:00:00-06:00',
        ' 1 file changed, 5 insertions(+)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 1);
    const entry = result.get('2026-02-28');
    assert.ok(entry);
    assert.equal(entry.commits, 2);
    assert.equal(entry.added, 55);
    assert.equal(entry.removed, 10);
});

test('parseGitLogOutput: merge commit with no stat line', () => {
    const output = [
        '2026-02-27T14:00:00-06:00',
        '',
        '2026-02-27T12:00:00-06:00',
        ' 2 files changed, 20 insertions(+), 5 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    const entry = result.get('2026-02-27');
    assert.ok(entry);
    assert.equal(entry.commits, 2);
    assert.equal(entry.added, 20);
    assert.equal(entry.removed, 5);
});

test('parseGitLogOutput: empty output', () => {
    const result = parseGitLogOutput('');
    assert.equal(result.size, 0);
});

test('parseGitLogOutput: multi-day output', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 1 file changed, 10 insertions(+)',
        '2026-02-27T10:00:00-06:00',
        ' 1 file changed, 20 insertions(+), 3 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 2);
    assert.equal(result.get('2026-02-28').added, 10);
    assert.equal(result.get('2026-02-27').added, 20);
    assert.equal(result.get('2026-02-27').removed, 3);
});

test('parseGitLogOutput: deletions only', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 2 files changed, 8 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    const entry = result.get('2026-02-28');
    assert.ok(entry);
    assert.equal(entry.added, 0);
    assert.equal(entry.removed, 8);
});

// ---------------------------------------------------------------------------
// scanSessionFiles
// ---------------------------------------------------------------------------

test('scanSessionFiles: scans JSONL and returns correct map', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'my-project', 'session.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200, 50, 25));
        writeSessionLine(root, 'my-project', 'session.jsonl',
            makeAssistantLine('2026-02-28T11:00:00Z', 150, 300, 60, 30));

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.equal(result.size, 1);
        assert.ok(result.has('my-project'));
        const dateMap = result.get('my-project');
        assert.ok(dateMap.has('2026-02-28'));
        const tokens = dateMap.get('2026-02-28');
        assert.equal(tokens.turns, 2);
        assert.equal(tokens.input, 250);
        assert.equal(tokens.output, 500);
        assert.equal(tokens.cache_read, 110);
        assert.equal(tokens.cache_create, 55);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: cache hit returns same data', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'cached-proj', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));

        const result1 = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(fs.existsSync(cacheFile), 'cache file should be created');

        const result2 = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        const t1 = result1.get('cached-proj').get('2026-02-28');
        const t2 = result2.get('cached-proj').get('2026-02-28');
        assert.equal(t1.turns, t2.turns);
        assert.equal(t1.input, t2.input);
        assert.equal(t1.output, t2.output);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: date range filtering', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'proj', 'sess.jsonl',
            makeAssistantLine('2026-02-25T10:00:00Z', 100, 200));
        writeSessionLine(root, 'proj', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 150, 300));

        const result = scanSessionFiles(root, '2026-02-27', '2026-02-28', cacheFile);
        const dateMap = result.get('proj');
        assert.ok(dateMap);
        assert.ok(dateMap.has('2026-02-28'));
        assert.ok(!dateMap.has('2026-02-25'), 'Should exclude dates before since');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: skips files over 50MB', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        const slugDir = path.join(root, 'big-project');
        fs.mkdirSync(slugDir, { recursive: true });
        const bigFile = path.join(slugDir, 'session.jsonl');
        const fd = fs.openSync(bigFile, 'w');
        const line = JSON.stringify(makeAssistantLine('2026-02-28T10:00:00Z', 100, 200)) + '\n';
        const chunk = line.repeat(1000);
        for (let i = 0; i < Math.ceil((51 * 1024 * 1024) / chunk.length); i++) {
            fs.writeSync(fd, chunk);
        }
        fs.closeSync(fd);

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(!result.has('big-project'), 'Should skip files > 50MB');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: filters out -private-var- slugs', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, '-private-var-folders-abc', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));
        writeSessionLine(root, 'real-project', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(!result.has('-private-var-folders-abc'), 'Should filter temp-dir slugs');
        assert.ok(result.has('real-project'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: nonexistent directory returns empty map', () => {
    const result = scanSessionFiles('/nonexistent/path', '2026-02-28', '2026-02-28', '/tmp/no-cache.json');
    assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

test('buildReport: daily grouping with token and LOC data', () => {
    const tokens = new Map([
        ['proj-a', new Map([
            ['2026-02-27', { turns: 5, input: 1000, output: 2000, cache_read: 100, cache_create: 50 }],
            ['2026-02-28', { turns: 3, input: 500, output: 1000, cache_read: 50, cache_create: 25 }],
        ])],
    ]);
    const loc = new Map([
        ['proj-a', new Map([
            ['2026-02-28', { commits: 2, added: 100, removed: 20 }],
        ])],
    ]);

    const report = buildReport(tokens, loc, '2026-02-27', '2026-02-28', 'daily');
    assert.equal(report.since, '2026-02-27');
    assert.equal(report.until, '2026-02-28');
    assert.equal(report.grouping, 'daily');
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows[0].date, '2026-02-27');
    assert.equal(report.rows[1].date, '2026-02-28');
    assert.equal(report.totals.turns, 8);
    assert.equal(report.totals.input, 1500);
    assert.equal(report.totals.output, 3000);
    assert.equal(report.totals.commits, 2);
    assert.equal(report.totals.added, 100);
    assert.equal(report.totals.removed, 20);
});

test('buildReport: weekly grouping value preserved', () => {
    const tokens = new Map();
    const loc = new Map();
    const report = buildReport(tokens, loc, '2026-02-01', '2026-02-28', 'weekly');
    assert.equal(report.grouping, 'weekly');
});

test('buildReport: empty maps produce empty report', () => {
    const tokens = new Map();
    const loc = new Map();
    const report = buildReport(tokens, loc, '2026-02-28', '2026-02-28', 'daily');
    assert.equal(report.rows.length, 0);
    assert.equal(report.projects.length, 0);
    assert.equal(report.totals.turns, 0);
    assert.equal(report.totals.commits, 0);
});

test('buildReport: LOC merges into matching project by slug suffix', () => {
    const tokens = new Map([
        ['-Users-greg-loanlight-api', new Map([
            ['2026-02-28', { turns: 1, input: 10, output: 20, cache_read: 0, cache_create: 0 }],
        ])],
    ]);
    const loc = new Map([
        ['loanlight-api', new Map([
            ['2026-02-28', { commits: 1, added: 50, removed: 10 }],
        ])],
    ]);

    const report = buildReport(tokens, loc, '2026-02-28', '2026-02-28', 'daily');
    const proj = report.projects.find(p => p.slug === '-Users-greg-loanlight-api');
    assert.ok(proj);
    assert.equal(proj.totals.commits, 1);
    assert.equal(proj.totals.added, 50);
    assert.equal(proj.totals.removed, 10);
});

// ---------------------------------------------------------------------------
// CLI Integration Tests
// ---------------------------------------------------------------------------

test('CLI: default invocation with mock data', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = new Date().toLocaleDateString('en-CA');
        writeSessionLine(root, 'test-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        const result = runMetricsCli([], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: --json outputs valid MetricsReport shape', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = new Date().toLocaleDateString('en-CA');
        writeSessionLine(root, 'json-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 500, 1000, 50, 25));

        const result = runMetricsCli(['--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.ok(report.since);
        assert.ok(report.until);
        assert.ok(report.grouping);
        assert.ok(Array.isArray(report.rows));
        assert.ok(Array.isArray(report.projects));
        assert.ok(typeof report.totals === 'object');
        assert.ok(typeof report.totals.turns === 'number');
        assert.ok(typeof report.totals.input === 'number');
        assert.ok(typeof report.totals.output === 'number');
        assert.ok(typeof report.totals.commits === 'number');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: --since future date exits with error', () => {
    const result = runMetricsCli(['--since', '2099-01-01']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /future/);
});

test('CLI: unknown flag exits with error', () => {
    const result = runMetricsCli(['--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag/);
});

test('CLI: --days 0 returns today only', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = new Date().toLocaleDateString('en-CA');
        writeSessionLine(root, 'today-proj', 'session.jsonl',
            makeAssistantLine(`${today}T08:00:00Z`, 100, 200));

        const result = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        for (const row of report.rows) {
            assert.equal(row.date, today, 'All rows should be today');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// parseMetricsArgs
// ---------------------------------------------------------------------------

test('parseMetricsArgs: no flags defaults to 7 days', () => {
    const result = parseMetricsArgs([]);
    assert.equal(result.days, 7);
    assert.equal(result.since, null);
    assert.equal(result.weekly, false);
    assert.equal(result.json, false);
});

test('parseMetricsArgs: --days 14', () => {
    const result = parseMetricsArgs(['--days', '14']);
    assert.equal(result.days, 14);
});

test('parseMetricsArgs: --days 0', () => {
    const result = parseMetricsArgs(['--days', '0']);
    assert.equal(result.days, 0);
});

test('parseMetricsArgs: --weekly alone defaults to 28 days', () => {
    const result = parseMetricsArgs(['--weekly']);
    assert.equal(result.days, 28);
    assert.equal(result.weekly, true);
});

test('parseMetricsArgs: --weekly --days 14 uses explicit days', () => {
    const result = parseMetricsArgs(['--weekly', '--days', '14']);
    assert.equal(result.days, 14);
    assert.equal(result.weekly, true);
});

test('parseMetricsArgs: --json flag', () => {
    const result = parseMetricsArgs(['--json']);
    assert.equal(result.json, true);
    assert.equal(result.days, 7);
});

test('parseMetricsArgs: --since sets date', () => {
    const result = parseMetricsArgs(['--since', '2026-02-01']);
    assert.equal(result.since, '2026-02-01');
    assert.equal(result.days, 7);
});

test('parseMetricsArgs: combined --json --weekly --days 7', () => {
    const result = parseMetricsArgs(['--json', '--weekly', '--days', '7']);
    assert.equal(result.json, true);
    assert.equal(result.weekly, true);
    assert.equal(result.days, 7);
});

// ---------------------------------------------------------------------------
// parseGitLogOutput: Invalid Date handling
// ---------------------------------------------------------------------------

test('parseGitLogOutput: invalid ISO date is skipped', () => {
    const output = [
        '9999-99-99T00:00:00Z',
        ' 1 file changed, 10 insertions(+)',
        '2026-02-28T10:00:00-06:00',
        ' 1 file changed, 5 insertions(+)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 1);
    assert.ok(result.has('2026-02-28'));
    assert.equal(result.get('2026-02-28').added, 5);
});

// ---------------------------------------------------------------------------
// CLI: --weekly integration
// ---------------------------------------------------------------------------

test('CLI: --weekly --json returns weekly grouping', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = new Date().toLocaleDateString('en-CA');
        writeSessionLine(root, 'weekly-proj', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        const result = runMetricsCli(['--weekly', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.grouping, 'weekly');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
