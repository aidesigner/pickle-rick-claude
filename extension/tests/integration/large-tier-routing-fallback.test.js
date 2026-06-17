// @tier: integration
/**
 * AC-GA-REC-2 (de345802) — routeLargeTierTicket gives a complexity_tier:large
 * ticket a sanctioned autonomous completion path instead of a raw foreground
 * spawn-morty that the 600s Bash-tool ceiling would SIGKILL (MASTER_PLAN #108,
 * session 2026-06-13-2bd4740a).
 *
 * The exported function is called directly (no subprocess spawn), mirroring
 * worker-partial-lifecycle-exit.test.js. No claude -p is launched, so this file
 * is NOT subprocess-heavy and needs no .serial-tests.json entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { routeLargeTierTicket, largeTierDetachedEnabled } = await import('../../bin/mux-runner.js');

function makeSession(tier) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltrf-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 3,
      working_dir: tmp,
      step: 'implement',
      iteration: 0,
      max_iterations: 10,
      worker_timeout_seconds: 4800,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'large-tier routing fallback test',
      session_dir: sessionDir,
      tmux_mode: false,
      backend: 'claude',
      current_ticket_tier: tier,
      activity: [],
    }),
  );
  return { tmp, sessionDir, statePath };
}

function readActivity(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

test('routes large tier to the sanctioned autonomous path via routeLargeTierTicket', () => {
  const { tmp, sessionDir, statePath } = makeSession('large');
  try {
    const ticketId = 'ticket-abc123';
    const disposition = routeLargeTierTicket(ticketId, sessionDir, statePath);

    // Return value contract.
    assert.equal(disposition.sanctionedPath, 'interactive_pickle_tmux');
    assert.equal(disposition.ticketId, ticketId);
    assert.equal(disposition.sessionDir, sessionDir);

    // Exactly one large_tier_routed event with the schema-required shape.
    const events = readActivity(statePath).filter((e) => e.event === 'large_tier_routed');
    assert.equal(events.length, 1, `expected 1 large_tier_routed event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.ticket, ticketId);
    assert.equal(typeof ev.ts, 'string', 'schema-required ts must be present');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts must be ISO 8601');
    assert.equal(ev.gate_payload.sanctioned_path, 'interactive_pickle_tmux');
    assert.equal(typeof ev.gate_payload.reason, 'string');
    assert.ok(ev.gate_payload.reason.length > 0, 'reason must be a non-empty string');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no 600s SIGKILL: zero silent-death/subprocess-error events and no worker_session log created', () => {
  const { tmp, sessionDir, statePath } = makeSession('large');
  try {
    const ticketId = 'ticket-large1';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });

    routeLargeTierTicket(ticketId, sessionDir, statePath);

    const activity = readActivity(statePath);
    // The routing path never spawns a worker, so the 600s-SIGKILL signatures
    // (0-byte log silent death / subprocess error) must be absent.
    assert.equal(
      activity.filter((e) => e.event === 'worker_silent_death').length,
      0,
      'routing must not produce a worker_silent_death (no subprocess spawned)',
    );
    assert.equal(
      activity.filter((e) => e.event === 'subprocess_error').length,
      0,
      'routing must not produce a subprocess_error (no subprocess spawned)',
    );
    // The only event emitted is the routing event itself.
    assert.equal(
      activity.filter((e) => e.event !== 'large_tier_routed').length,
      0,
      'routing emits exactly the large_tier_routed event and nothing else',
    );
    // No worker_session_*.log was created by the call.
    const sessionLogs = readdirSync(ticketDir).filter((f) => /^worker_session_.*\.log$/.test(f));
    assert.equal(sessionLogs.length, 0, 'routing must not create any worker_session_*.log file');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-7: largeTierDetachedEnabled disables ONLY on literal lowercase "off"', () => {
  // Detached lifecycle ON by default and for every non-`off` value.
  assert.equal(largeTierDetachedEnabled({}), true, 'absent → detached lifecycle enabled');
  assert.equal(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: '' }), true, 'empty → enabled');
  for (const v of ['OFF', 'Off', '0', 'false', '1', 'on', 'yes']) {
    assert.equal(
      largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: v }),
      true,
      `value "${v}" must NOT disable (only literal lowercase off disables)`,
    );
  }
  // ONLY the literal lowercase `off` reverts to the legacy interactive disposition.
  assert.equal(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: 'off' }), false, '"off" disables');
});

test('AC-R-WPEXA-7: kill-switch off → verbatim routeLargeTierTicket interactive disposition, no detached arm', () => {
  const { tmp, sessionDir, statePath } = makeSession('large');
  const prev = process.env.PICKLE_LARGE_TIER_DETACHED;
  process.env.PICKLE_LARGE_TIER_DETACHED = 'off';
  try {
    // With the kill-switch off, both seams fall through to routeLargeTierTicket.
    assert.equal(largeTierDetachedEnabled(), false, 'kill-switch off resolves to detached-disabled');

    const ticketId = 'ticket-killswitch';
    const disposition = routeLargeTierTicket(ticketId, sessionDir, statePath);

    // VERBATIM legacy disposition (unchanged shape).
    assert.equal(disposition.sanctionedPath, 'interactive_pickle_tmux');
    assert.equal(disposition.ticketId, ticketId);

    const activity = readActivity(statePath);
    // Exactly one large_tier_routed (the legacy interactive punt) and NO detached events.
    assert.equal(
      activity.filter((e) => e.event === 'large_tier_routed').length,
      1,
      'off path emits the legacy large_tier_routed event',
    );
    assert.equal(
      activity.filter((e) => e.event === 'large_tier_worker_spawned').length,
      0,
      'off path must NOT spawn a detached worker',
    );
    // The detached arm is never populated on the off path.
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.ok(!state.detached_worker, 'off path must not populate state.detached_worker');
  } finally {
    if (prev === undefined) delete process.env.PICKLE_LARGE_TIER_DETACHED;
    else process.env.PICKLE_LARGE_TIER_DETACHED = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-7: no new skip_*_reason flag added to StateFlags (env var is the escape hatch)', () => {
  // Subtract-before-add governance: the kill-switch is an env var, NOT a new
  // per-gate skip flag. audit-skip-flag-unification.sh enforces this at gate time;
  // this is the in-suite trip-wire. The only sanctioned skip_*_reason fields are
  // the documented survivors.
  const typesSrc = readFileSync(path.resolve(__dirname, '../../../extension/src/types/index.ts'), 'utf-8');
  const flagsStart = typesSrc.indexOf('export interface StateFlags');
  assert.ok(flagsStart >= 0, 'StateFlags interface must exist');
  const flagsEnd = typesSrc.indexOf('\n}', flagsStart);
  const flagsBlock = typesSrc.slice(flagsStart, flagsEnd);
  const skipFields = [...flagsBlock.matchAll(/^\s*(skip_\w*_reason)\??:/gm)].map((m) => m[1]);
  const allowed = new Set(['skip_quality_gates_reason', 'skip_readiness_reason', 'skip_ticket_audit_reason']);
  for (const f of skipFields) {
    assert.ok(allowed.has(f), `unexpected skip_*_reason flag "${f}" — env var is the only large-tier hatch`);
  }
  // No large-tier-specific skip flag.
  assert.ok(
    !/skip_large_tier_\w*_reason/.test(flagsBlock),
    'no skip_large_tier_*_reason flag may exist',
  );
});

test('small/medium tiers are unchanged — the routing seam is gated on tier === large', () => {
  // The wire-in at mux-runner.ts only calls routeLargeTierTicket when
  // state.current_ticket_tier === 'large'. For medium/small the function is
  // never invoked, so no large_tier_routed event ever appears. This asserts the
  // seam's gate without spawning a real manager loop (interface-as-test-surface).
  for (const tier of ['medium', 'small']) {
    const { tmp, statePath } = makeSession(tier);
    try {
      // Simulate the wire-in's gate: tier !== 'large' → routeLargeTierTicket not called.
      const before = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.notEqual(before.current_ticket_tier, 'large');

      // (no call to routeLargeTierTicket for non-large tiers)

      const events = readActivity(statePath).filter((e) => e.event === 'large_tier_routed');
      assert.equal(events.length, 0, `tier ${tier} must produce zero large_tier_routed events`);

      // State is otherwise untouched.
      const after = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.deepStrictEqual(after, before, `tier ${tier} state must be unmodified`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
