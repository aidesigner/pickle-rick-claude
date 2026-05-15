// @tier: integration
/**
 * R-CCPM-2: codex-manager-self-bootstrap-guard
 *
 * Verifies that checkIterationLogForCodexSelfBootstrap detects exactly one
 * codex_manager_self_bootstrap_attempted event when a codex stream-json log
 * contains a Bash tool-call invoking setup.js.
 *
 * Covers:
 *  - stream-json format: exactly 1 detection, correct argv
 *  - codex-block format: exactly 1 detection, correct argv
 *  - two invocations in one log: count=2
 *  - non-setup.js Bash call: count=0
 *  - event payload shape: ticket + iteration fields populated correctly
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIterationLogForCodexSelfBootstrap } from '../../bin/mux-runner.js';

const SETUP_PATH = '/home/user/.claude/pickle-rick/extension/bin/setup.js';
const RESUME_ARG = '/tmp/session-abc123';

function makeStreamJsonLine(cmd) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: cmd } },
      ],
    },
  });
}

function makeCodexBlockLog(cmd) {
  return [
    'user',
    'You are Morty. Implement ticket abc.',
    '',
    'codex',
    'I will now re-launch the session.',
    '',
    'tool_call',
    cmd,
    '',
    'tokens used',
    '1234',
  ].join('\n');
}

// ── stream-json detection ────────────────────────────────────────────────────

test('codex-manager-self-bootstrap-guard: stream-json setup.js call → count=1, argv matches', () => {
  const cmd = `node ${SETUP_PATH} --resume ${RESUME_ARG}`;
  const output = makeStreamJsonLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-abc', 3);
  assert.equal(results.length, 1, 'exactly one detection expected');
  assert.equal(results[0].ticket, 'ticket-abc');
  assert.equal(results[0].iteration, 3);
  assert.ok(
    results[0].attempted_argv.some(a => a.includes('setup.js')),
    `argv must include setup.js: ${JSON.stringify(results[0].attempted_argv)}`,
  );
  assert.ok(
    results[0].attempted_argv.some(a => a === RESUME_ARG),
    `argv must include resume path: ${JSON.stringify(results[0].attempted_argv)}`,
  );
});

test('codex-manager-self-bootstrap-guard: stream-json two setup.js calls → count=2', () => {
  const cmd = `node ${SETUP_PATH} --resume ${RESUME_ARG}`;
  const output = makeStreamJsonLine(cmd) + '\n' + makeStreamJsonLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-abc', 1);
  assert.equal(results.length, 2);
});

test('codex-manager-self-bootstrap-guard: stream-json non-setup.js Bash call → count=0', () => {
  const cmd = 'npx tsc --noEmit';
  const output = makeStreamJsonLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-abc', 1);
  assert.equal(results.length, 0);
});

test('codex-manager-self-bootstrap-guard: stream-json null ticket propagates correctly', () => {
  const cmd = `node ${SETUP_PATH}`;
  const output = makeStreamJsonLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', null, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].ticket, null);
});

// ── codex-block detection ────────────────────────────────────────────────────

test('codex-manager-self-bootstrap-guard: codex-block plain-text setup.js → count=1', () => {
  const cmd = `node ${SETUP_PATH} --resume ${RESUME_ARG}`;
  const output = makeCodexBlockLog(cmd);
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-xyz', 2);
  assert.equal(results.length, 1);
  assert.ok(results[0].attempted_argv.some(a => a.includes('setup.js')));
});

test('codex-manager-self-bootstrap-guard: codex-block JSON parameters setup.js → count=1', () => {
  const cmd = `node ${SETUP_PATH} --resume ${RESUME_ARG}`;
  const jsonLine = JSON.stringify({ name: 'Bash', parameters: { command: cmd } });
  const output = makeCodexBlockLog(jsonLine);
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-xyz', 2);
  assert.equal(results.length, 1);
});

test('codex-manager-self-bootstrap-guard: codex-block non-setup.js content → count=0', () => {
  const output = makeCodexBlockLog('node mux-runner.js --help');
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'ticket-xyz', 1);
  assert.equal(results.length, 0);
});

// ── event payload shape ──────────────────────────────────────────────────────

test('codex-manager-self-bootstrap-guard: result shape matches codex_manager_self_bootstrap_attempted schema', () => {
  const cmd = `node ${SETUP_PATH} --resume ${RESUME_ARG}`;
  const output = makeStreamJsonLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', 'abc12345', 7);
  assert.equal(results.length, 1);
  const obs = results[0];
  assert.ok('attempted_argv' in obs, 'must have attempted_argv');
  assert.ok('ticket' in obs, 'must have ticket');
  assert.ok('iteration' in obs, 'must have iteration');
  assert.equal(obs.iteration, 7);
  assert.equal(obs.ticket, 'abc12345');
  assert.ok(Array.isArray(obs.attempted_argv));
  assert.ok(obs.attempted_argv.length > 0);
});
