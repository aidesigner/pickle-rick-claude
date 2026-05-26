// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isModeMatchError, render, checkAndSwapMode } from '../bin/monitor.js';

function makeSession() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mmm-')));
}

function writeState(sessionDir, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    step: 'implement',
    schema_version: 4,
    ...overrides,
  }));
}

/**
 * Minimal MonitorWriteSink that discards output and always signals success.
 */
function makeNoopSink() {
  return {
    write(_chunk, cb) {
      if (typeof cb === 'function') cb(null);
      return true;
    },
    once(_event, _listener) { return {}; },
    off(_event, _listener) {},
  };
}

// --- R-MWCL-2 isModeMatchError unit tests ---

test('R-MWCL-2 isModeMatchError: TypeError is recoverable', () => {
  assert.equal(
    isModeMatchError(new TypeError("Cannot read properties of undefined (reading 'tickets')")),
    true,
    'TypeError must be classified as recoverable mode-mismatch',
  );
  assert.equal(
    isModeMatchError(new TypeError('mode field missing')),
    true,
    'any TypeError must be classified as recoverable',
  );
});

test('R-MWCL-2 isModeMatchError: non-TypeError is not recoverable', () => {
  assert.equal(isModeMatchError(new Error('ENOENT: no such file or directory')), false, 'plain Error is not recoverable');
  assert.equal(isModeMatchError(new RangeError('invalid array length')), false, 'RangeError is not recoverable');
  assert.equal(isModeMatchError('string error'), false, 'string is not recoverable');
  assert.equal(isModeMatchError(null), false, 'null is not recoverable');
});

// --- R-MWCL-2 render() classification tests ---

test('R-MWCL-2 render: TypeError from renderDashboard returns false and writes [render-mode-mismatch]', async () => {
  const sessionDir = makeSession();
  try {
    writeState(sessionDir, { command_template: 'szechuan-sauce.md' });

    const stderrLines = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return originalWrite(chunk, ...args);
    };

    let result;
    try {
      const typeerror = new TypeError("Cannot read properties of undefined (reading 'tickets')");
      result = await render(sessionDir, 'pickle', makeNoopSink(), () => { throw typeerror; });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(result, false, 'render must return false on mode-mismatch TypeError');
    assert.ok(
      stderrLines.some((l) => l.includes('[render-mode-mismatch]')),
      `expected [render-mode-mismatch] tag in stderr, got: ${JSON.stringify(stderrLines)}`,
    );
    assert.ok(
      stderrLines.some((l) => l.includes("Cannot read properties of undefined (reading 'tickets')")),
      'expected TypeError message text in stderr',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-MWCL-2 render: non-TypeError from renderDashboard is rethrown', async () => {
  const sessionDir = makeSession();
  try {
    writeState(sessionDir, {});
    const ioError = new Error('ENOENT: no such file or directory, stat /missing/state.json');

    await assert.rejects(
      () => render(sessionDir, 'pickle', makeNoopSink(), () => { throw ioError; }),
      (err) => {
        assert.equal(err, ioError, 'rethrown error must be the original error object (not wrapped)');
        return true;
      },
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// --- R-MWCL-2 AC-4: mode-swap sequence ---

test('R-MWCL-2 mode-swap sequence: render false → checkAndSwapMode swaps → next render succeeds', async () => {
  const sessionDir = makeSession();
  try {
    writeState(sessionDir, {
      active: true,
      step: 'szechuan-sauce',
      command_template: 'szechuan-sauce.md',
      session_dir: sessionDir,
    });

    // Step 1: render with wrong mode (pickle) — injected TypeError → returns false
    const typeerror = new TypeError("Cannot read properties of undefined (reading 'tickets')");
    const active1 = await render(sessionDir, 'pickle', makeNoopSink(), () => { throw typeerror; });
    assert.equal(active1, false, 'render must return false when mode-mismatch TypeError is thrown');

    // Step 2: checkAndSwapMode detects szechuan-sauce step and returns microverse
    const logCapture = [];
    const newMode = checkAndSwapMode(sessionDir, 'pickle', (e) => logCapture.push(e));
    assert.equal(newMode, 'microverse', 'checkAndSwapMode must swap to microverse for szechuan-sauce step');
    assert.equal(logCapture.length, 1, 'must emit exactly one monitor_mode_swapped event');
    assert.equal(logCapture[0].event, 'monitor_mode_swapped');
    assert.equal(logCapture[0].mode, 'microverse');

    // Step 3: render with correct mode (microverse) and no injected error — must succeed
    const active2 = await render(sessionDir, newMode, makeNoopSink());
    assert.equal(active2, true, 'render with correct microverse mode must return state.active (true)');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
