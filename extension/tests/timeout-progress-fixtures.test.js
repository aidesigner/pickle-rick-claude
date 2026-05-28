// @tier: fast
//
// R-WTB-A3 paired fixtures: integrated timeout decision under R-WTB-A1 detector +
// R-WTB-A2 raised 3600s budget.
//
// Fixture 1 (productive): mocked clock ticks 5-min increments; worker writes
// artifact mtimes at 5/15/30/45/other min marks throughout 50-min run →
// no ticket_timeout_halted_no_progress event fires; ticket reaches completion.
//
// Fixture 2 (no-progress): clock advances without any artifact writes →
// ticket_timeout_halted_no_progress fires at PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS
// elapsed (2 consecutive timeout budget exhaustions with no detector progress).
//
// Neither fixture spawns a real subprocess. The halt callback is simulated by
// capturing the detectArtifactProgress decision that would trigger executeTimeoutHalt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_BIN = path.resolve(__dirname, '../bin/mux-runner.js');
const DETECTOR_BIN = path.resolve(__dirname, '../services/artifact-progress-detector.js');

const { applyTimeoutCounter } = await import(MUX_BIN);
const { detectArtifactProgress, resolveNoProgressWindowSeconds, NO_PROGRESS_WINDOW_ENV } = await import(DETECTOR_BIN);

const TICKET_ID = 'abc123ticket';

function makeTmpSession() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-a3-')));
  const ticketDir = path.join(dir, TICKET_ID);
  fs.mkdirSync(ticketDir, { recursive: true });
  return { sessionDir: dir, ticketDir };
}

/**
 * Write (or update) a single artifact in ticketDir using the current mocked Date.now()
 * as the mtime, so getLatestArtifactMtime() sees a deterministically advancing value.
 */
function writeArtifact(ticketDir, name) {
  const p = path.join(ticketDir, name);
  fs.writeFileSync(p, `artifact: ${name}\n`);
  const mocked = new Date(Date.now());
  fs.utimesSync(p, mocked, mocked);
  return p;
}

// ---------------------------------------------------------------------------
// Fixture 1: Productive long-implement — no halt
// ---------------------------------------------------------------------------

