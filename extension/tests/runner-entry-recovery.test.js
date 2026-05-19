// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');

function makeSessionDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTmpOnlyState(sessionDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json.tmp.999999'),
    JSON.stringify({}, null, 2),
  );
}

function assertPromotesTmpOnlyState(scriptName, extraArgs = []) {
  const sessionDir = makeSessionDir(`runner-entry-${scriptName}-`);
  try {
    writeTmpOnlyState(sessionDir);
    const statePath = path.join(sessionDir, 'state.json');
    const result = spawnSync(
      process.execPath,
      [path.join(EXTENSION_ROOT, 'bin', scriptName), sessionDir, ...extraArgs],
      {
        cwd: EXTENSION_ROOT,
        encoding: 'utf-8',
        timeout: 5000,
      },
    );

    assert.notEqual(
      result.status,
      0,
      `${scriptName} should still fail later with invalid recovered state`,
    );
    assert.ok(
      !result.stderr.includes(`Usage: node ${scriptName}`),
      `${scriptName} should not reject a tmp-only recoverable session as missing state: ${result.stderr}`,
    );
    assert.equal(fs.existsSync(statePath), true, `${scriptName} must promote the recoverable state tmp`);
    assert.equal(
      fs.existsSync(path.join(sessionDir, 'state.json.tmp.999999')),
      false,
      `${scriptName} should consume the promoted tmp file`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('mux-runner CLI preflight promotes tmp-only recoverable state', () => {
  assertPromotesTmpOnlyState('mux-runner.js');
});

test('pipeline-runner CLI preflight promotes tmp-only recoverable state', () => {
  assertPromotesTmpOnlyState('pipeline-runner.js');
});

test('microverse-runner CLI preflight promotes tmp-only recoverable state', () => {
  assertPromotesTmpOnlyState('microverse-runner.js');
});
