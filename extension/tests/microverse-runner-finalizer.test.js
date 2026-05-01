import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMicroverseHandoff,
  getBestScore,
  markMicroverseFatalError,
  measureAndClassifyIteration,
  writeFinalReport,
} from '../bin/microverse-runner.js';

function tmpDir(prefix = 'pickle-mv-finalizer-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function workerState() {
  return {
    status: 'iterating',
    prd_path: '/tmp/prd.md',
    key_metric: {
      description: 'worker review',
      validation: '',
      type: 'none',
      timeout_seconds: 1,
      tolerance: 0,
    },
    gap_analysis_path: '',
    failed_approaches: [],
    failure_history: [],
    baseline_score: 0,
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
  };
}

function metricStateWithoutConvergence() {
  return {
    ...workerState(),
    key_metric: {
      description: 'score',
      validation: 'printf "5\\n"',
      type: 'command',
      timeout_seconds: 1,
      tolerance: 0,
    },
    convergence_mode: 'metric',
  };
}

test('writeFinalReport handles worker-mode state without convergence history', () => {
  const sessionDir = tmpDir();
  try {
    assert.doesNotThrow(() => writeFinalReport(sessionDir, workerState(), 'converged', 1, 2));
    const report = fs.readFileSync(path.join(sessionDir, 'memory', fs.readdirSync(path.join(sessionDir, 'memory'))[0]), 'utf-8');
    assert.match(report, /Convergence Mode\*\*: worker/);
    assert.match(report, /Accepted\*\*: 0/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('buildMicroverseHandoff handles worker-mode state without convergence history', () => {
  const handoff = buildMicroverseHandoff(workerState(), 3, '/tmp/project', '/tmp/session');
  assert.match(handoff, /Convergence: Worker-Managed/);
  assert.match(handoff, /anatomy-park\.json/);
});

test('getBestScore returns null for worker-mode state without convergence history', () => {
  assert.equal(getBestScore(workerState()), null);
});

test('measureAndClassifyIteration throws an actionable assertion before last-accepted lookup in worker mode', async () => {
  const sessionDir = tmpDir();
  const workingDir = tmpDir('pickle-mv-work-');
  try {
    await assert.rejects(
      () => measureAndClassifyIteration(
        metricStateWithoutConvergence(),
        { raw: '0', score: 0 },
        {
          sessionDir,
          statePath: path.join(sessionDir, 'state.json'),
          extensionRoot: workingDir,
          workingDir,
          iteration: 1,
          currentRunnerState: {},
          log: () => {},
          enableFailureClassification: false,
        },
      ),
      /measureAndClassifyIteration called in worker mode without metric convergence state/,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('markMicroverseFatalError preserves a successful exit reason and writes sibling finalizer error', () => {
  const sessionDir = tmpDir();
  const mvPath = path.join(sessionDir, 'microverse.json');
  try {
    fs.writeFileSync(mvPath, JSON.stringify({
      status: 'converged',
      exit_reason: 'converged',
      prd_path: '/tmp/prd.md',
    }, null, 2));

    assert.equal(markMicroverseFatalError(sessionDir), 'preserved');
    const mv = JSON.parse(fs.readFileSync(mvPath, 'utf-8'));
    assert.equal(mv.status, 'converged');
    assert.equal(mv.exit_reason, 'converged');

    const sibling = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), 'utf-8'));
    assert.equal(sibling.exit_reason, 'error');
    assert.equal(sibling.preserved_exit_reason, 'converged');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
