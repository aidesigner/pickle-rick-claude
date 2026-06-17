// @tier: integration
/**
 * e34dddf7 (AC-R-WPEXA-2c + AC-R-WPEXA-14) — both routeLargeTierTicket seams use the
 * detached lifecycle by default; the recovery re-execution seam no longer punts a
 * large ticket to interactive tmux.
 *
 * AC-R-WPEXA-2c — exactly the two CALLER seams + the def exist; spawn-morty.ts
 *                 applyHeuristicBackendRouting is NOT a routeLargeTierTicket caller;
 *                 no large-tier path silently punts when PICKLE_LARGE_TIER_DETACHED != off.
 * AC-R-WPEXA-14 — the shared spawnDetachedLargeTierWorker helper (driven by both seams)
 *                 spawns detached, populates state.detached_worker, and emits
 *                 large_tier_worker_spawned; the kill-switch-off branch keeps the legacy
 *                 routeLargeTierTicket punt.
 *
 * The stub spawn-morty is a real detached child, so this file is serialized in
 * tests/integration/.serial-tests.json (class subprocess-spawn-timing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MUX_SRC = path.join(REPO_ROOT, 'extension', 'src', 'bin', 'mux-runner.ts');
const SPAWN_MORTY_SRC = path.join(REPO_ROOT, 'extension', 'src', 'bin', 'spawn-morty.ts');

function makeSession(ticketId, extensionRoot) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltrrx-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 5, working_dir: tmp, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: null, activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath, extensionRoot };
}

// Fake spawn-morty stub placed at <extensionRoot>/extension/bin/spawn-morty.js so the
// helper's path.join(extensionRoot,'extension','bin','spawn-morty.js') resolves to it.
function writeStubExtensionRoot() {
  const extensionRoot = mkdtempSync(path.join(tmpdir(), 'pickle-extroot-'));
  const binDir = path.join(extensionRoot, 'extension', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'spawn-morty.js'), `#!/usr/bin/env node
const { mkdirSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const tpIdx = process.argv.indexOf('--ticket-path');
const ticketPath = tpIdx >= 0 ? process.argv[tpIdx + 1] : process.cwd();
mkdirSync(ticketPath, { recursive: true });
const logPath = path.join(ticketPath, 'worker_session_' + process.pid + '.log');
appendFileSync(logPath, 'SENTINEL_START\\n');
setTimeout(() => { process.exit(0); }, 150);
`);
  return extensionRoot;
}

test('AC-R-WPEXA-14: spawnDetachedLargeTierWorker spawns detached, populates state.detached_worker + emits large_tier_worker_spawned', async () => {
  const { spawnDetachedLargeTierWorker } = await import('../../bin/mux-runner.js');
  const ticketId = 'ticket-rrx001';
  const extensionRoot = writeStubExtensionRoot();
  const { tmp, statePath } = makeSession(ticketId, extensionRoot);
  try {
    const res = spawnDetachedLargeTierWorker({
      sessionDir: path.join(tmp, 'session'),
      statePath,
      ticketId,
      workingDir: tmp,
      extensionRoot,
      backend: 'claude',
      workerTimeoutSec: 4800,
      originalPrompt: 'test',
      log: () => {},
    });

    assert.equal(res.spawned, true, 'helper must report a spawned worker');
    assert.ok(res.pid && res.pid > 0, 'helper must return the worker pid');

    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.ok(state.detached_worker, 'detached_worker arm must be populated');
    assert.equal(state.detached_worker.worker_pid, res.pid);
    assert.equal(state.detached_worker.ticket_id, ticketId);
    assert.ok(state.detached_worker.spawned_at_epoch > 0);
    assert.equal(state.detached_worker.worker_log_path, res.logPath);

    const spawned = state.activity.filter(e => e.event === 'large_tier_worker_spawned');
    assert.equal(spawned.length, 1, 'must emit exactly one large_tier_worker_spawned');
    assert.equal(spawned[0].gate_payload.worker_pid, res.pid);
    assert.equal(spawned[0].gate_payload.ticket_id, ticketId);
    assert.ok(typeof spawned[0].ts === 'string', 'event must carry explicit ts');

    // NOT a routeLargeTierTicket punt: no large_tier_routed on the detached path.
    const routed = state.activity.filter(e => e.event === 'large_tier_routed');
    assert.equal(routed.length, 0, 'detached spawn must NOT emit large_tier_routed');

    await new Promise(r => setTimeout(r, 300));
    assert.ok(existsSync(res.logPath), 'worker log must exist (detached child wrote it)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-14 (kill-switch off): routeLargeTierTicket punt path emits large_tier_routed, no detached_worker', async () => {
  // The kill-switch=off branch is the legacy interactive punt. routeLargeTierTicket
  // (the seam fallback) is unchanged; it never populates detached_worker.
  const { routeLargeTierTicket } = await import('../../bin/mux-runner.js');
  const ticketId = 'ticket-rrx002';
  const { tmp, sessionDir, statePath } = makeSession(ticketId, null);
  try {
    const disp = routeLargeTierTicket(ticketId, sessionDir, statePath);
    assert.equal(disp.sanctionedPath, 'interactive_pickle_tmux');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(state.detached_worker, null, 'legacy punt must NOT set detached_worker');
    const routed = state.activity.filter(e => e.event === 'large_tier_routed');
    assert.equal(routed.length, 1, 'legacy punt must emit large_tier_routed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-2c: exactly the two CALLER seams + the def of routeLargeTierTicket exist in mux-runner.ts', () => {
  const src = readFileSync(MUX_SRC, 'utf-8');
  const lines = src.split('\n');
  const callers = [];
  let defs = 0;
  for (const line of lines) {
    if (/^export function routeLargeTierTicket\(/.test(line.trim())) { defs += 1; continue; }
    if (/routeLargeTierTicket\(/.test(line)) callers.push(line.trim());
  }
  assert.equal(defs, 1, 'exactly one routeLargeTierTicket definition');

  // The two live caller seams: the recovery re-execution seam (opts.*) and the
  // main-loop fallback (apTicketId ...). Doc-comment mentions are not invocations.
  const invocations = callers.filter(l => /routeLargeTierTicket\((?!the |inside)/.test(l) && /\)/.test(l) && !l.startsWith('*') && !l.startsWith('//'));
  const recoverySeam = invocations.filter(l => l.includes('opts.ticketId'));
  const mainFallback = invocations.filter(l => l.includes('apTicketId'));
  assert.equal(recoverySeam.length, 1, 'exactly one recovery re-execution seam caller (opts.ticketId)');
  assert.equal(mainFallback.length, 1, 'exactly one main-loop fallback caller (apTicketId)');
  assert.equal(invocations.length, 2, 'exactly two routeLargeTierTicket invocations total');
});

test('AC-R-WPEXA-2c: spawn-morty.ts applyHeuristicBackendRouting is NOT a routeLargeTierTicket caller', () => {
  const src = readFileSync(SPAWN_MORTY_SRC, 'utf-8');
  assert.ok(/function applyHeuristicBackendRouting\(/.test(src), 'applyHeuristicBackendRouting must still exist (the non-seam)');
  assert.equal(/routeLargeTierTicket\(/.test(src), false, 'spawn-morty.ts must NOT call routeLargeTierTicket');
});

test('AC-R-WPEXA-2c: no large-tier path silently punts when PICKLE_LARGE_TIER_DETACHED != off', () => {
  const src = readFileSync(MUX_SRC, 'utf-8');
  // T8 (0e301e4e) centralized the literal-`off` check into the exported resolver
  // largeTierDetachedEnabled(env). BOTH seams now drive that single source of
  // truth instead of inlining `process.env.PICKLE_LARGE_TIER_DETACHED !== 'off'`.
  assert.ok(
    /export function largeTierDetachedEnabled\([\s\S]{0,200}PICKLE_LARGE_TIER_DETACHED !== 'off'/.test(src),
    'the kill-switch resolver largeTierDetachedEnabled is the single literal-off source of truth',
  );
  // The recovery seam guards the legacy punt behind the kill-switch resolver: the
  // detached spawn is attempted UNLESS the kill-switch is off.
  assert.ok(
    /opts\.complexityTier === 'large'[\s\S]{0,400}largeTierDetachedEnabled\(\)[\s\S]{0,400}spawnDetachedLargeTierWorker\(/.test(src),
    'recovery seam must call spawnDetachedLargeTierWorker when the kill-switch is not off',
  );
  // The main-loop seam reads the same resolver and drives the shared helper.
  assert.ok(
    /detachedEnabled = largeTierDetachedEnabled\(\)/.test(src),
    'main-loop seam reads the PICKLE_LARGE_TIER_DETACHED kill-switch via the resolver',
  );
  assert.ok(
    /detachedEnabled && apTicketId &&[\s\S]{0,80}!state\.detached_worker\)[\s\S]{0,400}spawnDetachedLargeTierWorker\(/.test(src),
    'main-loop seam drives the shared spawnDetachedLargeTierWorker helper',
  );
});
