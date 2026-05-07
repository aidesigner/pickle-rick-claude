// @tier: fast
/**
 * R-WSE-4 / AC-WSE-04 — `.claude/commands/send-to-morty.md` MUST contain a reminder
 * against premature `<promise>I AM DONE</promise>` emission. The reminder must
 * cite the literal phrase "ALL six lifecycle phases" so the lint check is exact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEND_TO_MORTY = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'send-to-morty.md');

test('AC-WSE-04: send-to-morty.md contains the "ALL six lifecycle phases" premature-promise reminder', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const matches = content.match(/ALL six lifecycle phases/g) || [];
  assert.ok(
    matches.length >= 1,
    `expected ≥1 occurrence of "ALL six lifecycle phases", got ${matches.length}`,
  );
});

test('AC-WSE-04: reminder ties phrase to <promise>I AM DONE</promise> guard', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const reminderRe = /Do NOT emit[^.]{0,200}I AM DONE[^.]{0,200}ALL six lifecycle phases/s;
  assert.ok(
    reminderRe.test(content),
    'reminder must connect "Do NOT emit ... I AM DONE" with "ALL six lifecycle phases"',
  );
});
