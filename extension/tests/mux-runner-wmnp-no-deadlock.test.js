// @tier: fast
//
// AC-R-WMNP-3: a terminal no-progress Failed flip must not order-deadlock the
// manager. Ticket-selection must skip a current_ticket that is Done/Skipped or a
// terminal no-progress Failed flip (status Failed + failed_reason
// oversized_no_progress), and findNextPendingTicketId must not return such a
// ticket. Generic Failed tickets keep their (re-attemptable) selection semantics.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeTicket(sessionDir, ticketId, order, frontmatter) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(
    path.join(dir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: "t"\norder: ${order}\n${fm}\n---\n# t\n`,
  );
}

test('AC-R-WMNP-3: selection (resolvePreTicket, no current) skips a terminal no-progress Failed ticket', async () => {
  const { resolvePreTicket } = await import('../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-nodeadlock-'));
  try {
    // T (order 10) is the just-flipped no-progress Failed ticket; U (order 20) is Todo.
    writeTicket(sessionDir, 'taaaaaaa', 10, { status: '"Failed"', failed_reason: 'oversized_no_progress' });
    writeTicket(sessionDir, 'ubbbbbbb', 20, { status: 'Todo' });
    // resolvePreTicket(_, null) delegates to findNextPendingTicketId.
    assert.equal(resolvePreTicket(sessionDir, null), 'ubbbbbbb',
      'selection returns the next Todo, never the no-progress Failed ticket');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-3: resolvePreTicket never re-engages a terminal current_ticket (no order-deadlock)', async () => {
  const { resolvePreTicket } = await import('../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-resolve-'));
  try {
    writeTicket(sessionDir, 'taaaaaaa', 10, { status: '"Failed"', failed_reason: 'oversized_no_progress' });
    writeTicket(sessionDir, 'ubbbbbbb', 20, { status: 'Todo' });

    // current_ticket still points at the flipped ticket → must fall through to U.
    assert.equal(resolvePreTicket(sessionDir, 'taaaaaaa'), 'ubbbbbbb',
      'a stale current_ticket on the flipped Failed ticket is skipped');
    // current_ticket on a live Todo ticket is honored.
    assert.equal(resolvePreTicket(sessionDir, 'ubbbbbbb'), 'ubbbbbbb',
      'a selectable current_ticket is honored');
    // null current_ticket → next pending.
    assert.equal(resolvePreTicket(sessionDir, null), 'ubbbbbbb');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-3: a Done current_ticket is still honored (preserves closer manager-handoff detection)', async () => {
  const { resolvePreTicket } = await import('../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-done-'));
  try {
    // The exclusion is scoped to the no-progress Failed flip ONLY. A Done
    // current_ticket must remain honored so the closer manager-handoff path (which
    // inspects the Done ticket downstream) is not severed.
    writeTicket(sessionDir, 'donedone', 10, { status: '"Done"' });
    writeTicket(sessionDir, 'ubbbbbbb', 20, { status: 'Todo' });
    assert.equal(resolvePreTicket(sessionDir, 'donedone'), 'donedone', 'Done current_ticket is honored, not skipped');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-3: a GENERIC Failed ticket (no oversized reason) stays selectable', async () => {
  const { resolvePreTicket } = await import('../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-genfail-'));
  try {
    // Generic Failed (e.g. validation failure) keeps retry semantics — scoping the
    // exclusion to oversized_no_progress must not abandon ordinary Failed tickets.
    writeTicket(sessionDir, 'genfaila', 10, { status: '"Failed"' });
    writeTicket(sessionDir, 'ubbbbbbb', 20, { status: 'Todo' });
    // order-10 generic Failed is still pending → selected first.
    assert.equal(resolvePreTicket(sessionDir, null), 'genfaila', 'generic Failed remains pending/selectable');
    assert.equal(resolvePreTicket(sessionDir, 'genfaila'), 'genfaila', 'generic Failed current_ticket is honored');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
