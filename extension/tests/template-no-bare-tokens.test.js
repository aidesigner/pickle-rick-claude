import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROMISE_TOKENS } from '../services/promise-tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(__dirname, '..', '..', '.claude', 'commands');

const TEMPLATES = [
  'pickle.md',
  'meeseeks.md',
  'szechuan-sauce.md',
  'microverse.md',
  'pickle-tmux.md',
];

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

for (const filename of TEMPLATES) {
  test(`template-no-bare-tokens: ${filename}`, () => {
    const filePath = path.join(COMMANDS_DIR, filename);
    if (!existsSync(filePath)) {
      return;
    }
    const stripped = stripHtmlComments(readFileSync(filePath, 'utf8'));
    for (const token of PROMISE_TOKENS) {
      const literal = `<promise>${token}</promise>`;
      assert.ok(
        !stripped.includes(literal),
        `${filename}: bare promise token found — replace with substring-broken form: ${literal}`,
      );
    }
  });
}
