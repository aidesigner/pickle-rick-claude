// @tier: integration
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeCitadelPhase,
  __setCitadelRemediationDepsForTests,
} from '../bin/pipeline-runner.js';

const TMP_DIRS = new Set();

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-mech-skip-'));
  TMP_DIRS.add(dir);
  return dir;
}

function writeCitadelState(statePath, flags) {
  const dir = path.dirname(statePath);
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: dir,
    step: 'citadel',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'citadel mechanical skip test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
    exit_reason: null,
    prd_path: 'prd.md',
    start_commit: 'abc1234',
    backend: 'claude',
    activity: [],
    ...(flags ? { flags } : {}),
  }, null, 2));
}

function makeRuntime(dir) {
  return {
    sessionDir: dir,
    statePath: path.join(dir, 'state.json'),
    repoRoot: dir,
    workingDir: dir,
    extensionRoot: dir,
    backend: 'claude',
    phaseEnv: { ...process.env },
    log: () => {},
    config: {
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: dir,
      citadel_strict: false,
      dirty_exempt_segments: [],
    },
  };
}

function citadelResult(findings) {
  return {
    schema: '1.0',
    schema_version: '1.0',
    prd_path: 'prd.md',
    diff_range: 'abc1234..HEAD',
    exit_code: findings.length ? 2 : 0,
    exitCode: findings.length ? 2 : 0,
    header: { pickle_phase_failed: false, pickle_exit_code: 0 },
    sections: {},
    findings,
    decision_required: [],
    decisions: [],
    summary: {
      findings: findings.length, critical: 0, high: 0, medium: 0, low: 0,
      decision_required: 0, decisions: 0, unguarded_trap_doors: 0,
    },
    markdown: '',
    json: {},
  };
}

function captureRemediatorIds(captured) {
  return {
    loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
    spawnGateRemediatorMain: async ({ argv }) => {
      const idx = argv.indexOf('--gate-result');
      const gateResult = JSON.parse(fs.readFileSync(argv[idx + 1], 'utf-8'));
      captured.push(...gateResult.failures.map((f) => f.ruleOrCode));
      return 1;
    },
    spawnRemediator: () => { throw new Error('worker must not spawn in this test'); },
  };
}

afterEach(() => {
  __setCitadelRemediationDepsForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('B-CSOR T40 — skip_quality_gates_reason bypass (AC-5)', () => {
  test('a non-empty skip reason collapses the union to Critical-only (mechanical NOT remediated)', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'), { skip_quality_gates_reason: 'operator bypass test' });
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    const result = await executeCitadelPhase(makeRuntime(dir));

    assert.deepEqual(result, { exitCode: 0 });
    assert.ok(
      !captured.includes('banned-construct:brace-free-if:foo.ts:10'),
      'mechanical finding must NOT reach remediation when the bypass is set',
    );
  });

  test('emits exactly one gate_skipped (source citadel-mechanical, reason skip_quality_gates)', async () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeCitadelState(statePath, { skip_quality_gates_reason: 'operator bypass test' });
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    await executeCitadelPhase(makeRuntime(dir));

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const skips = (state.activity || []).filter((e) => e.event === 'gate_skipped' && e.source === 'citadel-mechanical');
    assert.equal(skips.length, 1, 'exactly one gate_skipped per phase invocation');
    assert.equal(skips[0].gate_payload.reason, 'skip_quality_gates');
    assert.equal(skips[0].gate_payload.detail, 'operator bypass test');
  });

  test('no skip reason → mechanical finding IS remediated and NO gate_skipped emitted', async () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeCitadelState(statePath, null);
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    await executeCitadelPhase(makeRuntime(dir));

    assert.ok(
      captured.includes('banned-construct:brace-free-if:foo.ts:10'),
      'baseline: mechanical finding reaches remediation when bypass absent',
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const skips = (state.activity || []).filter((e) => e.event === 'gate_skipped' && e.source === 'citadel-mechanical');
    assert.equal(skips.length, 0, 'no gate_skipped when bypass absent');
  });
});
