// @tier: fast
/**
 * AC-R-MWIS-2 — mux main-loop idle-stall watchdog + self-recovery.
 *
 * Under state.active === true with a CLEAN wait-state (no rate-limit wait, circuit
 * breaker executable, last_error null, consecutive_subprocess_errors 0), an idle
 * no-progress condition past the bounded threshold MUST classify as a stall
 * (emits mux_idle_stall_detected + triggers self-recovery in the wired loop).
 * Any legitimate wait-state predicate MUST gate the watchdog off. The pure
 * decision function is exercised with an injectable clock + short threshold so
 * the test stays fast — no real `claude -p`, no wall-clock waiting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateMuxIdleStallWatchdog, resolveIdleStallThresholdSeconds } from '../bin/mux-runner.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const src = readFileSync(MUX_SRC, 'utf8');

const THRESHOLD = 5; // seconds — short, deterministic
const CLEAN = {
  active: true,
  thresholdSeconds: THRESHOLD,
  rateLimitWaiting: false,
  circuitBreakerExecutable: true,
  lastError: null,
  consecutiveSubprocessErrors: 0,
};

test('idle-stall: clean wait-state + idle past threshold → stalled (idle_no_progress)', () => {
  const nowMs = 1_000_000;
  const decision = evaluateMuxIdleStallWatchdog({
    ...CLEAN,
    nowMs,
    lastProgressMs: nowMs - (THRESHOLD + 2) * 1000, // 7s idle >= 5s threshold
  });
  assert.equal(decision.stalled, true);
  assert.equal(decision.reason, 'idle_no_progress');
  assert.equal(decision.idleSeconds, THRESHOLD + 2);
});

test('idle-stall: clean wait-state at exactly the threshold → stalled (bounded, inclusive)', () => {
  const nowMs = 2_000_000;
  const decision = evaluateMuxIdleStallWatchdog({
    ...CLEAN,
    nowMs,
    lastProgressMs: nowMs - THRESHOLD * 1000,
  });
  assert.equal(decision.stalled, true, 'idle == threshold must trip (bounded threshold)');
  assert.equal(decision.reason, 'idle_no_progress');
});

test('idle-stall: clean wait-state within threshold → not stalled (within_threshold)', () => {
  const nowMs = 3_000_000;
  const decision = evaluateMuxIdleStallWatchdog({
    ...CLEAN,
    nowMs,
    lastProgressMs: nowMs - (THRESHOLD - 1) * 1000, // 4s < 5s
  });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'within_threshold');
});

test('idle-stall: inactive session is never a stall', () => {
  const nowMs = 4_000_000;
  const decision = evaluateMuxIdleStallWatchdog({
    ...CLEAN,
    active: false,
    nowMs,
    lastProgressMs: nowMs - 999_999_000,
  });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'inactive');
});

const WAIT_STATES = [
  ['rate-limit wait', { rateLimitWaiting: true }],
  ['circuit breaker not executable', { circuitBreakerExecutable: false }],
  ['last_error set', { lastError: { message: 'boom', timestamp: 'now' } }],
  ['consecutive_subprocess_errors > 0', { consecutiveSubprocessErrors: 1 }],
];

for (const [label, override] of WAIT_STATES) {
  test(`idle-stall: legitimate wait-state (${label}) gates the watchdog off even when idle past threshold`, () => {
    const nowMs = 5_000_000;
    const decision = evaluateMuxIdleStallWatchdog({
      ...CLEAN,
      ...override,
      nowMs,
      lastProgressMs: nowMs - (THRESHOLD + 100) * 1000, // way past threshold
    });
    assert.equal(decision.stalled, false, `${label} must not be classified as an idle stall`);
    assert.equal(decision.reason, 'in_wait_state');
  });
}

test('idle-stall: idleSeconds floors at 0 for a future/equal lastProgress timestamp', () => {
  const nowMs = 6_000_000;
  const decision = evaluateMuxIdleStallWatchdog({ ...CLEAN, nowMs, lastProgressMs: nowMs + 10_000 });
  assert.equal(decision.idleSeconds, 0);
  assert.equal(decision.stalled, false);
});

test('idle-stall: PICKLE_MUX_IDLE_STALL_SECONDS overrides the threshold (strict positive integer)', () => {
  const prior = process.env.PICKLE_MUX_IDLE_STALL_SECONDS;
  try {
    process.env.PICKLE_MUX_IDLE_STALL_SECONDS = '42';
    assert.equal(resolveIdleStallThresholdSeconds(), 42);
    process.env.PICKLE_MUX_IDLE_STALL_SECONDS = '0';
    assert.equal(resolveIdleStallThresholdSeconds(), 900, 'non-positive falls back to default');
    process.env.PICKLE_MUX_IDLE_STALL_SECONDS = 'nonsense';
    assert.equal(resolveIdleStallThresholdSeconds(), 900, 'invalid falls back to default');
    delete process.env.PICKLE_MUX_IDLE_STALL_SECONDS;
    assert.equal(resolveIdleStallThresholdSeconds(), 900, 'unset falls back to default');
  } finally {
    if (prior === undefined) delete process.env.PICKLE_MUX_IDLE_STALL_SECONDS;
    else process.env.PICKLE_MUX_IDLE_STALL_SECONDS = prior;
  }
});

test('idle-stall: mux_idle_stall_detected is a registered activity event', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('mux_idle_stall_detected'),
    'mux_idle_stall_detected must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('idle-stall: mux-runner.ts wires the watchdog into the main loop and emits the event', () => {
  // Regression net for the wiring (the full loop needs a real claude -p, so the
  // wired path is covered by source-content assertions, matching the established
  // pattern in mux-runner-stall.test.js / mux-runner-timer.test.js).
  assert.ok(
    src.includes('evaluateMuxIdleStallWatchdog({'),
    'main loop must call evaluateMuxIdleStallWatchdog',
  );
  assert.ok(
    src.includes("event: 'mux_idle_stall_detected'"),
    'main loop must emit the mux_idle_stall_detected activity event',
  );
  // Self-recovery: clears current_ticket + resets stall trackers + continues.
  const wiringSlice = src.slice(src.indexOf('evaluateMuxIdleStallWatchdog({'));
  assert.ok(
    /findNextPendingTicketId\(sessionDir\)/.test(wiringSlice) &&
      /lastStateIteration = -1/.test(wiringSlice) &&
      /stallCount = 0/.test(wiringSlice),
    'self-recovery must re-evaluate the current ticket and reset stall trackers',
  );
});
