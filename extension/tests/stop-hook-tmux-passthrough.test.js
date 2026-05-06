// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDecision } from '../hooks/handlers/stop-hook.js';

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 2,
    max_iterations: 0,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-stop-hook',
    tmux_mode: true,
    ...overrides,
  };
}

test('tmux passthrough: default fallthrough approves when tmux owns the loop', () => {
  const result = classifyDecision(baseState(), 'Still working on the ticket.', '');
  assert.equal(result.decision, 'approve');
  assert.equal(result.logMessage, 'Decision: APPROVE (tmux owns this loop, launcher may stop)');
});
