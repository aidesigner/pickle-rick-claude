// @tier: fast
/**
 * R-CCPM-2 format-snapshot: pins the two known codex output shapes that
 * observeCodexToolCallStream must parse. If the codex CLI bumps and renames
 * tool_call → tool_use in its stream-json format, this test catches it.
 *
 * Shape A (stream-json / Anthropic SDK style):
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node setup.js ..."}}]}}
 *
 * Shape B (codex-block content line / JSON with name+parameters):
 *   {"name":"Bash","parameters":{"command":"node setup.js ..."}}
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeCodexToolCallStream } from '../bin/mux-runner.js';

const SETUP_CMD = 'node /home/user/.claude/pickle-rick/extension/bin/setup.js --resume /tmp/session-abc';

// ── stream-json shape ────────────────────────────────────────────────────────

test('codex-tool-call-observer-format-snapshot: stream-json Anthropic-SDK tool_use', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Bash',
          input: { command: SETUP_CMD },
        },
      ],
    },
  });
  const result = observeCodexToolCallStream(line, 'stream-json');
  assert.ok(result !== null, 'must not return null for Bash tool_use line');
  assert.equal(result.isSetupInvocation, true);
  assert.ok(result.argv.some(a => a.includes('setup.js')), 'argv must contain setup.js');
});

test('codex-tool-call-observer-format-snapshot: stream-json non-setup.js Bash call returns isSetupInvocation false', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'Bash',
          input: { command: 'npx tsc --noEmit' },
        },
      ],
    },
  });
  const result = observeCodexToolCallStream(line, 'stream-json');
  assert.ok(result !== null, 'must not return null for non-setup.js Bash call');
  assert.equal(result.isSetupInvocation, false);
});

test('codex-tool-call-observer-format-snapshot: stream-json non-Bash tool_use returns null', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_03',
          name: 'ReadFile',
          input: { path: '/tmp/foo' },
        },
      ],
    },
  });
  const result = observeCodexToolCallStream(line, 'stream-json');
  assert.equal(result, null, 'non-Bash tool must return null');
});

test('codex-tool-call-observer-format-snapshot: stream-json text-only assistant message returns null', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'node setup.js looks like a bootstrap' }],
    },
  });
  const result = observeCodexToolCallStream(line, 'stream-json');
  assert.equal(result, null, 'text mention of setup.js must not trigger');
});

test('codex-tool-call-observer-format-snapshot: stream-json malformed JSON returns null', () => {
  const result = observeCodexToolCallStream('{bad json', 'stream-json');
  assert.equal(result, null);
});

// ── codex-block shape ────────────────────────────────────────────────────────

test('codex-tool-call-observer-format-snapshot: codex-block JSON name+parameters', () => {
  const line = JSON.stringify({
    name: 'Bash',
    parameters: { command: SETUP_CMD },
  });
  const result = observeCodexToolCallStream(line, 'codex-block');
  assert.ok(result !== null, 'must not return null for Bash+setup.js codex-block JSON');
  assert.equal(result.isSetupInvocation, true);
  assert.ok(result.argv.some(a => a.includes('setup.js')));
});

test('codex-tool-call-observer-format-snapshot: codex-block plain-text setup.js invocation', () => {
  const result = observeCodexToolCallStream(SETUP_CMD, 'codex-block');
  assert.ok(result !== null, 'must not return null for plain-text setup.js line');
  assert.equal(result.isSetupInvocation, true);
  assert.ok(result.argv.some(a => a.includes('setup.js')));
});

test('codex-tool-call-observer-format-snapshot: codex-block plain-text non-setup.js returns null', () => {
  const result = observeCodexToolCallStream('node mux-runner.js --session /tmp/s', 'codex-block');
  assert.equal(result, null, 'non-setup.js plain-text must return null');
});

test('codex-tool-call-observer-format-snapshot: codex-block empty line returns null', () => {
  assert.equal(observeCodexToolCallStream('', 'codex-block'), null);
  assert.equal(observeCodexToolCallStream('   ', 'codex-block'), null);
});
