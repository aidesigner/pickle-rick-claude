// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-flake-budget.js');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flake-budget-')));
}

function writeSyntheticTest(dir) {
  const stateFile = path.join(dir, 'state.txt');
  const testFile = path.join(dir, 'synthetic-flake.test.js');
  const source = `import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';

const stateFile = process.env.FLAKE_STATE_FILE;
const failRuns = Number.parseInt(process.env.FLAKE_FAIL_RUNS ?? '0', 10);
let count = 0;

try {
  count = Number.parseInt(fs.readFileSync(stateFile, 'utf8'), 10);
} catch {}

count += 1;
fs.writeFileSync(stateFile, String(count));

test('synthetic flake budget probe', () => {
  assert.ok(count > failRuns, 'forced failure for run ' + count);
});
`;
  fs.writeFileSync(testFile, source);
  return { stateFile, testFile };
}

function runBudgetCheck({ runs, failBudget, failRuns }) {
  const dir = makeTmpDir();
  const { stateFile, testFile } = writeSyntheticTest(dir);
  return {
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    result: spawnSync(
      process.execPath,
      [BIN, `--runs=${runs}`, `--fail-budget=${failBudget}`, '--timeout=10000'],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          PICKLE_FLAKE_BUDGET_TEST_FILE: testFile,
          FLAKE_STATE_FILE: stateFile,
          FLAKE_FAIL_RUNS: String(failRuns),
        },
      },
    ),
  };
}

test('flake-budget passes when all runs pass', () => {
  const run = runBudgetCheck({ runs: 3, failBudget: 2, failRuns: 0 });
  try {
    assert.equal(run.result.status, 0, `stderr: ${run.result.stderr}`);
    assert.match(run.result.stdout, /flake-budget OK/);
  } finally {
    run.cleanup();
  }
});

test('flake-budget passes at the failure budget boundary', () => {
  const run = runBudgetCheck({ runs: 4, failBudget: 2, failRuns: 2 });
  try {
    assert.equal(run.result.status, 0, `stderr: ${run.result.stderr}`);
    assert.match(run.result.stdout, /failures=2 budget=2/);
  } finally {
    run.cleanup();
  }
});

test('flake-budget fails when failures exceed the budget', () => {
  const run = runBudgetCheck({ runs: 5, failBudget: 2, failRuns: 3 });
  try {
    assert.equal(run.result.status, 1, `stdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);
    assert.match(run.result.stderr, /FAIL_BUDGET_EXCEEDED/);
    assert.match(run.result.stderr, /failures=3 budget=2/);
  } finally {
    run.cleanup();
  }
});
