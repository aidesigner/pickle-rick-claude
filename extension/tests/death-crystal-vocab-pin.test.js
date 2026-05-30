// @tier: fast
// R-DC-1E (AC-DC-04): pins the `## Architectural Vocabulary` section in
// extension/CLAUDE.md (authored by R-DC-1C) so a future edit cannot silently
// strip the Pocock LANGUAGE.md vocabulary or reintroduce banned substitutions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claudeMdPath = path.resolve(__dirname, '..', 'CLAUDE.md');
const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');

// The 8 canonical LANGUAGE.md terms (mattpocock/skills:improve-codebase-architecture).
// `Implementation` is the 8th canonical term added by R-DC-1C.
const CANONICAL_TERMS = [
  'Module',
  'Interface',
  'Implementation',
  'Depth',
  'Seam',
  'Adapter',
  'Leverage',
  'Locality',
];

// Banned substitutions that must appear as bullets under the `Avoid` framing.
const BANNED_SUBSTITUTIONS = ['component', 'service', 'boundary', 'API'];

describe('R-DC-1E Architectural Vocabulary pin', () => {
  test('(c) exact `## Architectural Vocabulary` heading is present', () => {
    assert.match(
      claudeMd,
      /^## Architectural Vocabulary$/m,
      'extension/CLAUDE.md must contain the exact heading `## Architectural Vocabulary`',
    );
  });

  test('(a) all 8 canonical LANGUAGE.md terms are present as bold bullets', () => {
    for (const term of CANONICAL_TERMS) {
      const bullet = new RegExp(`^- \\*\\*${term}\\*\\*`, 'm');
      assert.match(
        claudeMd,
        bullet,
        `Architectural Vocabulary must define the term "${term}" as a bold bullet (- **${term}**)`,
      );
    }
    assert.equal(CANONICAL_TERMS.length, 8, 'exactly 8 canonical terms must be pinned');
  });

  test('(b) banned-substitution list is present as bullets under the Avoid framing', () => {
    assert.match(
      claudeMd,
      /### Avoid \(banned substitutions\)/,
      'the banned-substitution list must live under the `### Avoid (banned substitutions)` framing',
    );
    for (const banned of BANNED_SUBSTITUTIONS) {
      const bullet = new RegExp(`^- \\*\\*${banned}\\*\\* → use \\*\\*`, 'm');
      assert.match(
        claudeMd,
        bullet,
        `the Avoid list must ban "${banned}" as a substitution bullet (- **${banned}** → use **<Term>**)`,
      );
    }
  });
});
