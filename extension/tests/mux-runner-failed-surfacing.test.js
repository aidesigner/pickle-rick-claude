// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGateFailureSummary } from '../bin/mux-runner.js';

test('mux-runner: buildWorkerGateFailureSummary includes recent worker_gate_failed entries', () => {
  const summary = buildWorkerGateFailureSummary({
    activity: [
      {
        event: 'worker_gate_failed',
        ts: '2026-05-11T21:30:00.000Z',
        ticket_id: 'e5f6a7b8',
        gate_phase: 'test:fast',
        retry_count: 1,
        failures: [{
          name: 'worker fast tier fails',
          file: 'tests/worker-fixture.test.js',
          message: 'boom',
        }],
      },
    ],
  });

  assert.match(summary, /=== RECENT WORKER GATE FAILURES ===/);
  assert.match(summary, /worker_gate_failed ticket_id=e5f6a7b8 gate_phase=test:fast retry_count=1/);
  assert.match(summary, /tests\/worker-fixture\.test\.js: boom/);
});
