// @tier: fast
/**
 * R-PSU-5 / AC-PSU-05 — `--days 1` semantics doc clarification.
 * R-PSU-2 / AC-PSU-02 — open-PR query change.
 * R-PSU-3 / AC-PSU-03 — Step 2.5 commit-level LOA-### scan.
 * R-PSU-4 / AC-PSU-04 — repo auto-discovery snippet.
 *
 * Doc-only lint tests against `.claude/commands/pickle-standup.md`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'pickle-standup.md');

test('AC-PSU-05: skill documents `--days 1` as "INCLUDES today\'s commits"', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(content.includes("INCLUDES today's commits"), 'doc must clarify default includes today');
});

test('AC-PSU-05: common-usage section pins the same wording', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(
    content.includes('yesterday 00:00 through now, INCLUDING today'),
    'common-usage section must spell out the window with "INCLUDING today"',
  );
});

test('AC-PSU-02: open-PR query drops --search "updated:>=..." pattern', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  // The skill no longer uses --search "updated:>=..." for the open-PR pull;
  // it now does a JS-side filter on commits[].committedDate.
  assert.ok(
    content.includes('committedDate'),
    'open-PR query must filter by commits[].committedDate',
  );
  assert.ok(
    !/--state open\s+--search\s+"updated:>=/.test(content),
    'open-PR query must NOT use --search "updated:>=..." (misses commit-only updates)',
  );
});

test('AC-PSU-03: Step 2.5 commit-level LOA scan present', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(/Step 2\.5/.test(content), 'Step 2.5 header must exist');
  assert.ok(/git -C "\$repo" log/.test(content), 'commit-scan command must reference git log');
  assert.ok(/grep -oE '\\bLOA-\[0-9\]\+\\b'/.test(content), 'commit-scan must use the LOA- regex');
});

test('AC-PSU-04: skill replaces hardcoded repo list with auto-discovery loop', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(
    /for d in \/Users\/gregorydickson\/loanlight\/\*\//.test(content),
    'auto-discovery loop snippet must be present',
  );
  assert.ok(
    content.includes('pickle-rick-claude'),
    'discovery must explicitly skip pickle-rick-claude',
  );
});
