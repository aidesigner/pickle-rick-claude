// @tier: fast
/**
 * R-PSU-5 / AC-PSU-05 — `--days 1` semantics doc clarification.
 * R-PSU-2 / AC-PSU-02 — open-PR query change.
 * R-PSU-3 / AC-PSU-03 — Step 2.5 commit-level LOA-### scan.
 * R-PSU-4 / AC-PSU-04 — repo auto-discovery snippet.
 * R-SSWM-1 — Y: requires an in-window merge/commit event; `completedAt` alone insufficient.
 * R-SSWM-2 — `deploy_only` bucket: default-drop + separate "built earlier" heading.
 * R-SSWM-3 — read the ticket description before describing + LOA-731 counter-example.
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

test('R-SSWM-1: Y: ties to a merge/commit event; completedAt named as insufficient', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(
    content.includes('in-window merge or commit event'),
    'skill must tie Y: membership to an in-window merge or commit event',
  );
  assert.ok(
    content.includes('is NOT sufficient for Y:'),
    'skill must name a Linear status flip (completedAt/In Prod) as NOT sufficient for Y:',
  );
  assert.ok(
    /completedAt/.test(content),
    'skill must reference completedAt in the negative (status alone is not a ship signal)',
  );
});

test('R-SSWM-2: deploy_only bucket — default-drop + separate "built earlier" heading', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(content.includes('deploy_only'), 'skill must document the deploy_only ship_basis class');
  assert.ok(
    content.includes('dropped from Y: by default'),
    'deploy_only must be dropped from Y: by default',
  );
  assert.ok(
    content.includes('Reached production this window (built earlier)'),
    'deploy_only opt-in must go under a distinct "built earlier" heading',
  );
});

test('R-SSWM-3: read the ticket description before describing + LOA-731 counter-example', () => {
  const content = fs.readFileSync(SKILL, 'utf-8');
  assert.ok(
    content.includes('read the ticket description') || content.includes('read the ticket **description**'),
    'skill must instruct reading the ticket description (not the title alone)',
  );
  assert.ok(content.includes('LOA-731'), 'skill must carry the LOA-731-class counter-example');
});
