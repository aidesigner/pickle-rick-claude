// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runBetweenTicketFastGate } from '../bin/mux-runner.js';

function makeRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(root) {
  const sessionDir = path.join(root, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'between-ticket gate',
    current_ticket: 'bbbb2222',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: sessionDir,
    activity: [],
  }, null, 2));
  mkdirSync(path.join(root, 'extension'), { recursive: true });
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '',
    '# Body',
  ].join('\n'));
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

test('mux-runner-between-ticket-gate: Done prior ticket emits cross_ticket_regression_detected and persists state', () => {
  const root = makeRoot('pickle-mux-between-done-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    const result = runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 1234,
      runTestFast: () => ({
        ok: false,
        failures: [{
          name: 'boundary detection fires',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    assert.deepEqual(result, {
      ok: false,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 1234,
      ok: false,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const event = state.activity.find((entry) => entry.event === 'cross_ticket_regression_detected');
    assert.deepEqual(event, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(1234).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      failing_tests: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: Failed prior ticket does not emit cross_ticket_regression_detected', () => {
  const root = makeRoot('pickle-mux-between-failed-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Failed');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Failed',
      log: () => {},
      now: () => 5678,
      runTestFast: () => ({
        ok: false,
        failures: [{
          name: 'no false fire when prior Failed',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 5678,
      ok: false,
      failures: [{
        name: 'no false fire when prior Failed',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
    assert.equal(
      state.activity.some((entry) => entry.event === 'cross_ticket_regression_detected'),
      false,
      `unexpected cross_ticket_regression_detected in ${JSON.stringify(state.activity)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
