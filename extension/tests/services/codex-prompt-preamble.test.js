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

  // The closing-tag suffix `EPIC_COMPLETED</promise>` is invariant across both
  // forms the template may carry: the raw `<promise>EPIC_COMPLETED</promise>`
  // and the split-form obfuscation `\`<promise\` + \`>EPIC_COMPLETED</promise>\``
  // introduced by 2ee7cc1 to satisfy template-no-bare-tokens.test.js. The model
  // emits the closing tag verbatim either way, so anchoring on the suffix is
  // the byte-exact contract that survives both lint regimes.
  const closingMatches = content.match(/EPIC_COMPLETED<\/promise>/g) ?? [];
  assert.ok(
    closingMatches.length > 0,
    'Template must contain at least one "EPIC_COMPLETED</promise>" closing-tag suffix',
  );

  // Sanity: every closing suffix must have an opening `<promise` within 64
  // chars before it, so the literal is genuinely a promise tag instruction
  // and not a stray reference in prose. 64 chars covers the split form
  // including the surrounding inline-code backticks and ` + ` separator.
  const occurrences = [];
  let idx = 0;
  while ((idx = content.indexOf('EPIC_COMPLETED</promise>', idx)) !== -1) {
    const window = content.slice(Math.max(0, idx - 64), idx);
    occurrences.push(window.includes('<promise'));
    idx += 'EPIC_COMPLETED</promise>'.length;
  }
  assert.ok(
    occurrences.length > 0 && occurrences.every(Boolean),
    'Every "EPIC_COMPLETED</promise>" must be preceded by an "<promise" within 64 chars',
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
