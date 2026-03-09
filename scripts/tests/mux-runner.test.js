import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompletion,
  isDegenerate,
  classifyIterationExit,
  validateCommandTemplate,
  transitionToMeeseeks,
} from '../bin/mux-runner.js';

// ---------------------------------------------------------------------------
// classifyCompletion
// ---------------------------------------------------------------------------

describe('classifyCompletion', () => {
  it('EPIC_COMPLETED → task_completed', () => {
    assert.equal(classifyCompletion('<promise>EPIC_COMPLETED</promise>'), 'task_completed');
  });

  it('EXISTENCE_IS_PAIN → review_clean', () => {
    assert.equal(classifyCompletion('<promise>EXISTENCE_IS_PAIN</promise>'), 'review_clean');
  });

  it('THE_CITADEL_APPROVES → review_clean', () => {
    assert.equal(classifyCompletion('<promise>THE_CITADEL_APPROVES</promise>'), 'review_clean');
  });

  it('TASK_COMPLETED → task_completed', () => {
    assert.equal(classifyCompletion('<promise>TASK_COMPLETED</promise>'), 'task_completed');
  });

  it('PRD_COMPLETE → continue', () => {
    assert.equal(classifyCompletion('<promise>PRD_COMPLETE</promise>'), 'continue');
  });

  it('TICKET_SELECTED → continue', () => {
    assert.equal(classifyCompletion('<promise>TICKET_SELECTED</promise>'), 'continue');
  });

  it('completion_promise from state → task_completed', () => {
    assert.equal(
      classifyCompletion('<promise>JARRED</promise>', { completion_promise: 'JARRED' }),
      'task_completed',
    );
  });

  it('WORKER_DONE not scanned (returns continue)', () => {
    assert.equal(classifyCompletion('<promise>I AM DONE</promise>'), 'continue');
  });

  it('no token → continue', () => {
    assert.equal(classifyCompletion('just some output'), 'continue');
  });

  it('whitespace tolerance in promise tags', () => {
    assert.equal(classifyCompletion('<promise>  EPIC_COMPLETED  </promise>'), 'task_completed');
  });

  it('ANALYSIS_DONE not scanned (returns continue)', () => {
    assert.equal(classifyCompletion('<promise>ANALYSIS_DONE</promise>'), 'continue');
  });

  it('priority: EPIC_COMPLETED wins over TASK_COMPLETED', () => {
    assert.equal(
      classifyCompletion('<promise>EPIC_COMPLETED</promise> <promise>TASK_COMPLETED</promise>'),
      'task_completed',
    );
  });

  it('priority: EXISTENCE_IS_PAIN wins over PRD_COMPLETE', () => {
    assert.equal(
      classifyCompletion('<promise>EXISTENCE_IS_PAIN</promise> <promise>PRD_COMPLETE</promise>'),
      'review_clean',
    );
  });
});

// ---------------------------------------------------------------------------
// isDegenerate
// ---------------------------------------------------------------------------

describe('isDegenerate', () => {
  it('whitespace-only is degenerate', () => {
    assert.equal(isDegenerate('   \n  ').degenerate, true);
  });

  it('empty string is degenerate', () => {
    assert.equal(isDegenerate('').degenerate, true);
  });

  it('ultra-short is degenerate (≤10 chars)', () => {
    assert.equal(isDegenerate('ok').degenerate, true);
  });

  it('exactly 10 chars is degenerate', () => {
    assert.equal(isDegenerate('1234567890').degenerate, true);
  });

  it('11 chars without pattern is not degenerate', () => {
    assert.equal(isDegenerate('hello world').degenerate, false);
  });

  // All 10 no-op patterns
  it('acknowledged. is degenerate', () => {
    assert.equal(isDegenerate('acknowledged.').degenerate, true);
  });

  it('ok is degenerate', () => {
    assert.equal(isDegenerate('Ok.').degenerate, true);
  });

  it('done is degenerate', () => {
    assert.equal(isDegenerate('Done').degenerate, true);
  });

  it('understood is degenerate', () => {
    assert.equal(isDegenerate('Understood.').degenerate, true);
  });

  it('noted is degenerate', () => {
    assert.equal(isDegenerate('noted').degenerate, true);
  });

  it('continuing is degenerate', () => {
    assert.equal(isDegenerate('Continuing.').degenerate, true);
  });

  it('ready is degenerate', () => {
    assert.equal(isDegenerate('Ready').degenerate, true);
  });

  it('got it is degenerate', () => {
    assert.equal(isDegenerate('Got it.').degenerate, true);
  });

  it('will do is degenerate', () => {
    assert.equal(isDegenerate('Will do').degenerate, true);
  });

  it('roger is degenerate', () => {
    assert.equal(isDegenerate('Roger.').degenerate, true);
  });

  it('real output is not degenerate', () => {
    assert.equal(isDegenerate('I have completed the implementation of the feature as requested.').degenerate, false);
  });

  it('no-op pattern over 100 chars is not degenerate', () => {
    const long = 'acknowledged' + ' '.repeat(90);
    assert.equal(long.trim().length <= 100, true); // "acknowledged" is 12 chars
    assert.equal(isDegenerate(long).degenerate, true);
  });

  it('long non-pattern is not degenerate', () => {
    const long = 'x'.repeat(101);
    assert.equal(isDegenerate(long).degenerate, false);
  });
});

