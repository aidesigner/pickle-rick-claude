import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assignOccurrenceIndices,
  BaselineWriteFailedError,
  runGate,
  subtractBaseline,
} from '../../services/convergence-gate.js';

function makeFailure(file, ruleOrCode, line, occurrence_index = 0) {
  return { check: 'lint', file, line, ruleOrCode, message: 'test', severity: 'error', occurrence_index };
}

function makeBaseline(failures) {
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: '/tmp',
    project_type: 'npm',
    checks: ['lint'],
    failures,
  };
}

test('assignOccurrenceIndices: assigns 0-based indices per (file, ruleOrCode), sorted by line', () => {
  const failures = [
    makeFailure('foo.ts', 'prefer-const', 20),
    makeFailure('foo.ts', 'prefer-const', 5),
    makeFailure('foo.ts', 'no-unused-vars', 10),
  ];
  const result = assignOccurrenceIndices(failures);
  const preferConst = result.filter(f => f.ruleOrCode === 'prefer-const').sort((a, b) => a.line - b.line);
  assert.equal(preferConst[0].occurrence_index, 0, 'line 5 gets index 0');
  assert.equal(preferConst[1].occurrence_index, 1, 'line 20 gets index 1');
  const noUnused = result.find(f => f.ruleOrCode === 'no-unused-vars');
  assert.equal(noUnused.occurrence_index, 0, 'single entry gets index 0');
});

test('subtractBaseline: occurrence_index fingerprinting — only new instance flagged', () => {
  // Baseline has 1 occurrence of prefer-const (occurrence_index 0)
  const baseline = makeBaseline([makeFailure('foo.ts', 'prefer-const', 5, 0)]);
  // Current has 2 occurrences; index 0 subtracts, index 1 is new
  const current = [
    makeFailure('foo.ts', 'prefer-const', 5, 0),
    makeFailure('foo.ts', 'prefer-const', 20, 1),
  ];
  const result = subtractBaseline(current, baseline);
  assert.equal(result.length, 1, 'only 1 new failure');
  assert.equal(result[0].line, 20);
  assert.equal(result[0].occurrence_index, 1);
});

test('subtractBaseline: file-deleted entries are auto-satisfied', () => {
  const baseline = makeBaseline([makeFailure('foo.ts', 'prefer-const', 5, 0)]);
  // Current is empty — file was deleted, no failures reported
  const result = subtractBaseline([], baseline);
  assert.equal(result.length, 0, 'no new failures when file is gone');
});

test('subtractBaseline: subtract is order-independent', () => {
  const baseline = makeBaseline([
    makeFailure('a.ts', 'rule-x', 1, 0),
    makeFailure('b.ts', 'rule-y', 2, 0),
  ]);
  // Current in reversed order, plus a new failure
  const current = [
    makeFailure('b.ts', 'rule-y', 2, 0),
    makeFailure('a.ts', 'rule-x', 1, 0),
    makeFailure('c.ts', 'rule-z', 3, 0),
  ];
  const result = subtractBaseline(current, baseline);
  assert.equal(result.length, 1, 'only the new failure remains');
  assert.equal(result[0].file, 'c.ts');
});

test('runGate baseline: emits disk diagnostics and leaves baseline on disk', async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-disk-'));
  const events = [];
  try {
    fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: [],
      baselinePath,
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green');
    assert.equal(fs.existsSync(baselinePath), true, 'baseline file must remain on disk after green baseline capture');
    assert.ok(
      events.some(e => e.event === 'gate_baseline_disk_check' && e.data.phase === 'pre_write' && e.data.exists === false),
      `expected missing pre-write diagnostic, got ${JSON.stringify(events)}`,
    );
    assert.ok(
      events.some(e => e.event === 'gate_baseline_disk_check' && e.data.phase === 'post_write' && e.data.exists === true),
      `expected present post-write diagnostic, got ${JSON.stringify(events)}`,
    );
    assert.ok(
      events.some(e => e.event === 'gate_baseline_captured'),
      `expected baseline capture event, got ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('runGate baseline: filesystem persistence failure throws BaselineWriteFailedError', async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-fs-fail-'));
  try {
    fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
    const blockedParent = path.join(workingDir, 'session');
    fs.writeFileSync(blockedParent, 'not a directory');

    await assert.rejects(
      runGate({
        workingDir,
        mode: 'baseline',
        scope: 'full',
        checks: [],
        baselinePath: path.join(blockedParent, 'gate', 'baseline.json'),
      }),
      (err) => {
        assert.ok(err instanceof BaselineWriteFailedError, `expected BaselineWriteFailedError, got ${err?.constructor?.name}`);
        assert.equal(err.kind, 'BASELINE_WRITE_FAILED');
        assert.match(err.message, /Failed to persist baseline/);
        assert.ok(err.cause instanceof Error);
        return true;
      },
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
