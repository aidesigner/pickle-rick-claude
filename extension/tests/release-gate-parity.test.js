// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLAUDE_PATH = path.join(REPO_ROOT, 'CLAUDE.md');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const CI_GATE_COMMAND = 'npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm run test:fast && npm run test:integration';
const RELEASE_GATE_COMMAND = `${CI_GATE_COMMAND} && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`;

function versioningSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line === '## Versioning');
  assert.notEqual(start, -1, 'outer CLAUDE.md is missing ## Versioning section');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

function proseGateCommand() {
  const section = versioningSection(readFileSync(CLAUDE_PATH, 'utf8'));
  assert.ok(
    section.includes(`\`${RELEASE_GATE_COMMAND}\``),
    'outer CLAUDE.md Versioning section is missing the release gate command',
  );
  return RELEASE_GATE_COMMAND;
}

function runCommands(workflowText) {
  return workflowText
    .split(/\r?\n/)
    .map(line => line.match(/^\s*run:\s*(.+)\s*$/)?.[1])
    .filter(Boolean);
}

test('release workflow gate matches outer CLAUDE.md Versioning gate', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');
  const gate = proseGateCommand();

  assert.ok(
    runCommands(workflow).some(command => command.includes(gate)),
    'release.yml must contain the exact release gate command from outer CLAUDE.md',
  );
});

test('ci workflow runs PR-blocking non-expensive gate', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');

  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.match(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /^\s*-\s*main\s*$/m);
  assert.ok(
    runCommands(workflow).some(command => command.includes(CI_GATE_COMMAND)),
    'ci.yml must contain the fast and integration gate command',
  );
  assert.doesNotMatch(workflow, /test:expensive/);
});
