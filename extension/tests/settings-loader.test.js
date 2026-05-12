// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkerTestGateTimeoutMs } from '../services/pickle-utils.js';

function withExtensionRoot(fn) {
  const extensionRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-settings-loader-')));
  try {
    return fn(extensionRoot);
  } finally {
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
}

test('settings-loader: default worker_test_gate_timeout_ms applies when key is absent', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      default_worker_timeout_seconds: 1200,
    }, null, 2));

    assert.equal(resolveWorkerTestGateTimeoutMs(extensionRoot), 240_000);
  });
});

test('settings-loader: override worker_test_gate_timeout_ms is honored', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 12_345,
    }, null, 2));

    assert.equal(resolveWorkerTestGateTimeoutMs(extensionRoot), 12_345);
  });
});
