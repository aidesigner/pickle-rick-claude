import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    parseArgs,
    readActivityFiles,
    deduplicateCommits,
    formatOutput,
    getGitCommits,
} from '../bin/standup.js';

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'standup.js');

function runCli(args, env = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, ...env },
    });
}

function withTempActivityDir(fn) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-standup-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    try {
        fn(activityDir, extRoot);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
}

function writeEvent(activityDir, dateStr, event) {
    const filepath = path.join(activityDir, `${dateStr}.jsonl`);
    fs.appendFileSync(filepath, JSON.stringify(event) + '\n');
}

function yesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDateStr(d);
}

function today() {
    return formatDateStr(new Date());
}

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return formatDateStr(d);
}

function formatDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// --- parseArgs ---

test('parseArgs: defaults to --days 1 with no args', () => {
    const { range } = parseArgs([]);
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    const expectedSince = new Date(todayMidnight);
    expectedSince.setDate(expectedSince.getDate() - 1);
    assert.equal(range.since.getTime(), expectedSince.getTime());
    assert.equal(range.until.getTime(), tomorrowMidnight.getTime());
});

test('parseArgs: --days 0 covers today', () => {
    const { range } = parseArgs(['--days', '0']);
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    assert.equal(range.since.getTime(), todayMidnight.getTime());
    assert.equal(range.until.getTime(), tomorrowMidnight.getTime());
});

test('parseArgs: --days 3 covers 3 days back through today', () => {
    const { range } = parseArgs(['--days', '3']);
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    const expectedSince = new Date(todayMidnight);
    expectedSince.setDate(expectedSince.getDate() - 3);
    assert.equal(range.since.getTime(), expectedSince.getTime());
    assert.equal(range.until.getTime(), tomorrowMidnight.getTime());
});

test('parseArgs: --since overrides --days', () => {
    const { range } = parseArgs(['--days', '5', '--since', '2026-01-15']);
    assert.equal(range.since.getFullYear(), 2026);
    assert.equal(range.since.getMonth(), 0); // January = 0
    assert.equal(range.since.getDate(), 15);
});

// --- parseArgs error cases (CLI) ---

test('CLI: --days -1 exits with error', () => {
    const result = runCli(['--days', '-1']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-negative integer/);
});

test('CLI: --days NaN exits with error', () => {
    const result = runCli(['--days', 'abc']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-negative integer/);
});

test('CLI: --days without value exits with error', () => {
    const result = runCli(['--days']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a numeric value/);
});

test('CLI: --since with invalid date exits with error', () => {
    const result = runCli(['--since', 'not-a-date']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid date/);
});

test('CLI: --since with future date exits with error', () => {
    const result = runCli(['--since', '2099-01-01']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /future/);
});

test('CLI: --since without value exits with error', () => {
    const result = runCli(['--since']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a YYYY-MM-DD value/);
});

