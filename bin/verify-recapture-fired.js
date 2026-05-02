#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');

function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function phaseName(entry) {
  return entry?.phase ?? entry?.step ?? null;
}

function anatomyWindows(history) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry, index) => {
    if (phaseName(entry) !== 'anatomy-park') return [];
    const start = isoMs(entry.timestamp);
    if (start === null) return [];
    const next = history.slice(index + 1).find((candidate) => isoMs(candidate?.timestamp) !== null);
    const end = next ? isoMs(next.timestamp) : Infinity;
    return [{ start, end }];
  });
}

function isInWindow(timestamp, windows) {
  const ts = isoMs(timestamp);
  return ts !== null && windows.some(({ start, end }) => ts >= start && ts < end);
}

function findMatchingEvent(activity, windows) {
  return activity.find((entry) => (
    entry?.event === 'baseline_recapture_attempted'
    && entry.iteration === 1
    && isInWindow(entry.ts ?? entry.timestamp, windows)
  )) ?? null;
}

function artifactWindows(windows) {
  return windows.map(({ start, end }) => ({
    start,
    end: Number.isFinite(end) ? end : null,
  }));
}

function writeArtifact({ pass, failureReason, evidence }) {
  const artifact = {
    ac_id: 'AC-DR-02',
    pass,
    checked_at: new Date().toISOString(),
    checker: 'verify-recapture-fired',
    checker_version: '1',
    evidence,
    failure_reason: failureReason,
    remediation_hint: pass ? null : 'Ensure anatomy-park records baseline_recapture_attempted at iteration 1 inside its phase window.',
  };
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export function verifyRecaptureFired(sessionRoot) {
  const statePath = sessionRoot ? path.join(sessionRoot, 'state.json') : null;
  if (!statePath || !fs.existsSync(statePath)) {
    return {
      exitCode: 2,
      artifact: writeArtifact({
        pass: false,
        failureReason: 'state-missing',
        evidence: { state_path: statePath, activity_count: null, anatomy_windows: [] },
      }),
    };
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const activity = state.activity;
  const windows = anatomyWindows(state.history);
  const matchingEvent = Array.isArray(activity) ? findMatchingEvent(activity, windows) : null;
  const failureReason = !Array.isArray(activity)
    ? 'activity-missing'
    : windows.length === 0
      ? 'phase-window-missing'
      : matchingEvent
        ? null
        : 'recapture-event-missing';
  const pass = failureReason === null;

  return {
    exitCode: pass ? 0 : 1,
    artifact: writeArtifact({
      pass,
      failureReason,
      evidence: {
        state_path: statePath,
        activity_count: Array.isArray(activity) ? activity.length : null,
        anatomy_windows: artifactWindows(windows),
        matched_event: matchingEvent,
      },
    }),
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-recapture-fired.js') {
  try {
    const sessionRoot = process.argv[2] ?? process.env.PICKLE_SESSION_ROOT;
    const result = verifyRecaptureFired(sessionRoot);
    process.stdout.write(`AC-DR-02 ${result.artifact.pass ? 'PASS' : 'FAIL'} ${ARTIFACT_PATH}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
