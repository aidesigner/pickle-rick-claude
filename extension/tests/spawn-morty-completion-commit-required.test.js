// @tier: fast
/**
 * R-ICP-6 / AC-ICP-05 — worker prompt MUST require `completion_commit:` frontmatter
 * in the same write as `status: Done`. Lint check on spawn-morty.ts and
 * spawn-refinement-team.ts source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY = path.resolve(__dirname, '..', 'src', 'bin', 'spawn-morty.ts');
const SPAWN_REFINE = path.resolve(__dirname, '..', 'src', 'bin', 'spawn-refinement-team.ts');

test('AC-ICP-05: spawn-morty.ts requires completion_commit in same write as status: Done', () => {
  const content = fs.readFileSync(SPAWN_MORTY, 'utf-8');
  const matches = content.match(/completion_commit/g) || [];
  assert.ok(matches.length >= 1, `expected ≥1 occurrence in spawn-morty.ts, got ${matches.length}`);
});

test('AC-ICP-05: spawn-morty.ts worker prompt explicitly forbids early Done flip', () => {
  const content = fs.readFileSync(SPAWN_MORTY, 'utf-8');
  assert.ok(
    content.includes('NEVER flip') && content.includes('before the commit exists'),
    'worker prompt must contain the no-early-Done-flip rule',
  );
});

test('AC-ICP-05: spawn-refinement-team.ts or spawn-morty.ts surfaces completion_commit', () => {
  const morty = fs.readFileSync(SPAWN_MORTY, 'utf-8');
  const refine = fs.existsSync(SPAWN_REFINE) ? fs.readFileSync(SPAWN_REFINE, 'utf-8') : '';
  const total =
    (morty.match(/completion_commit/g) || []).length +
    (refine.match(/completion_commit/g) || []).length;
  assert.ok(total >= 1, `combined ≥1 across both spawn paths, got ${total}`);
});
