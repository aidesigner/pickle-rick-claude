import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    statusSymbol,
    parseTicketFrontmatter,
    collectTickets,
    wrapText,
    formatTime,
    buildHandoffSummary,
    withSessionMapLock,
    pruneOldSessions,
    extractFrontmatter,
    getExtensionRoot,
    markTicketDone,
} from '../services/pickle-utils.js';

// --- getExtensionRoot ---

test('getExtensionRoot: uses EXTENSION_DIR env if set', () => {
    const saved = process.env.EXTENSION_DIR;
    try {
        process.env.EXTENSION_DIR = '/custom/path';
        assert.equal(getExtensionRoot(), '/custom/path');
    } finally {
        if (saved === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = saved;
    }
});

test('getExtensionRoot: defaults to ~/.claude/pickle-rick', () => {
    const saved = process.env.EXTENSION_DIR;
    try {
        delete process.env.EXTENSION_DIR;
        assert.equal(getExtensionRoot(), path.join(os.homedir(), '.claude/pickle-rick'));
    } finally {
        if (saved !== undefined) process.env.EXTENSION_DIR = saved;
    }
});

// --- extractFrontmatter ---

test('extractFrontmatter: extracts valid frontmatter', () => {
    const content = '---\nid: abc\nstatus: Todo\n---\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.equal(result.body, 'id: abc\nstatus: Todo');
    assert.equal(result.start, 0);
    assert.equal(content.slice(0, result.end), '---\nid: abc\nstatus: Todo\n---\n');
});

test('extractFrontmatter: returns null when no opening delimiter', () => {
    assert.equal(extractFrontmatter('# No frontmatter'), null);
});

test('extractFrontmatter: returns null when no closing delimiter', () => {
    assert.equal(extractFrontmatter('---\nid: abc\nstatus: Todo'), null);
});

test('extractFrontmatter: handles empty body with blank line', () => {
    const content = '---\n\n---\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.equal(result.body, '');
});

test('extractFrontmatter: no body (---\\n---) returns null — requires newline separator', () => {
    assert.equal(extractFrontmatter('---\n---\n# Body'), null);
});

test('extractFrontmatter: does not backtrack on large content missing closing ---', () => {
    // This would hang with the old regex on sufficiently large input
    const bigContent = '---\n' + 'x\n'.repeat(100000);
    const start = Date.now();
    const result = extractFrontmatter(bigContent);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed < 100, `extractFrontmatter took ${elapsed}ms — should be < 100ms`);
});

test('extractFrontmatter: handles Windows \\r\\n line endings', () => {
    const content = '---\r\nid: abc\r\nstatus: Todo\r\n---\r\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.ok(result.body.includes('id: abc'));
    assert.ok(result.body.includes('status: Todo'));
});

test('extractFrontmatter: \\r\\n returns null when no closing delimiter', () => {
    assert.equal(extractFrontmatter('---\r\nid: abc\r\nstatus: Todo'), null);
});

// --- statusSymbol ---

test('statusSymbol: lowercase done', () => assert.equal(statusSymbol('done'), '[x]'));
test('statusSymbol: title-case Done', () => assert.equal(statusSymbol('Done'), '[x]'));
test('statusSymbol: uppercase DONE', () => assert.equal(statusSymbol('DONE'), '[x]'));
test('statusSymbol: quoted "Done"', () => assert.equal(statusSymbol('"Done"'), '[x]'));
test("statusSymbol: single-quoted 'Done'", () => assert.equal(statusSymbol("'Done'"), '[x]'));
test('statusSymbol: in progress lowercase', () => assert.equal(statusSymbol('in progress'), '[~]'));
test('statusSymbol: In Progress title-case', () => assert.equal(statusSymbol('In Progress'), '[~]'));
test('statusSymbol: quoted "In Progress"', () => assert.equal(statusSymbol('"In Progress"'), '[~]'));
test('statusSymbol: Todo → [ ]', () => assert.equal(statusSymbol('Todo'), '[ ]'));
test('statusSymbol: Backlog → [ ]', () => assert.equal(statusSymbol('Backlog'), '[ ]'));
test('statusSymbol: empty string → [ ]', () => assert.equal(statusSymbol(''), '[ ]'));
test('statusSymbol: null → [ ]', () => assert.equal(statusSymbol(null), '[ ]'));
test('statusSymbol: undefined → [ ]', () => assert.equal(statusSymbol(undefined), '[ ]'));

// --- formatTime ---

