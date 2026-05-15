// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const CLAUDE_MD = path.join(repoRoot, 'extension/src/bin/CLAUDE.md');

const src = fs.readFileSync(CLAUDE_MD, 'utf-8');

test('runnability-contract: extension/src/bin/CLAUDE.md has section header', () => {
  assert.match(
    src,
    /^## Resume-time ticket runnability contract$/m,
    'CLAUDE.md must contain `## Resume-time ticket runnability contract` section header',
  );
});

test('runnability-contract: section contains Precedence: line', () => {
  // Match a line that begins with "Precedence:" after the section header.
  const sectionStart = src.indexOf('## Resume-time ticket runnability contract');
  assert.notStrictEqual(sectionStart, -1, 'section header present');
  const sectionRegion = src.slice(sectionStart);
  assert.match(
    sectionRegion,
    /^Precedence:/m,
    'section must contain a `Precedence:` line',
  );
});

test('runnability-contract: section contains Heal flow recipe: line', () => {
  const sectionStart = src.indexOf('## Resume-time ticket runnability contract');
  const sectionRegion = src.slice(sectionStart);
  assert.match(
    sectionRegion,
    /^Heal flow recipe:/m,
    'section must contain a `Heal flow recipe:` line',
  );
});

test('runnability-contract: section references at least three of the four canonical sources', () => {
  const sectionStart = src.indexOf('## Resume-time ticket runnability contract');
  const sectionEnd = src.indexOf('## ', sectionStart + 1);
  const sectionRegion = sectionEnd === -1 ? src.slice(sectionStart) : src.slice(sectionStart, sectionEnd);
  const sources = [
    /frontmatter `status:`|frontmatter status:|`status:`/i,
    /state\.current_ticket|`state\.current_ticket`/,
    /manifest\.tickets|refinement_manifest\.json/,
    /pipeline\.json|completed_phases/,
  ];
  const matchedCount = sources.filter((re) => re.test(sectionRegion)).length;
  assert.ok(
    matchedCount >= 3,
    `section must reference at least 3 of the 4 canonical sources; got ${matchedCount}`,
  );
});

test('runnability-contract: section forbids parallel state fields', () => {
  const sectionStart = src.indexOf('## Resume-time ticket runnability contract');
  const sectionEnd = src.indexOf('## ', sectionStart + 1);
  const sectionRegion = sectionEnd === -1 ? src.slice(sectionStart) : src.slice(sectionStart, sectionEnd);
  // The doc explicitly calls out these forbidden field names.
  assert.match(
    sectionRegion,
    /state\.failed_tickets/,
    'section must explicitly name the forbidden parallel-set fields',
  );
});
