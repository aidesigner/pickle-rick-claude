// @tier: fast
// R-PVTA-2 — AC-gate tool-preflight: missing NON_GUARANTEED_TOOLS tools produce a
// /tool not installed/ failure; present tools let the command spawn normally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcPhaseGate, AC_PHASE_MANIFEST } from '../../services/ac-phase-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JQ_CRITERION = {
  id: 'test-jq-preflight',
  evaluation_phase: 'bundle-end',
  command: ['jq', '.x', 'f.json'],
};

function withTempSession(fn) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gate-preflight-'));
  const savedPath = process.env.PATH;
  try {
    return fn(sessionDir, savedPath);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function writeManifest(sessionDir, criteria) {
  fs.writeFileSync(
    path.join(sessionDir, AC_PHASE_MANIFEST),
    JSON.stringify({ acceptance_criteria: criteria }),
  );
}

test('AC-gate tool-preflight: jq absent in PATH yields tool not installed failure', () => {
  withTempSession((sessionDir) => {
    writeManifest(sessionDir, [JQ_CRITERION]);

    // Empty PATH directory — nothing is executable here
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-path-'));
    try {
      process.env.PATH = emptyDir;

      const result = runAcPhaseGate({
        sessionDir,
        evaluationPhase: 'bundle-end',
        cwd: sessionDir,
      });

      assert.equal(result.status, 'fail');
      const failure = result.failures.find((f) => f.id === 'test-jq-preflight');
      assert.ok(failure, 'expected a failure for test-jq-preflight');
      assert.match(failure.reason, /tool not installed: jq/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

test('AC-gate tool-preflight: jq present in PATH does not produce tool-not-installed failure', () => {
  withTempSession((sessionDir) => {
    writeManifest(sessionDir, [JQ_CRITERION]);

    // Fake jq that exits 0 — enough for the tool-presence check to pass
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-path-'));
    try {
      const fakeJq = path.join(fakeDir, 'jq');
      fs.writeFileSync(fakeJq, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakeJq, 0o755);

      process.env.PATH = fakeDir;

      const result = runAcPhaseGate({
        sessionDir,
        evaluationPhase: 'bundle-end',
        cwd: sessionDir,
      });

      // The command may fail (jq args, missing file) but NOT with "tool not installed"
      const toolNotInstalledFailure = (result.failures ?? []).find(
        (f) => f.id === 'test-jq-preflight' && /tool not installed: jq/.test(f.reason),
      );
      assert.equal(
        toolNotInstalledFailure,
        undefined,
        `Expected no "tool not installed: jq" failure but got: ${JSON.stringify(toolNotInstalledFailure)}`,
      );
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
