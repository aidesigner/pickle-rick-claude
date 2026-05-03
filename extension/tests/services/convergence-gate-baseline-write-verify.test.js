// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaselineWriteFailedError, runGate } from '../../services/convergence-gate.js';

test('runGate baseline: verifies captured baseline is accessible on disk after write', async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-access-'));
  const originalAccess = fs.promises.access;
  try {
    fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');

    fs.promises.access = async (target, ...args) => {
      if (target === baselinePath) {
        const err = new Error('simulated post-write access failure');
        err.code = 'ENOENT';
        throw err;
      }
      return originalAccess.call(fs.promises, target, ...args);
    };

    await assert.rejects(
      runGate({
        workingDir,
        mode: 'baseline',
        scope: 'full',
        checks: [],
        baselinePath,
      }),
      (err) => {
        assert.ok(err instanceof BaselineWriteFailedError, `expected BaselineWriteFailedError, got ${err?.constructor?.name}`);
        assert.equal(err.kind, 'BASELINE_WRITE_FAILED');
        assert.equal(err.baselinePath, baselinePath);
        assert.match(err.message, /simulated post-write access failure/);
        assert.ok(err.cause instanceof Error);
        return true;
      },
    );
  } finally {
    fs.promises.access = originalAccess;
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