test('R-WTB-A3 productive: 50-min implement with regular artifact writes fires no halt', (t) => {
  t.mock.timers.enable(['Date']);

  const { sessionDir, ticketDir } = makeTmpSession();
  try {
    // Simulate 10 worker runs, each 5 min long (total 50 min).
    // Artifacts are written at every run — modelling a productive worker that
    // emits research/plan/conformance artifacts throughout its lifecycle.
    // Specific mocked-clock timestamps: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50 min.
    // Highlighting the spec-required set: 5/15/30/45 min are among these writes.

    let snapshot = { latestMtimeEpoch: 0, latestCommitSha: null };
    let timeoutCount = 0;
    let lastTimeoutTicket = null;

    // Track halt decisions that would emit ticket_timeout_halted_no_progress.
    const haltDecisions = [];

    for (let i = 0; i < 10; i++) {
      // Advance mocked clock by 5 min per iteration.
      t.mock.timers.tick(5 * 60 * 1000);

      // Worker writes an artifact during this run (productive behavior).
      // utimesSync pins the mtime to the mocked clock value for determinism.
      writeArtifact(ticketDir, `artifact_iter${i}.md`);

      // Simulate: worker ran for full timeout window without signalling completion.
      const counter = applyTimeoutCounter({
        prev: { count: timeoutCount, ticket: lastTimeoutTicket },
        ticketNow: TICKET_ID,
        timedOut: true,
        completedClean: false,
      });
      timeoutCount = counter.count;
      lastTimeoutTicket = counter.ticket;

      if (counter.halt) {
        // R-WTB-A1 integrated decision: check artifact progress before halting.
        // workingDir has no .git → latestCommitSha always null; progress relies on mtime.
        const pResult = detectArtifactProgress(ticketDir, snapshot, {
          workingDir: sessionDir,
          windowSeconds: resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '300' }),
        });
        snapshot = { latestMtimeEpoch: pResult.latestMtimeEpoch, latestCommitSha: pResult.latestCommitSha };

        if (pResult.progressed) {
          // mux-runner resets to 1 (not 0) and continues — no halt.
          timeoutCount = 1;
          lastTimeoutTicket = TICKET_ID;
        } else {
          // This would trigger ticket_timeout_halted_no_progress + executeTimeoutHalt.
          haltDecisions.push({ iteration: i, event: 'ticket_timeout_halted_no_progress' });
        }
      }
    }

    // --- Assertions ---

    // Primary: no halt fired during the entire productive 50-min run.
    assert.equal(haltDecisions.length, 0,
      `expected 0 halt decisions, got ${haltDecisions.length}: ${JSON.stringify(haltDecisions)}`);

    // Secondary: simulate ticket completion — counter resets cleanly.
    const completionCounter = applyTimeoutCounter({
      prev: { count: timeoutCount, ticket: lastTimeoutTicket },
      ticketNow: TICKET_ID,
      timedOut: false,
      completedClean: true,
    });
    assert.equal(completionCounter.count, 0, 'completion resets timeout counter to 0 (ticket finished)');
    assert.equal(completionCounter.halt, false, 'completion never triggers halt');

    // Tertiary: detector snapshot was updated throughout run (proves detector was invoked).
    assert.ok(snapshot.latestMtimeEpoch > 0,
      'progress snapshot should have a non-zero mtime from artifact writes');

  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture 2: No-progress — halt fires
// ---------------------------------------------------------------------------

test('R-WTB-A3 no-progress: halt fires after 2 consecutive timeouts with no artifact progress', (t) => {
  t.mock.timers.enable(['Date']);

  // Use a dedicated env-var window of 300s for this fixture so the test
  // completes fast even with mocked clock (no real wait needed).
  const NO_PROGRESS_WINDOW_S = 300;

  const { sessionDir, ticketDir } = makeTmpSession();
  try {
    // Advance clock past zero so the initial artifact gets a non-zero mtime.
    // mock.timers starts at epoch 0; we need a positive value to distinguish
    // "artifact exists with known mtime" from "no artifact" (mtime 0).
    t.mock.timers.tick(60 * 1000); // +1 min → Date.now() = 60_000ms

    // Write ONE initial artifact and record its mtime as the current snapshot.
    // This represents the last-known good state before the worker stalls.
    writeArtifact(ticketDir, 'research_initial.md');
    const firstDetect = detectArtifactProgress(ticketDir,
      { latestMtimeEpoch: 0, latestCommitSha: null },
      { workingDir: sessionDir, windowSeconds: NO_PROGRESS_WINDOW_S });
    const snapshot = { latestMtimeEpoch: firstDetect.latestMtimeEpoch, latestCommitSha: firstDetect.latestCommitSha };
    assert.ok(snapshot.latestMtimeEpoch > 0, 'initial snapshot should capture the artifact mtime (> 0 confirms mtime was set via mocked clock)');

    // Advance mocked clock past the no-progress window.
    t.mock.timers.tick(NO_PROGRESS_WINDOW_S * 1000);

    // Simulate 2 consecutive timeouts on the same ticket — no new artifacts written.
    let timeoutCount = 0;
    let lastTimeoutTicket = null;

    for (let i = 0; i < 2; i++) {
      const counter = applyTimeoutCounter({
        prev: { count: timeoutCount, ticket: lastTimeoutTicket },
        ticketNow: TICKET_ID,
        timedOut: true,
        completedClean: false,
      });
      timeoutCount = counter.count;
      lastTimeoutTicket = counter.ticket;
    }

    // After 2 consecutive timeouts on the same ticket, halt condition is met.
    assert.equal(timeoutCount, 2, 'two consecutive timeouts should set count=2');

    // Now run the R-WTB-A1 integrated check: detect progress with the stale snapshot.
    // No new artifacts were written → detector sees same mtime → progressed=false.
    const haltCheck = detectArtifactProgress(ticketDir, snapshot, {
      workingDir: sessionDir,
      windowSeconds: NO_PROGRESS_WINDOW_S,
    });

    assert.equal(haltCheck.progressed, false,
      'no new artifacts → detectArtifactProgress must return progressed=false');

    // Capture the halt decision (mux-runner would emit ticket_timeout_halted_no_progress here).
    const haltDecision = haltCheck.progressed
      ? null
      : { event: 'ticket_timeout_halted_no_progress', ticketId: TICKET_ID, timeoutCount };

    assert.ok(haltDecision !== null, 'halt decision must be captured when progressed=false');
    assert.equal(haltDecision.event, 'ticket_timeout_halted_no_progress',
      'halt event name must match mux-runner emission');
    assert.equal(haltDecision.ticketId, TICKET_ID, 'halt decision records the ticket');
    assert.equal(haltDecision.timeoutCount, 2, 'halt decision records the timeout count');

    // Also verify the mtime was genuinely stale (same as snapshot — no progress).
    assert.equal(haltCheck.latestMtimeEpoch, snapshot.latestMtimeEpoch,
      'no new writes → mtime must be unchanged from snapshot');

  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