test('CLI: unknown flag exits with error', () => {
    const result = runCli(['--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag/);
});

test('CLI: --days Infinity exits with error', () => {
    const result = runCli(['--days', 'Infinity']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-negative integer/);
});

test('CLI: --days 1.5 exits with error', () => {
    const result = runCli(['--days', '1.5']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-negative integer/);
});

// --- readActivityFiles ---

test('readActivityFiles: reads and parses JSONL events', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle', session: 'sess-1' });
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T11:00:00Z`, event: 'ticket_completed', source: 'pickle', session: 'sess-1', ticket: 'abc' });

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 2);
        assert.equal(events[0].event, 'session_start');
        assert.equal(events[1].event, 'ticket_completed');
    });
});

test('readActivityFiles: filters files by date range', () => {
    withTempActivityDir((activityDir) => {
        const yesterdayStr = yesterday();
        const twoDaysAgoStr = daysAgo(2);
        writeEvent(activityDir, yesterdayStr, { ts: `${yesterdayStr}T10:00:00Z`, event: 'session_start', source: 'pickle' });
        writeEvent(activityDir, twoDaysAgoStr, { ts: `${twoDaysAgoStr}T10:00:00Z`, event: 'feature', source: 'persona', title: 'old' });

        // --days 1 = yesterday only
        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 1);
        assert.equal(events[0].event, 'session_start');
    });
});

test('readActivityFiles: --days 0 reads today', () => {
    withTempActivityDir((activityDir) => {
        const todayStr = today();
        writeEvent(activityDir, todayStr, { ts: `${todayStr}T08:00:00Z`, event: 'feature', source: 'persona', title: 'today work' });

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrowMidnight = new Date(todayMidnight);
        tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);

        const events = readActivityFiles(activityDir, todayMidnight, tomorrowMidnight);
        assert.equal(events.length, 1);
        assert.equal(events[0].title, 'today work');
    });
});

test('readActivityFiles: skips corrupt JSON lines', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        fs.writeFileSync(filepath, [
            JSON.stringify({ ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle' }),
            'NOT VALID JSON {{{',
            JSON.stringify({ ts: `${dateStr}T11:00:00Z`, event: 'session_end', source: 'pickle' }),
        ].join('\n') + '\n');

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 2);
    });
});

test('readActivityFiles: warns on >10% corrupt', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        // 1 valid + 2 corrupt = 66% corrupt
        fs.writeFileSync(filepath, [
            JSON.stringify({ ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle' }),
            'BAD LINE 1',
            'BAD LINE 2',
        ].join('\n') + '\n');

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        // Capture stderr
        const origStderr = console.error;
        let warned = false;
        console.error = (msg) => { if (typeof msg === 'string' && msg.includes('could not be parsed')) warned = true; };
        try {
            readActivityFiles(activityDir, sinceMidnight, todayMidnight);
            assert.ok(warned, 'Should have warned about corrupt lines');
        } finally {
            console.error = origStderr;
        }
    });
});

test('readActivityFiles: sorts events by timestamp', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T15:00:00Z`, event: 'session_end', source: 'pickle' });
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T08:00:00Z`, event: 'session_start', source: 'pickle' });
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T12:00:00Z`, event: 'commit', source: 'hook', commit_hash: 'abc1234' });

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 3);
        assert.ok(events[0].ts < events[1].ts);
        assert.ok(events[1].ts < events[2].ts);
    });
});

test('readActivityFiles: skips oversized files (>10MB guard)', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        // Create a file that exceeds 10MB
        const bigLine = JSON.stringify({ ts: `${dateStr}T10:00:00Z`, event: 'commit', source: 'hook', commit_hash: 'a'.repeat(100) }) + '\n';
        const fd = fs.openSync(filepath, 'w');
        // Write ~11MB
        const chunk = bigLine.repeat(1000);
        for (let i = 0; i < Math.ceil((11 * 1024 * 1024) / chunk.length); i++) {
            fs.writeSync(fd, chunk);
        }
        fs.closeSync(fd);

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        // Capture stderr for the warning
        const origStderr = console.error;
        let warned = false;
        console.error = (msg) => { if (typeof msg === 'string' && msg.includes('exceeds 10MB')) warned = true; };
        try {
            const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
            assert.equal(events.length, 0, 'Should skip oversized file');
            assert.ok(warned, 'Should warn about oversized file');
        } finally {
            console.error = origStderr;
        }
    });
});

test('readActivityFiles: rejects events with non-string ts or event', () => {
    withTempActivityDir((activityDir) => {
        const dateStr = yesterday();
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        fs.writeFileSync(filepath, [
            JSON.stringify({ ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle' }),
            JSON.stringify({ ts: 12345, event: 'session_end', source: 'pickle' }),
            JSON.stringify({ ts: `${dateStr}T11:00:00Z`, event: null, source: 'pickle' }),
            JSON.stringify({ ts: `${dateStr}T12:00:00Z`, event: 'commit', source: 'hook' }),
        ].join('\n') + '\n');

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 2, 'Should only accept events with string ts and event');
        assert.equal(events[0].event, 'session_start');
        assert.equal(events[1].event, 'commit');
    });
});

test('readActivityFiles: ignores malformed date filenames', () => {
    withTempActivityDir((activityDir) => {
        // Write a file with an invalid date filename that passes the .jsonl filter
        fs.writeFileSync(path.join(activityDir, 'not-a-date.jsonl'),
            JSON.stringify({ ts: `${yesterday()}T10:00:00Z`, event: 'commit', source: 'hook' }) + '\n');
        // Also write a valid file
        const dateStr = yesterday();
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle' });

        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMidnight = new Date(todayMidnight);
        sinceMidnight.setDate(sinceMidnight.getDate() - 1);

        const events = readActivityFiles(activityDir, sinceMidnight, todayMidnight);
        assert.equal(events.length, 1, 'should only read the valid-date file');
        assert.equal(events[0].event, 'session_start');
    });
});

test('readActivityFiles: returns empty for nonexistent directory', () => {
    const events = readActivityFiles('/nonexistent/path/activity', new Date(0), new Date());
    assert.equal(events.length, 0);
});

// --- deduplicateCommits ---

test('deduplicateCommits: hook commits win over git-log', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234', commit_message: 'fix: thing' },
        { ts: '2026-02-26T11:00:00Z', event: 'session_start', source: 'pickle' },
    ];
    const gitCommits = new Map([
        ['abc1234', 'fix: thing'],
        ['def5678', 'feat: other'],
    ]);

    const { hookCommits, gitOnlyCommits } = deduplicateCommits(events, gitCommits);
    assert.equal(hookCommits.length, 1);
    assert.equal(hookCommits[0].commit_hash, 'abc1234');
    assert.equal(gitOnlyCommits.length, 1);
    assert.equal(gitOnlyCommits[0][0], 'def5678');
});

