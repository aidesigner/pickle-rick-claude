// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendCoverageExceptionActivity,
  createCoverageExceptionActivityEvent,
  parseCoverageExceptionText,
} from '../bin/parse-coverage-exception.js';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const PARSER_CLI = path.join(EXTENSION_ROOT, 'bin', 'parse-coverage-exception.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runGit(cwd, args, opts = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    input: opts.input,
  });
}

function withTempGitRepo(fn) {
  const dir = makeTempDir('coverage-exception-git-');
  try {
    assert.equal(runGit(dir, ['init', '-b', 'main']).status, 0);
    assert.equal(runGit(dir, ['config', 'user.email', 'test@example.com']).status, 0);
    assert.equal(runGit(dir, ['config', 'user.name', 'Test User']).status, 0);
    fs.writeFileSync(path.join(dir, 'baseline.txt'), 'baseline\n');
    assert.equal(runGit(dir, ['add', 'baseline.txt']).status, 0);
    assert.equal(runGit(dir, ['commit', '-m', 'baseline']).status, 0);
    const mergeBase = runGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
    fn(dir, mergeBase);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('coverage parser: empty text returns empty array', () => {
  const result = parseCoverageExceptionText('commit body without trailers\n');
  assert.deepEqual(result.exceptions, []);
  assert.deepEqual(result.warnings, []);
});

test('coverage parser: multiple trailers return path and reason objects', () => {
  const text = [
    'Coverage-Exception: src/old.ts:dead code deleted',
    'Coverage-Exception: packages/a/file.js:refactor moved covered behavior',
    'unrelated body text',
    'Coverage-Exception: docs/guide.md:documentation-only coverage key',
  ].join('\n');

  const result = parseCoverageExceptionText(text);

  assert.equal(result.exceptions.length, 3);
  assert.deepEqual(result.exceptions, [
    { path: 'src/old.ts', reason: 'dead code deleted' },
    { path: 'packages/a/file.js', reason: 'refactor moved covered behavior' },
    { path: 'docs/guide.md', reason: 'documentation-only coverage key' },
  ]);
});

test('coverage parser: malformed trailer is skipped with stderr-ready warning', () => {
  const result = parseCoverageExceptionText([
    'Coverage-Exception: missing-colon',
    'Coverage-Exception: src/live.ts:valid reason',
  ].join('\n'));

  assert.deepEqual(result.exceptions, [
    { path: 'src/live.ts', reason: 'valid reason' },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /malformed Coverage-Exception trailer skipped/);
});

test('coverage parser CLI: synthesized commit returns JSON array', () => {
  withTempGitRepo((dir, mergeBase) => {
    fs.writeFileSync(path.join(dir, 'change.txt'), 'change\n');
    assert.equal(runGit(dir, ['add', 'change.txt']).status, 0);
    const message = [
      'change with trailer',
      '',
      'Coverage-Exception: src/deleted.ts:dead code removed',
    ].join('\n');
    assert.equal(runGit(dir, ['commit', '-m', message]).status, 0);

    const result = spawnSync(process.execPath, [PARSER_CLI], {
      cwd: dir,
      env: { ...process.env, MERGE_BASE: mergeBase },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      { path: 'src/deleted.ts', reason: 'dead code removed' },
    ]);
  });
});

test('coverage parser CLI: malformed synthesized trailer warns and skips', () => {
  const result = spawnSync(process.execPath, [PARSER_CLI], {
    input: 'Coverage-Exception: missing-colon\nCoverage-Exception: src/good.ts:valid\n',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /malformed Coverage-Exception trailer skipped/);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: 'src/good.ts', reason: 'valid' },
  ]);
});

test('coverage activity event: appends event and ticket-required kind shape', () => {
  const dir = makeTempDir('coverage-exception-state-');
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }, null, 2));

    appendCoverageExceptionActivity(
      statePath,
      { path: 'src/deleted.ts', reason: 'dead code removed' },
      { ts: '2026-05-03T12:00:00.000Z' },
    );

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.activity.length, 1);
    assert.deepEqual(state.activity[0], {
      event: 'coverage_exception',
      kind: 'coverage_exception',
      file: 'src/deleted.ts',
      reason: 'dead code removed',
      ts: '2026-05-03T12:00:00.000Z',
    });
    assert.match(state.activity[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage activity event: builder accepts file alias', () => {
  const event = createCoverageExceptionActivityEvent(
    { file: 'src/file.ts', reason: 'moved branch' },
    { ts: '2026-05-03T12:00:00.000Z' },
  );

  assert.equal(event.kind, 'coverage_exception');
  assert.equal(event.event, 'coverage_exception');
  assert.equal(event.file, 'src/file.ts');
  assert.equal(event.reason, 'moved branch');
});