test('formatTime: 0s', () => assert.equal(formatTime(0), '0m 0s'));
test('formatTime: 30s', () => assert.equal(formatTime(30), '0m 30s'));
test('formatTime: 60s → 1m', () => assert.equal(formatTime(60), '1m 0s'));
test('formatTime: 90s', () => assert.equal(formatTime(90), '1m 30s'));
test('formatTime: 3600s → 60m', () => assert.equal(formatTime(3600), '60m 0s'));
test('formatTime: 3661s', () => assert.equal(formatTime(3661), '61m 1s'));

// --- wrapText ---

test('wrapText: short text needs no wrapping', () => {
    assert.deepEqual(wrapText('hello world', 20), ['hello world']);
});

test('wrapText: wraps at word boundary', () => {
    const lines = wrapText('hello world foo bar baz', 10);
    assert.ok(lines.every(l => l.length <= 10), `line too long: ${JSON.stringify(lines)}`);
    assert.ok(lines.length > 1);
    assert.equal(lines.join(' '), 'hello world foo bar baz');
});

test('wrapText: empty string returns [""]', () => {
    assert.deepEqual(wrapText('', 10), ['']);
});

test('wrapText: zero width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello', 0), ['hello']);
});

test('wrapText: single word longer than width gets split', () => {
    const lines = wrapText('abcdefghijklmnop', 5);
    assert.ok(lines.every(l => l.length <= 5), `line too long: ${JSON.stringify(lines)}`);
    assert.equal(lines.join(''), 'abcdefghijklmnop');
});

// --- wrapText: Infinity, NaN, negative width edge cases (pass 9) ---

test('wrapText: Infinity width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', Infinity), ['hello world']);
});

test('wrapText: NaN width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', NaN), ['hello world']);
});

test('wrapText: negative width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', -5), ['hello world']);
});

// --- parseTicketFrontmatter ---

function withTempFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const file = path.join(dir, 'linear_ticket_test.md');
    fs.writeFileSync(file, content);
    try {
        fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

test('parseTicketFrontmatter: parses valid frontmatter', () => {
    withTempFile(`---\nid: abc123\ntitle: Test Ticket\nstatus: Todo\norder: 10\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.id, 'abc123');
        assert.equal(result.title, 'Test Ticket');
        assert.equal(result.status, 'Todo');
        assert.equal(result.order, 10);
    });
});

test('parseTicketFrontmatter: strips quotes from status', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: "Done"\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.status, 'Done');
    });
});

test('parseTicketFrontmatter: strips single quotes from title', () => {
    withTempFile(`---\nid: x\ntitle: 'My Ticket'\nstatus: Todo\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.title, 'My Ticket');
    });
});

test('parseTicketFrontmatter: missing frontmatter returns null', () => {
    withTempFile(`# No frontmatter\n\nJust content.`, (file) => {
        assert.equal(parseTicketFrontmatter(file), null);
    });
});

test('parseTicketFrontmatter: non-existent file returns null', () => {
    assert.equal(parseTicketFrontmatter('/tmp/nonexistent_pickle_test_xyz.md'), null);
});

test('parseTicketFrontmatter: missing order defaults to 0', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.order, 0);
    });
});

test('parseTicketFrontmatter: non-numeric order defaults to 0 (NaN guard)', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: abc\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.order, 0);
        assert.strictEqual(typeof result.order, 'number');
    });
});

// --- parseTicketFrontmatter: type field ---

test('parseTicketFrontmatter: extracts type field when present', () => {
    withTempFile(`---\nid: r1a2b3c4\ntitle: "Review: correctness"\nstatus: Todo\norder: 35\ntype: review\n---\n# Review\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.type, 'review');
    });
});

test('parseTicketFrontmatter: type is null when absent (backward compat)', () => {
    withTempFile(`---\nid: abc123\ntitle: Test Ticket\nstatus: Todo\norder: 10\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.type, null);
    });
});

// --- collectTickets ---

