// @tier: fast
//
// AC-R-WMNP-4: the wmw-auto-skip terminal no-progress trigger must route through
// the SAME RecoveryController ladder as closer_handoff_terminal BEFORE a bare
// Failed flip / respawn — fix-forward-trivial / execute-converged-plan / auto-split
// advance a near-green ticket; only a genuinely exhausted ladder escalates to
// recovery_exhausted. It must reuse the shared seam (attemptRecoveryBeforeTerminal
// + state.recovery_attempts), never a forked parallel ladder.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');

// Isolate the wmw-auto-skip block: from the skip-K guard to its `continue;`/flip.
function autoSkipBlock() {
  const start = SRC.indexOf('zeroProgressCount >= skipK');
  assert.ok(start > 0, 'auto-skip guard present');
  // The block ends at the terminal flip+clear `continue;` after updateMuxLifecycleState({ currentTicket: null }).
  const end = SRC.indexOf('updateMuxLifecycleState(statePath, { currentTicket: null });', start);
  assert.ok(end > start, 'terminal flip present');
  return SRC.slice(start, end);
}

test('AC-R-WMNP-4: ladder is invoked BEFORE the bare Failed flip', () => {
  const block = autoSkipBlock();
  const recoveryIdx = block.indexOf('attemptRecoveryBeforeTerminal(');
  const flipIdx = block.indexOf("status: 'Failed'");
  assert.ok(recoveryIdx >= 0, 'wmw-auto-skip calls attemptRecoveryBeforeTerminal (shared ladder seam)');
  assert.ok(flipIdx >= 0, 'wmw-auto-skip still has the terminal Failed flip');
  assert.ok(recoveryIdx < flipIdx, 'the ladder runs BEFORE the terminal Failed flip, not after');
});

test('AC-R-WMNP-4: advanced → continue; exhausted → recovery_exhausted; fall_through → flip', () => {
  const block = autoSkipBlock();
  assert.match(block, /wmwRecovery\.kind === 'advanced'/, 'handles ladder advance');
  assert.match(block, /continue;/, 'an advanced recovery continues the loop instead of flipping Failed');
  assert.match(block, /wmwRecovery\.kind === 'exhausted'/, 'handles ladder exhaustion');
  assert.match(block, /recordExitReason\(statePath, 'recovery_exhausted'\)/, 'exhausted ladder escalates to recovery_exhausted');
});

test('AC-R-WMNP-4: reuses the shared ladder seam, not a forked parallel implementation', () => {
  // The wmw path and the closer_handoff_terminal path call the SAME helper.
  const calls = (SRC.match(/attemptRecoveryBeforeTerminal\(/g) || []).length;
  assert.ok(calls >= 2, 'attemptRecoveryBeforeTerminal is shared by closer + wmw paths (>=2 callsites)');
  // Ledger reuse: recovery attempts are appended to state.recovery_attempts (R-ORSR-1), no new array.
  assert.match(SRC, /s\.recovery_attempts\.push\(attempt\)/, 'reuses state.recovery_attempts ledger');
});

test('AC-R-WMNP-4: attemptRecoveryBeforeTerminal seam runs and returns a RecoveryOutcome on no-evidence ticket', async () => {
  const { attemptRecoveryBeforeTerminal } = await import('../bin/mux-runner.js');
  const os = await import('node:os');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-ladder-'));
  try {
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: sessionDir, step: 'implement', iteration: 6,
      max_iterations: 100, worker_timeout_seconds: 3600, start_time_epoch: 1,
      completion_promise: null, original_prompt: 'AC-R-WMNP-4', current_ticket: 'lad00001',
      history: [], started_at: new Date(0).toISOString(), session_dir: sessionDir,
      schema_version: 5, recovery_attempts: [], activity: [],
    }, null, 2));
    fs.mkdirSync(path.join(sessionDir, 'lad00001'), { recursive: true });

    // No git repo, no plan, no dirty tree → no recoverable evidence → fall_through
    // (the ladder ran but found nothing to advance). Proves the seam is reachable
    // and returns a well-formed RecoveryOutcome rather than throwing.
    const outcome = attemptRecoveryBeforeTerminal({
      sessionDir, statePath, extensionRoot: sessionDir, workingDir: sessionDir,
      ticketId: 'lad00001', iteration: 6, flags: null, log: () => {},
    });
    assert.ok(['advanced', 'fall_through', 'exhausted'].includes(outcome.kind),
      `returns a RecoveryOutcome kind, got ${outcome.kind}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
