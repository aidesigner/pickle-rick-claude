// @tier: expensive
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const QUARANTINE_FILE = path.join(EXTENSION_ROOT, 'tests', 'QUARANTINE.md');
const RERUN_COUNT = 100;
const PASS_THRESHOLD = 99;
const SUBPROCESS_TIMEOUT_MS = 15000;

const SKIP_EXPENSIVE = process.env.RUN_EXPENSIVE_TESTS !== '1';

function parseQuarantineEntries(content) {
  const entries = [];
  let current = null;
  let inComment = false;

  for (const line of content.split('\n')) {
    if (line.includes('<!--')) { inComment = true; }
    if (!inComment) {
      const headingMatch = line.match(/^## (tests\/[^\s]+)$/);
      if (headingMatch) {
        current = { testPath: headingMatch[1], prdPath: null };
        entries.push(current);
      } else if (current) {
        const prdMatch = line.match(/^- PRD:\s*(.+)$/);
        if (prdMatch) current.prdPath = prdMatch[1].trim();
      }
    }
    if (line.includes('-->')) { inComment = false; }
  }

  return entries.filter((e) => e.prdPath !== null);
}

function readPrdStatus(absPath) {
  if (!existsSync(absPath)) return null;
  const match = readFileSync(absPath, 'utf8').match(/^status:\s*(\S+)/im);
  return match ? match[1] : null;
}

function runTestNTimes(testPath, n = RERUN_COUNT) {
  // Unset NODE_TEST_CONTEXT so node --test runs normally instead of skipping
  // files due to recursion detection when invoked from inside a test worker.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let passes = 0;
  for (let i = 0; i < n; i++) {
    const result = spawnSync(process.execPath, ['--test', testPath], {
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      env,
    });
    if (result.status === 0) passes++;
  }
  return passes;
}

test('quarantine-validation: Done-status entries must pass ≥99/100', async (t) => {
  if (SKIP_EXPENSIVE) { t.skip('RUN_EXPENSIVE_TESTS not set'); return; }

  if (!existsSync(QUARANTINE_FILE)) {
    t.skip('No quarantine catalog found');
    return;
  }

  const content = readFileSync(QUARANTINE_FILE, 'utf8');
  const entries = parseQuarantineEntries(content);
  const doneEntries = entries.filter((e) => readPrdStatus(path.join(REPO_ROOT, e.prdPath)) === 'Done');

  if (doneEntries.length === 0) {
    t.skip('No Done-status entries in quarantine catalog');
    return;
  }

  for (const entry of doneEntries) {
    await t.test(entry.testPath, () => {
      const absTestPath = path.join(EXTENSION_ROOT, entry.testPath);
      const passes = runTestNTimes(absTestPath);
      assert.ok(
        passes >= PASS_THRESHOLD,
        `${entry.testPath}: only ${passes}/${RERUN_COUNT} passed (threshold: ${PASS_THRESHOLD})`,
      );
    });
  }
});

test('fixture: always-pass test passes 100/100', (t) => {
  if (SKIP_EXPENSIVE) { t.skip('RUN_EXPENSIVE_TESTS not set'); return; }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qv-pass-'));
  try {
    const fixturePath = path.join(tmp, 'always-pass.test.js');
    writeFileSync(fixturePath, [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('always pass', () => assert.ok(true));",
    ].join('\n'));

    const passes = runTestNTimes(fixturePath);
    assert.equal(passes, 100, `Expected 100/100 passes but got ${passes}/100`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fixture: 90/100 test fails ≥99 threshold', (t) => {
  if (SKIP_EXPENSIVE) { t.skip('RUN_EXPENSIVE_TESTS not set'); return; }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qv-flaky-'));
  const counterFile = path.join(tmp, 'counter.txt');
  writeFileSync(counterFile, '0');
  try {
    const fixturePath = path.join(tmp, 'flaky-90.test.js');
    writeFileSync(fixturePath, [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const counterFile = ${JSON.stringify(counterFile)};`,
      "test('sometimes fail', () => {",
      "  const count = parseInt(readFileSync(counterFile, 'utf8'), 10) + 1;",
      "  writeFileSync(counterFile, String(count));",
      "  assert.ok(count % 10 !== 0, 'deterministic fail at run ' + count);",
      "});",
    ].join('\n'));

    const passes = runTestNTimes(fixturePath);
    assert.ok(
      passes < PASS_THRESHOLD,
      `Expected <${PASS_THRESHOLD} passes (90/100 fixture) but got ${passes}/100`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