test('collectTickets: review tickets sorted by order alongside impl tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        // impl ticket at order 10
        const sub1 = path.join(dir, 'impl1');
        fs.mkdirSync(sub1);
        fs.writeFileSync(path.join(sub1, 'linear_ticket_impl1.md'),
            '---\nid: impl1\ntitle: Implement foo\nstatus: Done\norder: 10\n---\n');
        // review ticket at order 15
        const sub2 = path.join(dir, 'rev1');
        fs.mkdirSync(sub2);
        fs.writeFileSync(path.join(sub2, 'linear_ticket_rev1.md'),
            '---\nid: rev1\ntitle: "Review: impl1"\nstatus: Todo\norder: 15\ntype: review\n---\n');
        // impl ticket at order 20
        const sub3 = path.join(dir, 'impl2');
        fs.mkdirSync(sub3);
        fs.writeFileSync(path.join(sub3, 'linear_ticket_impl2.md'),
            '---\nid: impl2\ntitle: Implement bar\nstatus: Todo\norder: 20\n---\n');

        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 3);
        assert.equal(tickets[0].id, 'impl1');
        assert.equal(tickets[1].id, 'rev1');
        assert.equal(tickets[1].type, 'review');
        assert.equal(tickets[2].id, 'impl2');
        assert.equal(tickets[2].type, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: returns tickets sorted by order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        for (const [id, order, status] of [['aaa', 20, 'Todo'], ['bbb', 10, 'Done']]) {
            const sub = path.join(dir, id);
            fs.mkdirSync(sub);
            fs.writeFileSync(path.join(sub, `linear_ticket_${id}.md`),
                `---\nid: ${id}\ntitle: Ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n`);
        }
        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 2);
        assert.equal(tickets[0].id, 'bbb');  // order 10 comes first
        assert.equal(tickets[1].id, 'aaa');  // order 20 comes second
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: ignores non-ticket files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'abc');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'research_2025-01-01.md'), '# Research');
        fs.writeFileSync(path.join(sub, 'plan_2025-01-01.md'), '# Plan');
        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: empty directory returns []', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.deepEqual(collectTickets(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: non-existent directory returns []', () => {
    assert.deepEqual(collectTickets('/tmp/nonexistent_pickle_dir_xyz'), []);
});

// --- buildHandoffSummary: Number() coercion (deep review pass 8) ---

test('buildHandoffSummary: undefined iteration and string max_iterations are coerced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        // Create a minimal state.json so collectTickets can run
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: undefined, max_iterations: "5", step: 'implement' },
            dir
        );
        // With Number() coercion: undefined → 0, "5" → 5, so output is "0 of 5"
        assert.match(summary, /Iteration: 0 of 5/,
            'undefined iteration should coerce to 0, string max_iterations to 5');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: zero max_iterations shows just iteration number', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: "3", max_iterations: 0, step: 'prd' },
            dir
        );
        // max_iterations=0 means unlimited, so no "of N" suffix
        assert.match(summary, /Iteration: 3\n/,
            'zero max_iterations should show just the iteration number');
        assert.ok(!summary.includes('of 0'),
            'should not show "of 0" for unlimited iterations');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: new session vs resume detection ---

test('buildHandoffSummary: iteration 1 with no history shows NEW SESSION', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 0, max_iterations: 50, step: 'prd', history: [] },
            dir,
            1
        );
        assert.match(summary, /THIS IS A NEW SESSION/,
            'first iteration with empty history should indicate new session');
        assert.ok(!summary.includes('Resume from current phase'),
            'should not say "Resume" on a new session');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: iteration 2 shows resume message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 1, max_iterations: 50, step: 'implement', history: [{ step: 'prd' }] },
            dir,
            2
        );
        assert.match(summary, /Resume from current phase/,
            'later iterations should say resume');
        assert.ok(!summary.includes('NEW SESSION'),
            'should not say NEW SESSION on resume');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: iteration 1 with existing history shows resume', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 3, max_iterations: 50, step: 'implement', history: [{ step: 'prd' }] },
            dir,
            1
        );
        assert.match(summary, /Resume from current phase/,
            'iteration 1 with non-zero state.iteration should still say resume');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: no iterationNum defaults to new-session detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 0, max_iterations: 50, step: 'prd', history: [] },
            dir
        );
        assert.match(summary, /THIS IS A NEW SESSION/,
            'undefined iterationNum with iteration=0 and empty history should be new session');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: [REVIEW] tag for review tickets ---

