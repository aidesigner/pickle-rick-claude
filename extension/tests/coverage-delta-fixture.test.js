// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const DELTA_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'coverage-delta.sh');
const PARSER_CLI = path.join(EXTENSION_ROOT, 'bin', 'parse-coverage-exception.js');

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function coverageSummary(repoRoot, pct, covered = 10) {
  const generatedPath = path.join(repoRoot, 'extension', 'services', 'sample.js');
  return {
    total: {
      lines: { total: 20, covered, skipped: 0, pct },
    },
    [generatedPath]: {
      lines: { total: 20, covered, skipped: 0, pct },
    },
  };
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixtureRepo({ baselinePct, currentPct, baselineCovered = 10, currentCovered = 10, exception = false }) {
  const repoRoot = makeTempDir('coverage-delta-fixture-');
  const extensionRoot = path.join(repoRoot, 'extension');

  try {
    assert.equal(runGit(repoRoot, ['init', '-b', 'main']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.email', 'test@example.com']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.name', 'Test User']).status, 0);

    writeFile(repoRoot, 'extension/src/services/sample.ts', 'export const sample = 1;\n');
    writeFile(repoRoot, 'extension/services/sample.js', 'export const sample = 1;\n');
    writeFile(repoRoot, 'extension/scripts/coverage-delta.sh', fs.readFileSync(DELTA_SCRIPT, 'utf8'));
    writeJson(repoRoot, 'extension/coverage-baseline.json', coverageSummary(repoRoot, baselinePct, baselineCovered));
    writeJson(repoRoot, 'extension/coverage/coverage-summary.json', coverageSummary(repoRoot, currentPct, currentCovered));

    assert.equal(runGit(repoRoot, ['add', '.']).status, 0);
    assert.equal(runGit(repoRoot, ['commit', '-m', 'baseline']).status, 0);
    const mergeBase = runGit(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();

    writeFile(repoRoot, 'extension/src/services/sample.ts', 'export const sample = 2;\n');
    assert.equal(runGit(repoRoot, ['add', 'extension/src/services/sample.ts']).status, 0);
    const message = exception
      ? ['change sample', '', 'Coverage-Exception: extension/src/services/sample.ts:dead branch removed'].join('\n')
      : 'change sample';
    assert.equal(runGit(repoRoot, ['commit', '-m', message]).status, 0);

    return { repoRoot, extensionRoot, mergeBase };
  } catch (error) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    throw error;
  }
}

function runDelta(fixture) {
  return spawnSync('bash', [path.join(fixture.extensionRoot, 'scripts', 'coverage-delta.sh')], {
    cwd: fixture.repoRoot,
    env: {
      ...process.env,
      MERGE_BASE: fixture.mergeBase,
      COVERAGE_EXCEPTION_PARSER: PARSER_CLI,
    },
    encoding: 'utf8',
  });
}

function withFixture(options, fn) {
  const fixture = createFixtureRepo(options);
  try {
    fn(fixture);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
}

test('coverage delta: no regression exits green', () => {
  withFixture({ baselinePct: 75, currentPct: 75 }, (fixture) => {
    const result = runDelta(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('coverage delta: regression without exception exits red with evidence', () => {
  withFixture({ baselinePct: 90, currentPct: 80 }, (fixture) => {
    const result = runDelta(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /extension\/src\/services\/sample\.ts: baseline=90%, current=80%, delta=-10\.00%/);
  });
});

test('coverage delta: regression with Coverage-Exception exits green', () => {
  withFixture({ baselinePct: 90, currentPct: 80, exception: true }, (fixture) => {
    const result = runDelta(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('coverage delta: canary coverage gain of at least five covered lines is reported', () => {
  withFixture({ baselinePct: 50, currentPct: 80, baselineCovered: 10, currentCovered: 16 }, (fixture) => {
    const result = runDelta(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /extension\/src\/services\/sample\.ts: covered lines gain=6/);
  });
});

test('coverage delta: canary coverage gain suppresses pct-only regression', () => {
  withFixture({ baselinePct: 90, currentPct: 80, baselineCovered: 10, currentCovered: 16 }, (fixture) => {
    const result = runDelta(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /extension\/src\/services\/sample\.ts: covered lines gain=6/);
  });
});

test('coverage delta: missing current coverage summary exits with contract error', () => {
  withFixture({ baselinePct: 75, currentPct: 75 }, (fixture) => {
    fs.rmSync(path.join(fixture.extensionRoot, 'coverage', 'coverage-summary.json'));

    const result = runDelta(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /\[error: run 'npm run coverage' first\]/);
  });
});
