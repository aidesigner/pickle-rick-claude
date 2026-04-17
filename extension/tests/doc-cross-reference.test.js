import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function readDoc(relPath) {
  return readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

const CANONICAL_FRAME_NAMES = [
  'Frame 1: Context Key Lifecycle Trace',
  'Frame 2: Success/Failure Symmetry',
  'Frame 3: Edge Condition Exhaustiveness',
  'Frame 4: Tool Exit Code Semantics Audit',
  'Frame 5: Loop Convergence Proof Obligation',
  'Frame 6: Counterfactual Outcome Test',
];

const DOC_FILES_WITH_FRAMES = [
  '.claude/commands/pickle-dot-patterns.md',
  '.claude/commands/plumbus.md',
  'README.md',
];

const DOC_FILES_WITH_ENV_VAR = [
  '.claude/commands/plumbus.md',
  'CLAUDE.md',
  'README.md',
];

const FINGERPRINT_LITERAL = '<!-- graph-fingerprint: <sha256> -->';
const FINGERPRINT_REGEX_LITERAL = '^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$';

test('all six canonical Frame titles appear in each DOC_FILE that covers the rubric', () => {
  const failures = [];
  for (const docFile of DOC_FILES_WITH_FRAMES) {
    const content = readDoc(docFile);
    for (const frameName of CANONICAL_FRAME_NAMES) {
      if (!content.includes(frameName)) {
        failures.push(`${docFile}: missing "${frameName}"`);
      }
    }
  }
  assert.deepEqual(failures, [], `Frame name drift detected:\n${failures.join('\n')}`);
});

test('PLUMBUS_GENERATIVE_AUDIT env var spelled identically in all required DOC_FILES', () => {
  const ENV_VAR = 'PLUMBUS_GENERATIVE_AUDIT';
  const failures = [];
  for (const docFile of DOC_FILES_WITH_ENV_VAR) {
    const content = readDoc(docFile);
    if (!content.includes(ENV_VAR)) {
      failures.push(`${docFile}: missing "${ENV_VAR}"`);
    }
  }
  assert.deepEqual(failures, [], `Env var spelling drift:\n${failures.join('\n')}`);
});

test('fingerprint comment literal appears in plumbus.md', () => {
  const content = readDoc('.claude/commands/plumbus.md');
  assert.ok(
    content.includes(FINGERPRINT_LITERAL),
    `plumbus.md missing fingerprint literal: ${FINGERPRINT_LITERAL}`,
  );
});

test('fingerprint parser regex appears identically in plumbus.md and integration test', () => {
  const plumbus = readDoc('.claude/commands/plumbus.md');
  const integTest = readDoc(
    'extension/tests/plumbus-generative-audit.integration.test.js',
  );
  assert.ok(
    plumbus.includes(FINGERPRINT_REGEX_LITERAL),
    `plumbus.md missing parser regex: ${FINGERPRINT_REGEX_LITERAL}`,
  );
  assert.ok(
    integTest.includes(FINGERPRINT_REGEX_LITERAL),
    `integration test missing parser regex: ${FINGERPRINT_REGEX_LITERAL}`,
  );
});

test('Override 6 appears in plumbus.md with exact heading prefix', () => {
  const content = readDoc('.claude/commands/plumbus.md');
  assert.ok(
    content.includes('Override 6:'),
    'plumbus.md: Override 6 heading not found',
  );
});

test('README.md documents the Generative Audit Frames rubric section', () => {
  const content = readDoc('README.md');
  assert.ok(
    content.includes('Generative Audit Frames'),
    'README.md: missing "Generative Audit Frames" section',
  );
});

test('CLAUDE.md documents extension/data/ convention', () => {
  const content = readDoc('CLAUDE.md');
  assert.ok(
    content.includes('extension/data'),
    'CLAUDE.md: missing extension/data/ convention',
  );
});
