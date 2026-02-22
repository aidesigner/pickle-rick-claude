import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retryTicket } from '../bin/retry-ticket.js';

// --- Input validation ---

test('retryTicket: rejects path traversal ticketId', () => {
    assert.throws(() => retryTicket('../../../etc/passwd', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with spaces', () => {
    assert.throws(() => retryTicket('ticket with spaces', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects empty ticketId', () => {
    assert.throws(() => retryTicket('', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with slashes', () => {
    assert.throws(() => retryTicket('foo/bar', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with null byte', () => {
    assert.throws(() => retryTicket('foo\0bar', '/cwd'), /Invalid ticket ID/);
});

// --- No session map ---

test('retryTicket: throws when no sessions map exists', () => {
    // Use a cwd where no session map will exist (point getExtensionRoot away)
    // We can't easily mock getExtensionRoot, so test via the no-sessions-map path
    // by providing a cwd that won't be in any real sessions map
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        // Valid ticketId but no session will exist for this temp dir
        // retryTicket will throw "No active Pickle Rick session found." or "No active session found"
        assert.throws(
            () => retryTicket('abc123', dir),
            /No active Pickle Rick session found\.|No active session found/
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Ticket reset logic (filesystem-level test) ---

test('retryTicket: resets ticket status to Todo and archives artifacts', () => {
    // Build a minimal session structure that matches what retryTicket expects
    const extensionRoot = path.join(os.homedir(), '.claude/pickle-rick');
    const sessionsMapPath = path.join(extensionRoot, 'current_sessions.json');

    // Skip if we can't read the sessions map (CI environment)
    if (!fs.existsSync(sessionsMapPath)) {
        // No session map — can't run filesystem integration test
        return;
    }

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-'));
    const ticketId = 'test-ticket-9z';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });

    // Write ticket file with Done status
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`),
        `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`);

    // Write an artifact that should get archived
    fs.writeFileSync(path.join(ticketDir, 'research_2025-01-01.md'), '# Research');

    // Write state.json
    const state = {
        active: false,
        step: 'research',
        iteration: 2,
        session_dir: sessionDir,
        original_prompt: 'test task',
        worker_timeout_seconds: 1200,
    };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

    // Temporarily register this session in the map for our fake cwd
    const fakeCwd = sessionDir;
    const originalMap = fs.existsSync(sessionsMapPath)
        ? JSON.parse(fs.readFileSync(sessionsMapPath, 'utf-8'))
        : {};
    const patchedMap = { ...originalMap, [fakeCwd]: sessionDir };
    fs.writeFileSync(sessionsMapPath, JSON.stringify(patchedMap));

    try {
        retryTicket(ticketId, fakeCwd);

        // Verify: ticket status reset to Todo
        const ticketContent = fs.readFileSync(
            path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf-8');
        assert.match(ticketContent, /^status: Todo$/m);

        // Verify: artifact was archived
        const entries = fs.readdirSync(ticketDir);
        const archiveDirs = entries.filter(e => e.startsWith('_retry_'));
        assert.equal(archiveDirs.length, 1, 'Expected one archive dir');
        const archived = fs.readdirSync(path.join(ticketDir, archiveDirs[0]));
        assert.ok(archived.includes('research_2025-01-01.md'), 'Research file should be archived');

        // Verify: state.active set back to true
        const updatedState = JSON.parse(
            fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(updatedState.active, true);
    } finally {
        // Restore original sessions map
        fs.writeFileSync(sessionsMapPath, JSON.stringify(originalMap));
        fs.rmSync(sessionDir, { recursive: true });
    }
});
