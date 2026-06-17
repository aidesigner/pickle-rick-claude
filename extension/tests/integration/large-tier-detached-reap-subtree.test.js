// @tier: integration
/**
 * H2 DATA-FLOW REGRESSION (aee2767b): the orchestrator timeout-reap
 * `process.kill(-worker_pid)` MUST reach the actual claude worker grandchild, not just
 * the spawn-morty wrapper.
 *
 * Topology under test (the real OS process-group data flow, NO mocks):
 *   mux-runner --(detached:true)--> spawn-morty (group leader G1, pid = worker_pid)
 *     --(detached: per shouldForceDetachForLargeTier rule)--> claude worker GRANDCHILD
 * The orchestrator reaps with `process.kill(-spawn_morty_pid, SIGKILL)` = a group kill of G1.
 *
 * FIX: the large-tier-detached grandchild inherits spawn-morty's group (detached:false), so
 * the single `-G1` group kill reaps the WHOLE subtree.
 * CONTROL (teeth): when the grandchild leads its OWN group (detached:true — the pre-fix
 * topology) the `-G1` kill MISSES it and it SURVIVES. If the control ever stops surviving,
 * the test has lost its discriminating power.
 *
 * Spawns real subprocesses with bounded timing → serialized via .serial-tests.json
 * (subprocess-spawn-timing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isProcessAlive } from '../../services/state-manager.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Spawn a two-layer detached tree mirroring mux-runner → spawn-morty → grandchild.
 * `grandchildDetached` toggles ONLY the grandchild's `detached` flag (the H2 lever).
 * Resolves with { middlePid, grandchildPid } once the grandchild has reported its pid.
 */
function spawnTwoLayerTree(grandchildDetached) {
  return new Promise((resolve, reject) => {
    // The "spawn-morty" middle layer: itself detached:true (mux-runner spawns it so), then
    // spawns a long-sleeping "grandchild" with the detached flag under test, prints both pids.
    const middleSrc = `
      const { spawn } = require('child_process');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
        detached: ${grandchildDetached ? 'true' : 'false'},
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      ${grandchildDetached ? 'gc.unref();' : ''}
      process.stdout.write('PIDS ' + process.pid + ' ' + gc.pid + '\\n');
      setTimeout(() => {}, 60000);
    `;
    const middle = spawn(process.execPath, ['-e', middleSrc], {
      detached: true, // mux-runner spawns spawn-morty detached:true (group leader G1)
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    middle.unref();
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PIDS (\d+) (\d+)/);
      if (m) {
        middle.stdout.off('data', onData);
        resolve({ middlePid: Number(m[1]), grandchildPid: Number(m[2]) });
      }
    };
    middle.stdout.on('data', onData);
    middle.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for PIDS line')), 8000);
  });
}

function reapGroup(pid) {
  // The orchestrator's session-group reap: NEGATIVE pid = whole group of the leader.
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function waitDead(pid, budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

test('H2 FIX: large-tier grandchild inherits spawn-morty group → orchestrator -worker_pid reap kills the WHOLE subtree', async () => {
  if (process.platform === 'win32') return; // no POSIX process groups
  const { middlePid, grandchildPid } = await spawnTwoLayerTree(/* detached */ false);
  try {
    assert.ok(isProcessAlive(grandchildPid), 'grandchild alive before reap');
    reapGroup(middlePid); // process.kill(-worker_pid) — worker_pid = spawn-morty (middle) pid
    assert.equal(await waitDead(grandchildPid), true,
      'grandchild MUST be dead after the orchestrator group reap (it inherited spawn-morty group)');
    assert.equal(await waitDead(middlePid), true, 'spawn-morty wrapper also dead');
  } finally {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* */ }
    try { process.kill(middlePid, 'SIGKILL'); } catch { /* */ }
  }
});

test('H2 CONTROL (teeth): a grandchild that leads its OWN group ESCAPES the -worker_pid reap and SURVIVES', async () => {
  if (process.platform === 'win32') return;
  const { middlePid, grandchildPid } = await spawnTwoLayerTree(/* detached */ true);
  try {
    assert.ok(isProcessAlive(grandchildPid), 'grandchild alive before reap');
    reapGroup(middlePid);
    await waitDead(middlePid); // wrapper dies (it IS the reaped group leader)
    // The grandchild escaped into its own group → the single -middlePid group kill misses it.
    assert.equal(isProcessAlive(grandchildPid), true,
      'control: own-group grandchild SURVIVES the wrapper-group reap (proves the test discriminates)');
  } finally {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* */ }
    try { process.kill(middlePid, 'SIGKILL'); } catch { /* */ }
  }
});