test('buildHandoffSummary: shows [REVIEW] tag for review tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        // Create an impl ticket and a review ticket
        const implDir = path.join(dir, 'impl1');
        fs.mkdirSync(implDir);
        fs.writeFileSync(path.join(implDir, 'linear_ticket_impl1.md'),
            '---\nid: impl1\ntitle: Implement foo\nstatus: Done\norder: 10\n---\n');
        const revDir = path.join(dir, 'rev1');
        fs.mkdirSync(revDir);
        fs.writeFileSync(path.join(revDir, 'linear_ticket_rev1.md'),
            '---\nid: rev1\ntitle: "Review: impl1"\nstatus: Todo\norder: 15\ntype: review\n---\n');

        const summary = buildHandoffSummary({ step: 'research', iteration: 1 }, dir);
        assert.match(summary, /rev1:.*\[REVIEW\]/, 'review ticket should show [REVIEW] tag');
        assert.ok(!summary.includes('impl1') || !summary.match(/impl1:.*\[REVIEW\]/),
            'implementation ticket should NOT show [REVIEW] tag');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- withSessionMapLock ---

test('withSessionMapLock: executes fn and returns result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        const result = withSessionMapLock(lockPath, () => 42);
        assert.equal(result, 42);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withSessionMapLock: lock file is cleaned up after fn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        withSessionMapLock(lockPath, () => {});
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withSessionMapLock: lock file is cleaned up even when fn throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        assert.throws(() => withSessionMapLock(lockPath, () => { throw new Error('boom'); }), /boom/);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withSessionMapLock: steals stale lock and executes fn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        // Create a stale lock (old mtime)
        fs.writeFileSync(lockPath, 'stale');
        const staleTime = new Date(Date.now() - 10000); // 10s ago
        fs.utimesSync(lockPath, staleTime, staleTime);
        const result = withSessionMapLock(lockPath, () => 'stolen');
        assert.equal(result, 'stolen');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- pruneOldSessions ---

test('pruneOldSessions: does nothing when sessionsRoot does not exist', () => {
    assert.doesNotThrow(() => pruneOldSessions('/tmp/nonexistent_sessions_root_xyz'));
});

test('pruneOldSessions: removes old inactive session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'old-session');
        fs.mkdirSync(sessionDir);
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: false, started_at: oldDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneOldSessions: keeps recent inactive session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'recent-session');
        fs.mkdirSync(sessionDir);
        const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: false, started_at: recentDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), true);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('pruneOldSessions: never removes active session regardless of age', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'active-session');
        fs.mkdirSync(sessionDir);
        const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: true, started_at: oldDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), true);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('pruneOldSessions: skips entries without state.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const orphanDir = path.join(root, 'orphan-no-state');
        fs.mkdirSync(orphanDir);
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(orphanDir), true); // untouched
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// NaN from corrupt started_at — falls back to mtime (deep review pass 5)
// ---------------------------------------------------------------------------

test('pruneOldSessions: corrupt started_at falls back to mtime for age check', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'corrupt-date-session');
        fs.mkdirSync(sessionDir);
        // Write state with corrupt started_at — Date("not-a-date") produces NaN
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: false, started_at: 'not-a-date' })
        );
        // Set mtime to 10 days ago so the session is old enough to prune
        const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        fs.utimesSync(sessionDir, oldTime, oldTime);

        pruneOldSessions(root, 7);
        assert.equal(
            fs.existsSync(sessionDir),
            false,
            'Should prune session with corrupt started_at using mtime fallback'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneOldSessions: corrupt started_at but recent mtime is kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'corrupt-recent-session');
        fs.mkdirSync(sessionDir);
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: false, started_at: 'not-a-date' })
        );
        // mtime is recent (default, just created) → should NOT be pruned

        pruneOldSessions(root, 7);
        assert.equal(
            fs.existsSync(sessionDir),
            true,
            'Should keep session with corrupt started_at but recent mtime'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- markTicketDone ---

test('markTicketDone: updates unquoted Todo to Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'abc123');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'linear_ticket_abc123.md'),
            '---\nid: abc123\ntitle: Test\nstatus: Todo\norder: 10\n---\nBody');
        const result = markTicketDone(dir, 'abc123');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'linear_ticket_abc123.md'), 'utf-8');
        assert.ok(content.includes('status: "Done"'), `Expected status: "Done", got: ${content}`);
        assert.ok(content.includes('Body'), 'Body should be preserved');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: updates quoted "In Progress" to Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'def456');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'linear_ticket_def456.md'),
            '---\nid: def456\ntitle: Test\nstatus: "In Progress"\norder: 10\n---\n');
        const result = markTicketDone(dir, 'def456');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'linear_ticket_def456.md'), 'utf-8');
        assert.ok(content.includes('status: "Done"'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: no-op when already Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'ghi789');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'linear_ticket_ghi789.md'),
            '---\nid: ghi789\ntitle: Test\nstatus: "Done"\norder: 10\n---\n');
        const result = markTicketDone(dir, 'ghi789');
        assert.equal(result, false, 'Should return false when already Done');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: returns false for nonexistent ticket dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.equal(markTicketDone(dir, 'nonexistent'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: returns false when no linear_ticket_ file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'jkl012');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'research_notes.md'), '# Notes');
        assert.equal(markTicketDone(dir, 'jkl012'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
