import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeNewTicket,
  replayReverseLedger,
  updateTicketStatusInTransaction,
} from '../services/transaction-ticket-ops.js';
import { markTicketDone, markTicketSkipped } from '../services/pickle-utils.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-ticket-ops-'));
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeTicket(sessionDir, ticketId, status = 'Todo') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
  const content = [
    '---',
    `id: ${ticketId}`,
    `status: "${status}"`,
    'title: "Example"',
    '---',
    '',
    '# Example',
    '',
  ].join('\n');
  fs.writeFileSync(ticketPath, content);
  return { ticketDir, ticketPath, content };
}

test('updateTicketStatusInTransaction returns a planned write without mutating the ticket file', () => {
  withDir((sessionDir) => {
    const { ticketPath, content } = writeTicket(sessionDir, 'abc123');

    const planned = updateTicketStatusInTransaction('abc123', 'Done', sessionDir, {
      now: '2026-04-30T12:00:00.000Z',
    });

    assert.equal(planned.path, ticketPath);
    assert.match(planned.content, /^status: "Done"$/m);
    assert.match(planned.content, /^completed_at: "2026-04-30T12:00:00.000Z"$/m);
    assert.equal(fs.readFileSync(ticketPath, 'utf-8'), content);
  });
});

test('materializeNewTicket returns a ticket directory and planned files', () => {
  withDir((sessionDir) => {
    const planned = materializeNewTicket({
      ticketId: 'new123',
      sessionDir,
      frontmatter: { title: 'New Ticket', order: 7 },
      body: '# New Ticket\n',
    });

    assert.equal(planned.dirPath, path.join(sessionDir, 'new123'));
    assert.deepEqual(planned.files.map(file => file.path), [
      path.join(sessionDir, 'new123', 'linear_ticket_new123.md'),
    ]);
    assert.match(planned.files[0].content, /^id: "new123"$/m);
    assert.match(planned.files[0].content, /^status: "Todo"$/m);
    assert.match(planned.files[0].content, /^title: "New Ticket"$/m);
    assert.match(planned.files[0].content, /^order: 7$/m);
    assert.match(planned.files[0].content, /# New Ticket/);
    assert.equal(fs.existsSync(planned.dirPath), false);
  });
});

test('replayReverseLedger removes created files and restores backed-up content', () => {
  withDir((sessionDir) => {
    const createdPath = path.join(sessionDir, 'created', 'file.md');
    const updatedPath = path.join(sessionDir, 'updated.md');
    const ledgerPath = path.join(sessionDir, 'ledger.json');
    fs.mkdirSync(path.dirname(createdPath), { recursive: true });
    fs.writeFileSync(createdPath, 'created');
    fs.writeFileSync(updatedPath, 'new');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'create', path: path.relative(sessionDir, createdPath) },
        { action: 'write', path: updatedPath, beforeContent: 'old' },
      ],
    }));

    const restored = replayReverseLedger(ledgerPath, sessionDir);

    assert.equal(fs.existsSync(createdPath), false);
    assert.equal(fs.readFileSync(updatedPath, 'utf-8'), 'old');
    assert.deepEqual(restored, [{ path: updatedPath, content: 'old' }]);
  });
});

test('replayReverseLedger rejects paths outside the session root', () => {
  withDir((sessionDir) => {
    const ledgerPath = path.join(sessionDir, 'ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'create', path: '../outside.md' },
      ],
    }));

    assert.throws(
      () => replayReverseLedger(ledgerPath, sessionDir),
      /Path escapes ticket transaction root/,
    );
  });
});

test('existing ticket status wrappers write planned content at the wrapper boundary', () => {
  withDir((sessionDir) => {
    const doneTicket = writeTicket(sessionDir, 'done123');
    const skippedTicket = writeTicket(sessionDir, 'skip123');

    assert.equal(markTicketDone(sessionDir, 'done123'), true);
    assert.equal(markTicketSkipped(sessionDir, 'skip123'), true);

    const doneContent = fs.readFileSync(doneTicket.ticketPath, 'utf-8');
    const skippedContent = fs.readFileSync(skippedTicket.ticketPath, 'utf-8');
    assert.match(doneContent, /^status: "Done"$/m);
    assert.match(doneContent, /^completed_at: ".+"$/m);
    assert.match(skippedContent, /^status: "Skipped"$/m);
    assert.match(skippedContent, /^skipped_at: ".+"$/m);
  });
});
