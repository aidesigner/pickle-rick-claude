// @tier: fast
// Regression test for anatomy-park iteration 3: plumbus-frame-analyzer must
// not block indefinitely on a wedged `bun` subprocess. A stuck registry import,
// infinite loop inside dump-graph.ts, or catastrophic regex on attractor graph
// traversal can hang bun forever; without a per-call `timeout` option on
// spawnSync, the entire plumbus generative-audit pipeline stalls with no log
// signal — same silent-hang class as the council-publish `gh` gap (iteration
// 1) and the scope-resolver `rg`/`grep` gap (iteration 2).
//
// Strategy: prepend a tmp dir containing a fake `bun` script that hangs on the
// targeted subcommand to PATH, then invoke the analyzer. Assert wall time is
// bounded by BUN_TIMEOUT_MS (30s) + slack, exit code is 2, and stderr carries
// a timeout diagnostic. We cannot lower BUN_TIMEOUT_MS without touching source,
// so the test's own timeout is the fallback bound.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'frame1-asymmetric-writer.dot');
const EXPECTED_TIMEOUT_MS = 30_000;
// R-TSPF residual (load-dependent-timeout): the inner BUN_TIMEOUT_MS hang
// guard genuinely consumes ~30s. In isolation — and even under 12-way CPU
// saturation — the analyzer exits at ~30s. But inside the full
// `--test-concurrency=8` suite (4900+ tests, thousands of concurrent
// `/var/folders` temp dirs) the node analyzer's own ESM module-load + cold
// start can stall for tens of seconds before it even reaches the
// `spawnSync('bun', …)` line — so the inner 30s timer starts late and the
// total wall time drifts well past a 60-90s budget, killing the analyzer
// from the outer spawnSync before its SIGTERM-driven exit can land. The
// inner timeout still does the real hang detection (stderr diagnostic
// proves it); the wall budget is only a fallback bound, so it is widened
// generously to absorb worst-case full-suite startup contention. A genuine
// unbounded-hang regression still fails — just after this larger bound.
// BUN_TIMEOUT_MS lives in src/ and cannot be lowered from the test.
const WALL_CLOCK_BUDGET_MS = EXPECTED_TIMEOUT_MS + 150_000;

let tmpRoot;

function makeHangingBun(hangOn) {
  const dir = mkdtempSync(path.join(tmpRoot, 'hang-bun-'));
  const bunPath = path.join(dir, 'bun');
  // hangOn: 'version' hangs only on `bun --version`; 'dumpgraph' answers
  // --version quickly but hangs on `bun <dump-graph.ts>`; 'always' hangs on
  // every invocation. The hang sleeps 120s — long enough to exceed the
  // analyzer's BUN_TIMEOUT_MS by 4×.
  const script = hangOn === 'version'
    ? 'if [ "$1" = "--version" ]; then sleep 120; fi\n'
    : hangOn === 'dumpgraph'
      ? 'if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\nsleep 120\n'
      : 'sleep 120\n';
  writeFileSync(bunPath, `#!/bin/sh\n${script}`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function makeAttractorRoot() {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function runAnalyzer(bunDir, attractorRoot) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, FIXTURE_PATH],
    {
      encoding: 'utf8',
      timeout: WALL_CLOCK_BUDGET_MS,
      env: {
        ...process.env,
        ATTRACTOR_ROOT: attractorRoot,
        PATH: `${bunDir}:${process.env.PATH ?? ''}`,
      },
    },
  );
}

describe('plumbus-frame-analyzer — bun hang guard', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-hang-tests-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('hung `bun --version` exits non-zero within BUN_TIMEOUT_MS + slack', () => {
    const start = Date.now();
    const result = runAnalyzer(makeHangingBun('version'), makeAttractorRoot());
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < WALL_CLOCK_BUDGET_MS,
      `elapsed ${elapsed}ms hit the test's own budget — hang guard did not fire inside the analyzer`,
    );
    assert.strictEqual(result.signal, null, `analyzer killed by harness (signal=${result.signal}); timeout should have fired inside the analyzer, not from the outer spawnSync budget`);
    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /bun --version exceeded \d+ms timeout/,
      `expected timeout diagnostic, got: ${result.stderr}`,
    );
  });

  test('hung `bun dump-graph.ts` exits non-zero within BUN_TIMEOUT_MS + slack', () => {
    const start = Date.now();
    const result = runAnalyzer(makeHangingBun('dumpgraph'), makeAttractorRoot());
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < WALL_CLOCK_BUDGET_MS,
      `elapsed ${elapsed}ms hit the test's own budget — hang guard did not fire inside the analyzer`,
    );
    assert.strictEqual(result.signal, null, `analyzer killed by harness (signal=${result.signal}); timeout should have fired inside the analyzer, not from the outer spawnSync budget`);
    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /dump-graph\.ts exceeded \d+ms timeout/,
      `expected timeout diagnostic, got: ${result.stderr}`,
    );
  });
});