test('deduplicateCommits: short hash prefix matching', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234567890' },
    ];
    const gitCommits = new Map([
        ['abc1234', 'fix: thing'], // short hash from --oneline
    ]);

    const { hookCommits, gitOnlyCommits } = deduplicateCommits(events, gitCommits);
    assert.equal(hookCommits.length, 1);
    assert.equal(gitOnlyCommits.length, 0, 'Short hash should match long hash prefix');
});

test('deduplicateCommits: empty git commits', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234' },
    ];
    const gitCommits = new Map();

    const { hookCommits, gitOnlyCommits } = deduplicateCommits(events, gitCommits);
    assert.equal(hookCommits.length, 1);
    assert.equal(gitOnlyCommits.length, 0);
});

test('deduplicateCommits: no commit events', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle' },
    ];
    const gitCommits = new Map([['def5678', 'feat: something']]);

    const { hookCommits, gitOnlyCommits } = deduplicateCommits(events, gitCommits);
    assert.equal(hookCommits.length, 0);
    assert.equal(gitOnlyCommits.length, 1);
});

// --- formatOutput ---

test('formatOutput: empty range shows no activity message', () => {
    const since = new Date('2026-02-26');
    const until = new Date('2026-02-27');
    const output = formatOutput([], [], [], since, until);
    assert.match(output, /No activity found/);
    assert.match(output, /2026-02-26/);
});

test('formatOutput: session with iterations and commits', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle', session: 'sess-1', original_prompt: 'Implement circuit breaker' },
        { ts: '2026-02-26T10:05:00Z', event: 'iteration_start', source: 'pickle', session: 'sess-1', iteration: 1 },
        { ts: '2026-02-26T10:20:00Z', event: 'iteration_end', source: 'pickle', session: 'sess-1', iteration: 1 },
        { ts: '2026-02-26T10:21:00Z', event: 'iteration_start', source: 'pickle', session: 'sess-1', iteration: 2 },
        { ts: '2026-02-26T10:40:00Z', event: 'iteration_end', source: 'pickle', session: 'sess-1', iteration: 2 },
        { ts: '2026-02-26T11:00:00Z', event: 'iteration_start', source: 'pickle', session: 'sess-1', iteration: 3 },
        { ts: '2026-02-26T11:30:00Z', event: 'session_end', source: 'pickle', session: 'sess-1' },
    ];
    const hookCommits = [
        { ts: '2026-02-26T10:25:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234567', commit_message: 'feat: circuit breaker', session: 'sess-1' },
    ];
    const output = formatOutput(events, hookCommits, [], new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /# Standup/);
    assert.match(output, /## Implement circuit breaker \(sess-1\)/);
    assert.match(output, /\*\*Duration\*\*: 1h 30m \(3 iterations\)/);
    assert.match(output, /\*\*Mode\*\*: tmux/);
    assert.match(output, /\*\*Commits\*\*:/);
    assert.match(output, /`abc1234` feat: circuit breaker/);
});

