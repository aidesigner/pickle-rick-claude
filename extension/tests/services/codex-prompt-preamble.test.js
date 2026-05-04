// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'pickle.md');

test('template file exists', () => {
  assert.ok(fs.existsSync(TEMPLATE_PATH), `Template not found at ${TEMPLATE_PATH}`);
});

test('template contains Step 0 — Queue Check', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  assert.ok(content.includes('Step 0 — Queue Check'), 'Template must contain "Step 0 — Queue Check"');
});

test('template contains EPIC_COMPLETED promise tag (raw or split-form obfuscated)', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  // Anchor on the closing-tag suffix `EPIC_COMPLETED</promise>` — invariant
  // across both forms the template may carry: raw `<promise>EPIC_COMPLETED</promise>`
  // and split-form `\`<promise\` + \`>EPIC_COMPLETED</promise>\`` introduced by
  // 2ee7cc1 to satisfy template-no-bare-tokens.test.js. The 64-char window
  // covers the split-form backtick/plus separator while still rejecting stray
  // prose references that lack a nearby `<promise` opener.
  const SUFFIX = 'EPIC_COMPLETED</promise>';
  const properlyOpened = [];
  let idx = 0;
  while ((idx = content.indexOf(SUFFIX, idx)) !== -1) {
    properlyOpened.push(content.slice(Math.max(0, idx - 64), idx).includes('<promise'));
    idx += SUFFIX.length;
  }
  assert.ok(
    properlyOpened.length > 0,
    `Template must contain at least one "${SUFFIX}" closing-tag suffix`,
  );
  assert.ok(
    properlyOpened.every(Boolean),
    `Every "${SUFFIX}" must be preceded by an "<promise" within 64 chars`,
  );
});

test('Step 0 block appears before any other ## heading', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const step0Idx = content.indexOf('## Step 0 — Queue Check');
  assert.ok(step0Idx !== -1, 'Step 0 block not found in template');

  const beforeStep0 = content.slice(0, step0Idx);
  assert.ok(
    !/^##\s/m.test(beforeStep0),
    'No ## heading should appear before the Step 0 block',
  );
});
