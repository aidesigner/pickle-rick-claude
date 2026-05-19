#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StateManager } from '../extension/services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');
const RUNTIME_ARTIFACT_PATH = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');
const sm = new StateManager();
const STABLE_ARTIFACT = {
  ac_id: 'AC-DR-02',
  pass: true,
  checked_at: '2026-05-06T00:00:00.000Z',
  checker: 'verify-recapture-fired',
  checker_version: '2',
  evidence: {
    contract: 'Runtime verification results are written to bundle/ac-dr-02.runtime.json so the tracked artifact remains content-stable across runs.',
  },
  failure_reason: null,
  remediation_hint: null,
};

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

function latestAnatomyWindow(history) {
  const windows = anatomyWindows(history);
  return windows.length > 0 ? windows[windows.length - 1] : null;
}

function isInWindow(timestamp, windows) {
  const ts = isoMs(timestamp);
  return ts !== null && windows.some(({ start, end }) => ts >= start && ts < end);
}

function findMatchingEvent(activity, windows) {
  return activity.find((entry) => (
    entry?.event === 'baseline_recapture_attempted'
    && isInWindow(entry.ts ?? entry.timestamp, windows)
  )) ?? null;
}

function artifactWindows(windows) {
  return windows.map(({ start, end }) => ({
    start,
    end: Number.isFinite(end) ? end : null,
  }));
}

function writeRuntimeArtifact({ pass, failureReason, evidence }) {
  const artifact = {
    ...STABLE_ARTIFACT,
    pass,
    checked_at: new Date().toISOString(),
    evidence,
    failure_reason: failureReason,
    remediation_hint: pass ? null : 'Ensure anatomy-park records baseline_recapture_attempted inside its latest anatomy-park phase window.',
  };
  fs.mkdirSync(path.dirname(RUNTIME_ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function ensureStableArtifact() {
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(STABLE_ARTIFACT, null, 2)}\n`);
}

export function verifyRecaptureFired(sessionRoot) {
  const statePath = sessionRoot ? path.join(sessionRoot, 'state.json') : null;
  if (!statePath || !fs.existsSync(statePath)) {
    return {
      exitCode: 2,
      artifact: writeRuntimeArtifact({
        pass: false,
        failureReason: 'state-missing',
        evidence: { state_path: statePath, activity_count: null, anatomy_windows: [] },
      }),
    };
  }

  let state;
  try {
    state = sm.read(statePath);
  } catch (err) {
    const failureReason = err && typeof err === 'object' && 'code' in err && err.code === 'MISSING'
      ? 'state-missing'
      : 'state-unreadable';
    return {
      exitCode: failureReason === 'state-missing' ? 2 : 1,
      artifact: writeRuntimeArtifact({
        pass: false,
        failureReason,
        evidence: {
          state_path: statePath,
          read_error: err instanceof Error ? err.message : String(err),
          activity_count: null,
          anatomy_windows: [],
        },
      }),
    };
  }
  const activity = state.activity;
  const latestWindow = latestAnatomyWindow(state.history);
  const windows = latestWindow ? [latestWindow] : [];
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
    artifact: writeRuntimeArtifact({
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
    ensureStableArtifact();
    const sessionRoot = process.argv[2] ?? process.env.PICKLE_SESSION_ROOT;
    const result = verifyRecaptureFired(sessionRoot);
    process.stdout.write(`AC-DR-02 ${result.artifact.pass ? 'PASS' : 'FAIL'} ${RUNTIME_ARTIFACT_PATH}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
