// @tier: integration
/**
 * R-CCPM-2: codex-manager-self-bootstrap-guard-claude-noop
 *
 * Verifies that checkIterationLogForCodexSelfBootstrap returns ZERO events
 * for claude-backend sessions, even when the log content contains setup.js
 * references that look like tool-calls.
 *
 * This protects against false positives from:
 *  - Claude sessions whose assistant text mentions setup.js (e.g., the worker
 *    prompt from spawn-morty.ts:459: "DO NOT explore harness internals (setup.js, ...)")
 *  - Claude stream-json lines with setup.js in text blocks (not tool_use)
 *  - Any non-codex backend
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIterationLogForCodexSelfBootstrap } from '../../bin/mux-runner.js';

const SETUP_PATH = '/home/user/.claude/pickle-rick/extension/bin/setup.js';

function makeStreamJsonToolUseLine(cmd) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: cmd } },
      ],
    },
  });
}

function makeStreamJsonTextLine(text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

const SPAWN_MORTY_459_WORKER_PROMPT_FRAGMENT =
  'DO NOT explore harness internals (`pickle.md`, `setup.js`, `send-to-morty.md`, `mux-runner.js`). ' +
  'Those are orchestrator-level. Your scope is exclusively the files listed in the ticket\'s "Files to modify" / "Files to create" sections.';

// ── claude backend returns empty array ───────────────────────────────────────

test('codex-manager-self-bootstrap-guard-claude-noop: claude backend → 0 events regardless of content', () => {
  const cmd = `node ${SETUP_PATH} --resume /tmp/session`;
  const output = makeStreamJsonToolUseLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'claude', 'ticket-abc', 1);
  assert.equal(results.length, 0, 'claude backend must never detect events');
});

test('codex-manager-self-bootstrap-guard-claude-noop: hermes backend → 0 events', () => {
  const cmd = `node ${SETUP_PATH} --resume /tmp/session`;
  const output = makeStreamJsonToolUseLine(cmd) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'hermes', null, 1);
  assert.equal(results.length, 0);
});

// ── worker-prompt false-positive (spawn-morty.ts:459 pattern) ───────────────

test('codex-manager-self-bootstrap-guard-claude-noop: claude stream-json setup.js text mention → 0 events', () => {
  const output = makeStreamJsonTextLine(SPAWN_MORTY_459_WORKER_PROMPT_FRAGMENT) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'claude', null, 1);
  assert.equal(results.length, 0, 'claude text mention of setup.js must not fire');
});

test('codex-manager-self-bootstrap-guard-claude-noop: codex stream-json text mention of setup.js → 0 events', () => {
  // Even on codex backend, a text block that mentions setup.js (not a tool_use) must not fire
  const output = makeStreamJsonTextLine(SPAWN_MORTY_459_WORKER_PROMPT_FRAGMENT) + '\n';
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', null, 1);
  assert.equal(results.length, 0, 'text mention of setup.js in codex session must not fire');
});

test('codex-manager-self-bootstrap-guard-claude-noop: plain-text log (delimiter drift) → 0 events', () => {
  // Plain-text logs are skipped entirely (detectOutputFormat returns plain-text)
  const output = `node ${SETUP_PATH} --resume /tmp/session\nI AM DONE\n`;
  const results = checkIterationLogForCodexSelfBootstrap(output, 'codex', null, 1);
  assert.equal(results.length, 0, 'plain-text log must be skipped even on codex backend');
});

test('codex-manager-self-bootstrap-guard-claude-noop: empty log → 0 events', () => {
  assert.equal(checkIterationLogForCodexSelfBootstrap('', 'codex', null, 1).length, 0);
  assert.equal(checkIterationLogForCodexSelfBootstrap('', 'claude', null, 1).length, 0);
});
