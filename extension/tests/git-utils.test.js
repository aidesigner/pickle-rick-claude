import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { get_branch_name, get_github_user, update_ticket_status } from '../services/git-utils.js';

// --- get_branch_name ---
// get_github_user() falls back to 'pickle-rick' when gh/git unavailable,
// so branch format is always <user>/<type>/<task_id>

test('get_branch_name: uses "fix" type for bug-related ticket id', () => {
    const branch = get_branch_name('fix-auth-123');
    assert.match(branch, /\/fix\/fix-auth-123$/);
});

test('get_branch_name: uses "fix" type for "bug" in ticket id', () => {
    const branch = get_branch_name('bug-login-overflow');
    assert.match(branch, /\/fix\/bug-login-overflow$/);
});

test('get_branch_name: uses "feat" type for normal ticket', () => {
    const branch = get_branch_name('add-login-button');
    assert.match(branch, /\/feat\/add-login-button$/);
});

test('get_branch_name: contains the ticket id', () => {
    const branch = get_branch_name('abc123');
    assert.ok(branch.includes('abc123'), `ticket id not in branch: ${branch}`);
});

test('get_branch_name: has three slash-separated parts', () => {
    const branch = get_branch_name('my-ticket');
    const parts = branch.split('/');
    assert.ok(parts.length >= 3, `expected at least 3 parts: ${branch}`);
});

// --- update_ticket_status ---

test('update_ticket_status: updates status in frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'testticket';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    fs.writeFileSync(
        path.join(subDir, `linear_ticket_${ticketId}.md`),
        `---\nid: ${ticketId}\ntitle: Test\nstatus: Todo\nupdated: 2025-01-01\n---\n# Body\n`
    );
    try {
        update_ticket_status(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "Done"$/m);
        // updated date should be refreshed
        const today = new Date().toISOString().split('T')[0];
        assert.match(content, new RegExp(`updated: "${today}"`));
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('update_ticket_status: throws when ticket file not found', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.throws(
            () => update_ticket_status('nonexistent', 'Done', dir),
            /not found/
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- get_github_user ---

test('get_github_user: returns a non-empty string', () => {
    const user = get_github_user();
    assert.ok(typeof user === 'string', 'should return a string');
    assert.ok(user.length > 0, 'should not be empty');
});

// --- update_ticket_status: updated field ---

test('update_ticket_status: updates the "updated" field to today', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'upd-date-check';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    fs.writeFileSync(
        path.join(subDir, `linear_ticket_${ticketId}.md`),
        '---\nid: "upd-date-check"\ntitle: "Date Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n# Body\n'
    );
    try {
        update_ticket_status(ticketId, 'InProgress', dir);
        const content = fs.readFileSync(
            path.join(subDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        const today = new Date().toISOString().split('T')[0];
        assert.match(content, new RegExp(`updated: "${today}"`),
            'updated field should be set to today');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- update_ticket_status: no frontmatter ---

test('update_ticket_status: no frontmatter prints warning and still replaces status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'no-fm';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // No --- delimiters — just bare YAML-like fields
    fs.writeFileSync(
        path.join(subDir, `linear_ticket_${ticketId}.md`),
        'id: "no-fm"\ntitle: "No Frontmatter"\nstatus: "Todo"\nupdated: "2020-01-01"\n\n# Body\nSome content.\n'
    );
    try {
        // Capture console.warn output
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            update_ticket_status(ticketId, 'Done', dir);
        } finally {
            console.warn = origWarn;
        }
        // Should have warned about missing frontmatter
        assert.ok(warnings.some(w => w.includes('no valid YAML frontmatter')),
            `expected a warning about missing frontmatter, got: ${JSON.stringify(warnings)}`);
        // Status should still be updated via full-file replace
        const content = fs.readFileSync(
            path.join(subDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "Done"$/m);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- update_ticket_status: preserves body content ---

test('update_ticket_status: preserves body content after frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'body-preserve';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    const bodyContent = '# Ticket Body\nSome important content here.\n\n- bullet one\n- bullet two\n';
    fs.writeFileSync(
        path.join(subDir, `linear_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Body Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n${bodyContent}`
    );
    try {
        update_ticket_status(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        // Status should be updated
        assert.match(content, /^status: "Done"$/m);
        // Body content must be preserved exactly
        assert.ok(content.includes(bodyContent),
            'body content after frontmatter should be unchanged');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- update_ticket_status: nested ticket ---

test('update_ticket_status: finds ticket in nested subdirectory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'nested-ticket';
    // Create a deeper directory structure: session_dir/some/nested/dir/ticketId/
    const nestedDir = path.join(dir, 'some', 'nested', 'dir', ticketId);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
        path.join(nestedDir, `linear_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Nested Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n# Nested Body\n`
    );
    try {
        update_ticket_status(ticketId, 'InProgress', dir);
        const content = fs.readFileSync(
            path.join(nestedDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "InProgress"$/m,
            'status should be updated even in deeply nested ticket file');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- update_ticket_status: warns when no status field found (deep review pass 6) ---

test('update_ticket_status: warns when ticket has no status field to replace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'no-status-field';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // Frontmatter with no status: line at all
    fs.writeFileSync(
        path.join(subDir, `linear_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "No Status"\norder: 1\n---\n# Body\n`
    );
    try {
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        const origLog = console.log;
        const logs = [];
        console.log = (...args) => logs.push(args.join(' '));
        try {
            update_ticket_status(ticketId, 'Done', dir);
        } finally {
            console.warn = origWarn;
            console.log = origLog;
        }
        // Should have warned about missing status field
        assert.ok(
            warnings.some(w => w.includes('status not updated')),
            `expected warning about status not updated, got: ${JSON.stringify(warnings)}`
        );
        // Should NOT have logged success
        assert.ok(
            !logs.some(l => l.includes('Successfully updated')),
            `should not log success when no status field was replaced, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- update_ticket_status: depth limit protects against deep recursion ---

test('update_ticket_status: respects depth limit on deeply nested directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'deep-ticket';
    // Create a structure 12 levels deep (exceeds the depth=10 limit)
    let current = dir;
    for (let i = 0; i < 12; i++) {
        current = path.join(current, `level${i}`);
    }
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(
        path.join(current, `linear_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Deep"\nstatus: "Todo"\n---\n# Body\n`
    );
    try {
        // Should throw because the file is too deep (>10 levels)
        assert.throws(
            () => update_ticket_status(ticketId, 'Done', dir),
            /not found/,
            'Should not find ticket beyond depth limit'
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- get_branch_name: "issue" keyword → fix type ---

test('get_branch_name: uses "fix" type for "issue" keyword in ticket id', () => {
    const branch = get_branch_name('issue-auth-flow');
    assert.match(branch, /\/fix\/issue-auth-flow$/,
        'ticket id containing "issue" should use "fix" type');
});

// --- get_branch_name: "patch" keyword → fix type ---

test('get_branch_name: uses "fix" type for "patch" keyword in ticket id', () => {
    const branch = get_branch_name('patch-memory-leak');
    assert.match(branch, /\/fix\/patch-memory-leak$/,
        'ticket id containing "patch" should use "fix" type');
});
