import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { get_branch_name, update_ticket_status } from '../services/git-utils.js';

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