test('formatOutput: commit attribution by session field', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle', session: 'sess-1' },
        { ts: '2026-02-26T11:00:00Z', event: 'session_end', source: 'pickle', session: 'sess-1' },
    ];
    const hookCommits = [
        { ts: '2026-02-26T10:30:00Z', event: 'commit', source: 'hook', commit_hash: 'aaa1111111', commit_message: 'fix: attributed', session: 'sess-1' },
        { ts: '2026-02-26T12:00:00Z', event: 'commit', source: 'hook', commit_hash: 'bbb2222222', commit_message: 'fix: unattributed' },
    ];
    const output = formatOutput(events, hookCommits, [], new Date('2026-02-26'), new Date('2026-02-27'));
    // Attributed commit under session block
    assert.match(output, /## sess-1 \(sess-1\)/);
    assert.match(output, /`aaa1111` fix: attributed/);
    // Unattributed commit in ad-hoc (timestamp 12:00 is outside session 10:00-11:00)
    assert.match(output, /## Ad-hoc Commits/);
    assert.match(output, /`bbb2222` fix: unattributed/);
});

test('formatOutput: timestamp fallback attribution', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle', session: 'sess-1' },
        { ts: '2026-02-26T11:00:00Z', event: 'session_end', source: 'pickle', session: 'sess-1' },
    ];
    // Commit has no session field but timestamp falls within session range
    const hookCommits = [
        { ts: '2026-02-26T10:30:00Z', event: 'commit', source: 'hook', commit_hash: 'ccc3333333', commit_message: 'fix: fallback' },
    ];
    const output = formatOutput(events, hookCommits, [], new Date('2026-02-26'), new Date('2026-02-27'));
    // Should be attributed to sess-1 via timestamp fallback, not ad-hoc
    assert.match(output, /## sess-1 \(sess-1\)/);
    assert.match(output, /`ccc3333` fix: fallback/);
    assert.ok(!output.includes('Ad-hoc Commits'), 'No ad-hoc section expected');
});

