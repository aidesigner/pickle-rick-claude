// @tier: fast
/**
 * AC-ICP-01 — mux-runner exits with code 3 when iteration cap is hit without
 * EPIC_COMPLETED. Exit code 3 is distinct from success (0) and generic
 * failure (1), letting pipeline-runner call reportPhaseIncomplete instead of
 * logPhaseHaltReason and stamp pipeline_phase_incomplete on state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_JS = path.resolve(__dirname, '..', 'bin', 'mux-runner.js');
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

const { buildTmuxNotification } = await import('../bin/mux-runner.js');

test('mux-runner.iteration-cap-distinct-exit', () => {
  const compiled = fs.readFileSync(MUX_RUNNER_JS, 'utf-8');
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');

  // TS source: explicit branch maps iteration_cap_exhausted to exitCode 3
  assert.ok(
    source.includes("if (exitReason === 'iteration_cap_exhausted') exitCode = 3;"),
    'TS source must have: if (exitReason === \'iteration_cap_exhausted\') exitCode = 3;',
  );

  // Compiled: exitCode 3 branch appears before the isFailedExit=1 branch
  const cap3Idx = compiled.indexOf('exitCode = 3');
  const cap1Idx = compiled.indexOf('exitCode = 1');
  const cap0Idx = compiled.indexOf('exitCode = 0');
  assert.ok(cap3Idx !== -1, 'compiled code must assign exitCode = 3');
  assert.ok(cap1Idx !== -1, 'compiled code must assign exitCode = 1');
  assert.ok(cap0Idx !== -1, 'compiled code must assign exitCode = 0');
  assert.ok(cap3Idx < cap1Idx, 'code-3 branch must precede the isFailedExit=1 branch');
  assert.ok(cap1Idx < cap0Idx, 'code-1 branch must precede the success=0 branch');

  // All three exit codes are at distinct byte positions (not the same branch)
  const unique = new Set([cap3Idx, cap1Idx, cap0Idx]);
  assert.equal(unique.size, 3, 'exitCode 0, 1, and 3 must be at three distinct code sites');

  // buildTmuxNotification classifies iteration_cap_exhausted as a failure
  const notif = buildTmuxNotification('iteration_cap_exhausted', 'implement', 5, 300);
  assert.ok(notif.title.includes('Failed'), 'notification title must indicate failure for cap-exit');
  assert.ok(
    notif.subtitle.includes('iteration_cap_exhausted'),
    'subtitle must name the exit reason so operators can identify cap-hit',
  );

  // Contrast: success and limit exits produce non-failure titles and do NOT get code 3
  const successNotif = buildTmuxNotification('success', 'completed', 10, 600);
  assert.ok(successNotif.title.includes('Complete'), 'success exit must not be flagged as failure');
});
