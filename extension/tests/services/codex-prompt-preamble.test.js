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

test('template contains EPIC_COMPLETED promise tag', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  assert.ok(
    content.includes('<promise>EPIC_COMPLETED</promise>'),
    'Template must contain "<promise>EPIC_COMPLETED</promise>"',
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
