// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorkerPrompt } from '../bin/spawn-morty.js';

function makeTmpRoot(prefix = 'pickle-spawn-morty-completion-prompt-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('buildWorkerPrompt: codex worker prompt includes COMPLETION_COMMIT_RECORDED ACK directive', () => {
  const repoRoot = makeTmpRoot();
  try {
    const prompt = buildWorkerPrompt({
      ticket: {
        task: 'finish the ticket',
        ticketContent: '# Ticket',
        ticketId: '167fcaf9',
        ticketPath: path.join(repoRoot, '167fcaf9'),
        sessionRoot: repoRoot,
        backend: 'codex',
        isReviewTicket: false,
      },
      model: 'sonnet',
      repoRoot,
    });

    assert.match(prompt, /COMPLETION_COMMIT_RECORDED: <sha>/);
    assert.match(prompt, /The runner watches for this token and will retry if it's missing/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