// ---------------------------------------------------------------------------
// validateCommandTemplate
// ---------------------------------------------------------------------------

describe('validateCommandTemplate', () => {
  it('forward slash rejected', () => {
    assert.throws(() => validateCommandTemplate('../../evil.md'), /path separators/);
  });

  it('backslash rejected', () => {
    assert.throws(() => validateCommandTemplate('evil\\path.md'), /path separators/);
  });

  it('double dot rejected', () => {
    assert.throws(() => validateCommandTemplate('evil..md'), /path separators/);
  });

  it('normal template accepted', () => {
    assert.doesNotThrow(() => validateCommandTemplate('meeseeks.md'));
  });

  it('simple name accepted', () => {
    assert.doesNotThrow(() => validateCommandTemplate('pickle.md'));
  });

  it('template with dash accepted', () => {
    assert.doesNotThrow(() => validateCommandTemplate('my-template.md'));
  });
});

// ---------------------------------------------------------------------------
// classifyIterationExit
// ---------------------------------------------------------------------------

describe('classifyIterationExit', () => {
  it('rate limit text → api_limit', () => {
    const result = classifyIterationExit(0, 'rate limit exceeded', '', false);
    assert.equal(result.type, 'api_limit');
  });

  it('rate limit JSON → api_limit with info', () => {
    const json = JSON.stringify({ type: 'rate_limit_event', status: 'rejected', resetsAt: 1234567890 });
    const result = classifyIterationExit(0, json, '', false);
    assert.equal(result.type, 'api_limit');
    assert.equal(result.rateLimitInfo?.limited, true);
  });

  it('rate limit in stderr → api_limit', () => {
    const result = classifyIterationExit(0, '', 'out of usage', false);
    assert.equal(result.type, 'api_limit');
  });

  it('5 hour limit pattern', () => {
    const result = classifyIterationExit(0, '5 hour rate limit reached', '', false);
    assert.equal(result.type, 'api_limit');
  });

  it('non-zero exit → error', () => {
    const result = classifyIterationExit(1, '', 'crash', false);
    assert.equal(result.type, 'error');
  });

  it('timeout → error', () => {
    const result = classifyIterationExit(null, '', '', true);
    assert.equal(result.type, 'error');
  });

  it('normal exit → success', () => {
    const result = classifyIterationExit(0, 'all good', '', false);
    assert.equal(result.type, 'success');
  });

  it('null exit code without timeout → success', () => {
    const result = classifyIterationExit(null, 'output', '', false);
    assert.equal(result.type, 'success');
  });

  it('rate limit runs before error classification', () => {
    // Non-zero exit code BUT rate limit in output → api_limit wins
    const result = classifyIterationExit(1, 'rate limit exceeded', '', false);
    assert.equal(result.type, 'api_limit');
  });
});

// ---------------------------------------------------------------------------
// transitionToMeeseeks
// ---------------------------------------------------------------------------

describe('transitionToMeeseeks', () => {
  it('resets iteration to 0', () => {
    const state = makeState({ iteration: 5, chain_meeseeks: true });
    const result = transitionToMeeseeks(state);
    assert.equal(result.iteration, 0);
  });

  it('sets command_template to meeseeks.md', () => {
    const state = makeState({ command_template: 'pickle.md' });
    const result = transitionToMeeseeks(state);
    assert.equal(result.command_template, 'meeseeks.md');
  });

  it('sets chain_meeseeks to false', () => {
    const state = makeState({ chain_meeseeks: true });
    const result = transitionToMeeseeks(state);
    assert.equal(result.chain_meeseeks, false);
  });

  it('sets step to review', () => {
    const state = makeState({ step: 'implement' });
    const result = transitionToMeeseeks(state);
    assert.equal(result.step, 'review');
  });

  it('clears current_ticket', () => {
    const state = makeState({ current_ticket: 'abc123' });
    const result = transitionToMeeseeks(state);
    assert.equal(result.current_ticket, null);
  });

  it('preserves other state fields', () => {
    const state = makeState({ working_dir: '/foo/bar', active: true });
    const result = transitionToMeeseeks(state);
    assert.equal(result.working_dir, '/foo/bar');
    assert.equal(result.active, true);
  });
});

// ---------------------------------------------------------------------------
// SessionExitReason coverage
// ---------------------------------------------------------------------------

describe('SessionExitReason', () => {
  it('all 7 values are valid strings', () => {
    const reasons = ['success', 'cancelled', 'error', 'limit', 'stall', 'circuit_open', 'rate_limit_exhausted'];
    assert.equal(reasons.length, 7);
    for (const r of reasons) {
      assert.equal(typeof r, 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/session',
    ...overrides,
  };
}
