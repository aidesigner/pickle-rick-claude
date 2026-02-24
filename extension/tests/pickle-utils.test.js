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
} from '../services/pickle-utils.js';

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

// --- collectTickets ---

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
