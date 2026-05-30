// @tier: fast
/**
 * R-WSE-4 / AC-WSE-04 — `.claude/commands/send-to-morty.md` MUST contain a reminder
 * against premature `<promise>I AM DONE</promise>` emission. R-PIAP-A2 replaced the
 * hard "ALL six lifecycle phases" mandate with "all phases in the tier's lifecycle set"
 * so the guard is now tier-parameterized.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEND_TO_MORTY = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'send-to-morty.md');

test('AC-WSE-04: send-to-morty.md contains the tier-parameterized premature-promise reminder', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const matches = content.match(/all phases in the tier's lifecycle set/g) || [];
  assert.ok(
    matches.length >= 1,
    `expected ≥1 occurrence of "all phases in the tier's lifecycle set", got ${matches.length}`,
  );
});

test('AC-WSE-04: reminder ties tier-lifecycle phrase to <promise>I AM DONE</promise> guard', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const reminderRe = /Do NOT emit[^.]{0,300}I AM DONE[^.]{0,300}tier's lifecycle set/s;
  assert.ok(
    reminderRe.test(content),
    'reminder must connect "Do NOT emit ... I AM DONE" with "tier\'s lifecycle set"',
  );
});
