// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const muxRunnerSource = fs.readFileSync(path.resolve(__dirname, '../../src/bin/mux-runner.ts'), 'utf-8');

test('closer-handoff-terminal source: failed-handoff terminal detection is keyed by ticket id, head sha, and consecutive budget', () => {
  assert.match(muxRunnerSource, /type CloserTerminalDecision/);
  assert.match(muxRunnerSource, /status !== 'failed'/);
  assert.match(muxRunnerSource, /prior\.ticket_id === ticketId && prior\.head_sha === headSha/);
  assert.match(muxRunnerSource, /consecutive_failed_iterations:\s*consecutive/);
  assert.match(muxRunnerSource, /if \(consecutive >= args\.failedBudget\)/);
  assert.match(muxRunnerSource, /reason:\s*'closer_handoff_terminal'/);
});

test('closer-handoff-terminal source: done-plus-manager-handoff exits manager_handoff_pending', () => {
  assert.match(muxRunnerSource, /readLatestTicketConformanceSnapshot/);
  // The Manager Handoff detector was extracted into hasSubstantiveManagerHandoff()
  // — it carries the `^## Manager Handoff` regex and additionally rejects
  // "none"/"n/a"/empty bodies (F2 hardening). The conformance snapshot delegates
  // to it rather than matching an inline regex.
  assert.match(muxRunnerSource, /function hasSubstantiveManagerHandoff\(/);
  assert.match(muxRunnerSource, /\/\^##\\s\+Manager Handoff\\b/);
  assert.match(muxRunnerSource, /hasManagerHandoff:\s*hasSubstantiveManagerHandoff\(content\)/);
  assert.match(muxRunnerSource, /status === 'done' && conformance\.hasManagerHandoff/);
  assert.match(muxRunnerSource, /reason:\s*'manager_handoff_pending'/);
});

test('closer-handoff-terminal source: mux-runner checks closer terminal state at the iteration head and both completion exits', () => {
  const occurrences = [...muxRunnerSource.matchAll(/evaluateCloserTerminalState\(\{/g)].length;
  assert.equal(occurrences, 3, 'expected iteration-head and two completion-path checks');
  assert.match(muxRunnerSource, /persistCloserHandoffTracker\(statePath,\s*closerDecision\.tracker\)/);
  assert.match(muxRunnerSource, /exitForCloserTerminalState\(ctx\.statePath,\s*ctx\.sessionDir,\s*ctx\.iteration,\s*closerDecision,\s*ctx\.log\)/);
  assert.match(muxRunnerSource, /exitForCloserTerminalState\(statePath,\s*sessionDir,\s*iteration,\s*closerDecision,\s*log\)/);
});