test('formatOutput: ad-hoc commits from hook and git-only', () => {
    const hookCommits = [
        { ts: '2026-02-26T10:00:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234567', commit_message: 'fix: standalone' },
    ];
    const gitOnly = [['def5678901', 'feat: git only']];
    const output = formatOutput([], hookCommits, gitOnly, new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /## Ad-hoc Commits/);
    assert.match(output, /`abc1234` fix: standalone/);
    assert.match(output, /`def5678` feat: git only/);
});

test('formatOutput: old session without iteration events (graceful degradation)', () => {
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle', session: 'old-sess' },
        { ts: '2026-02-26T10:45:00Z', event: 'ticket_completed', source: 'pickle', session: 'old-sess', ticket: 'abc' },
    ];
    const output = formatOutput(events, [], [], new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /## old-sess \(old-sess\)/);
    assert.match(output, /\*\*Duration\*\*: 45m \(\? iterations\)/);
    assert.match(output, /\*\*Mode\*\*: inline/);
});

test('formatOutput: multiple sessions sorted newest first', () => {
    const events = [
        { ts: '2026-02-26T08:00:00Z', event: 'session_start', source: 'pickle', session: 'older-sess', original_prompt: 'Older task' },
        { ts: '2026-02-26T09:00:00Z', event: 'session_end', source: 'pickle', session: 'older-sess' },
        { ts: '2026-02-26T14:00:00Z', event: 'session_start', source: 'pickle', session: 'newer-sess', original_prompt: 'Newer task' },
        { ts: '2026-02-26T15:30:00Z', event: 'session_end', source: 'pickle', session: 'newer-sess' },
    ];
    const output = formatOutput(events, [], [], new Date('2026-02-26'), new Date('2026-02-27'));
    const newerIdx = output.indexOf('## Newer task');
    const olderIdx = output.indexOf('## Older task');
    assert.ok(newerIdx >= 0, 'Should contain newer session');
    assert.ok(olderIdx >= 0, 'Should contain older session');
    assert.ok(newerIdx < olderIdx, 'Newer session should appear first');
});

test('formatOutput: ad-hoc non-commit events in separate section', () => {
    const events = [
        { ts: '2026-02-26T14:00:00Z', event: 'feature', source: 'persona', title: 'Did a thing' },
    ];
    const output = formatOutput(events, [], [], new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /## Ad-hoc Activity/);
    assert.match(output, /Did a thing/);
});

test('formatOutput: commit with no message shows fallback', () => {
    const hookCommits = [
        { ts: '2026-02-26T10:00:00Z', event: 'commit', source: 'hook', commit_hash: 'abc1234567' },
    ];
    const output = formatOutput([], hookCommits, [], new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /\(no message\)/);
});

test('formatOutput: original_prompt truncated to 60 chars', () => {
    const longPrompt = 'This is a very long original prompt that exceeds sixty characters and should be truncated';
    const events = [
        { ts: '2026-02-26T10:00:00Z', event: 'session_start', source: 'pickle', session: 'sess-trunc', original_prompt: longPrompt },
        { ts: '2026-02-26T11:00:00Z', event: 'session_end', source: 'pickle', session: 'sess-trunc' },
    ];
    const output = formatOutput(events, [], [], new Date('2026-02-26'), new Date('2026-02-27'));
    assert.match(output, /## This is a very long original prompt that exceeds sixty ch/);
    assert.match(output, /\.\.\./);
    assert.ok(!output.includes(longPrompt), 'Full prompt should not appear');
});

// --- getGitCommits ---

test('getGitCommits: returns Map with short-hash keys from real git repo', () => {
    // We're running inside the pickle-rick-claude repo — should have real commits
    const commits = getGitCommits(new Date('2020-01-01'));
    assert.ok(commits instanceof Map);
    if (commits.size > 0) {
        // Verify entries have expected structure: short hash -> message
        const [hash, msg] = commits.entries().next().value;
        assert.ok(typeof hash === 'string' && hash.length >= 7, 'hash should be 7+ chars');
        assert.ok(typeof msg === 'string' && msg.length > 0, 'message should be non-empty');
    }
});

test('getGitCommits: returns empty Map when not in a git repo', () => {
    const origDir = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-standup-nogit-'));
    try {
        process.chdir(tmpDir);
        const commits = getGitCommits(new Date('2020-01-01'));
        assert.ok(commits instanceof Map);
        assert.equal(commits.size, 0);
    } finally {
        process.chdir(origDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- Full CLI integration ---

test('CLI: default run produces output', () => {
    withTempActivityDir((activityDir, extRoot) => {
        const dateStr = yesterday();
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T10:00:00Z`, event: 'session_start', source: 'pickle', session: 'test-sess' });
        writeEvent(activityDir, dateStr, { ts: `${dateStr}T11:00:00Z`, event: 'commit', source: 'hook', commit_hash: 'aaa1111', commit_message: 'fix: test' });

        const result = runCli([], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Standup/);
        assert.match(result.stdout, /test-sess/);
        assert.match(result.stdout, /aaa1111/);
    });
});

test('CLI: --days 0 shows today events', () => {
    withTempActivityDir((activityDir, extRoot) => {
        const todayStr = today();
        writeEvent(activityDir, todayStr, { ts: `${todayStr}T09:00:00Z`, event: 'feature', source: 'persona', title: 'morning work' });

        const result = runCli(['--days', '0'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /morning work/);
    });
});

test('CLI: empty range shows no activity', () => {
    withTempActivityDir((_activityDir, extRoot) => {
        // Run from temp dir (not a git repo) so git log returns nothing
        const result = spawnSync(process.execPath, [CLI_PATH, '--since', '2026-02-20'], {
            encoding: 'utf-8',
            timeout: 10000,
            env: { ...process.env, EXTENSION_DIR: extRoot },
            cwd: extRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /No activity found/);
    });
});

test('CLI: --days 3 includes events from 3 days ago', () => {
    withTempActivityDir((activityDir, extRoot) => {
        const threeDaysAgoStr = daysAgo(3);
        const twoDaysAgoStr = daysAgo(2);
        const fourDaysAgoStr = daysAgo(4);
        writeEvent(activityDir, threeDaysAgoStr, { ts: `${threeDaysAgoStr}T10:00:00Z`, event: 'feature', source: 'persona', title: 'three days' });
        writeEvent(activityDir, twoDaysAgoStr, { ts: `${twoDaysAgoStr}T10:00:00Z`, event: 'feature', source: 'persona', title: 'two days' });
        writeEvent(activityDir, fourDaysAgoStr, { ts: `${fourDaysAgoStr}T10:00:00Z`, event: 'feature', source: 'persona', title: 'four days' });

        const result = runCli(['--days', '3'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /three days/);
        assert.match(result.stdout, /two days/);
        assert.ok(!result.stdout.includes('four days'), 'Should not include 4 days ago');
    });
});
