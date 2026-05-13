// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateTicketFrontmatter } from '../services/git-utils.js';

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ticket-frontmatter-'));
}

test('updateTicketFrontmatter: Failed status clears inferred completion evidence', () => {
  const root = makeTmpRoot();
  try {
    const sessionDir = path.join(root, 'session');
    const ticketId = 'e5f6a7b8';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
    fs.writeFileSync(ticketPath, `---
id: ${ticketId}
title: Test ticket
status: "In Progress"
completion_commit: "abc1234"
completion_commit_inferred: "def5678"
---

## Acceptance Criteria
- [x] failure is durable
`);

    updateTicketFrontmatter(ticketId, sessionDir, {
      status: 'Failed',
      completion_commit: null,
    });

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /status: "Failed"/);
    assert.doesNotMatch(updated, /^completion_commit:/m);
    assert.doesNotMatch(updated, /^completion_commit_inferred:/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
