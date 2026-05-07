// @tier: integration
/**
 * R-WSE-2 / AC-WSE-02 — checkPartialLifecycleExit emits worker_partial_lifecycle_exit
 * when research-review APPROVED but downstream artifacts (plan / conformance / code_review)
 * are missing from the ticket directory. Payload includes ticket, artifacts_missing[],
 * and session_log_size.
 *
 * AC-WSE-05 forensic regression — replays the silent-exit signature from
 * 2026-05-04-f416c6cc/018f32d2: 4 artifacts present (research, research_review, plan,
 * plan_review) + 0-byte worker_session_*.log + missing conformance/code_review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { checkPartialLifecycleExit } = await import('../../bin/mux-runner.js');

function makeSession() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-wse2-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 3,
      working_dir: tmp,
      step: 'research',
      iteration: 0,
      max_iterations: 10,
      worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'wse2 test',
      session_dir: sessionDir,
      tmux_mode: false,
      backend: 'claude',
      schema_versionprev: 0,
      activity: [],
    }),
  );
  return { tmp, sessionDir, statePath };
}

function readActivity(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

test('AC-WSE-02: research APPROVED + missing plan emits worker_partial_lifecycle_exit', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'aaaa1111';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'research_2026-05-07.md'), 'research body');
    writeFileSync(path.join(ticketDir, 'worker_session_99999.log'), '');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit');
    assert.equal(events.length, 1, `expected 1 partial-lifecycle event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.ticket, ticketId);
    assert.deepStrictEqual(ev.gate_payload.artifacts_missing.sort(), ['code_review', 'conformance', 'plan']);
    assert.equal(ev.gate_payload.session_log_size, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-02: all downstream artifacts present → no event', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'bbbb2222';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), 'APPROVED');
    writeFileSync(path.join(ticketDir, 'plan_2026-05-07.md'), 'plan');
    writeFileSync(path.join(ticketDir, 'conformance_2026-05-07.md'), 'conformance');
    writeFileSync(path.join(ticketDir, 'code_review_2026-05-07.md'), 'review');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit');
    assert.equal(events.length, 0, 'expected no event when all artifacts present');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-02: research review NOT APPROVED → no event even with missing artifacts', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'cccc3333';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), 'REJECTED');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit');
    assert.equal(events.length, 0, 'expected no event when research review is not APPROVED');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-05: silent-exit-018f32d2 forensic replay — 4 artifacts + 0-byte log + missing conformance/code_review fires the event', () => {
  // Replays the exact signature from session 2026-05-04-f416c6cc ticket 018f32d2:
  //   - research_2026-05-04.md, research_review.md (APPROVED), plan_*.md, plan_review.md present
  //   - worker_session_<pid>.log exists at 0 bytes
  //   - conformance_*.md and code_review_*.md MISSING
  // Pre-fix: mux-runner moved on silently. Post-fix: worker_partial_lifecycle_exit fires.
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = '018f32d2';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_2026-05-04.md'), 'research body');
    writeFileSync(path.join(ticketDir, 'research_review.md'), '# Research Review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'plan_2026-05-04.md'), 'plan body');
    writeFileSync(path.join(ticketDir, 'plan_review.md'), '# Plan Review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'worker_session_94069.log'), ''); // 0-byte log — the smoking gun

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit');
    assert.equal(events.length, 1, 'forensic replay must fire exactly one event');
    const ev = events[0];
    assert.equal(ev.ticket, '018f32d2');
    assert.deepStrictEqual(
      ev.gate_payload.artifacts_missing.sort(),
      ['code_review', 'conformance'],
      'expected exactly conformance + code_review missing (plan present)',
    );
    assert.equal(ev.gate_payload.session_log_size, 0, 'silent-exit signature requires 0-byte log');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
