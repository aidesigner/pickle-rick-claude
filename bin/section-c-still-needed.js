#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../extension/services/pickle-utils.js';

const DEFAULT_SESSIONS_DIR = path.join(getDataRoot(), 'sessions');
const LOG_NAMES = Object.freeze(['tmux-runner.log', 'pipeline-runner.log']);
const BANNER = '◤ FEED TERMINATED ◢';
const DEFAULT_RUNTIME_ARTIFACT_PATH = path.join(getDataRoot(), 'bundle', 'section-c-still-needed.json');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { session: null };
  if (args.length === 2 && args[0] === '--session') return { session: args[1] };
  throw new Error('Usage: section-c-still-needed.js [--session <session-root>]');
}

function newestSessionRoot() {
  if (!fs.existsSync(DEFAULT_SESSIONS_DIR)) return null;
  let entries;
  try {
    entries = fs.readdirSync(DEFAULT_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(DEFAULT_SESSIONS_DIR, entry.name))
    .map((dir) => sessionSignal(dir))
    .filter(Boolean)
    .sort(compareSessionSignals);
  return dirs[0]?.dir ?? null;
}

function safeMtimeMs(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return null;
  }
}

function isReadableRegularFile(targetPath) {
  try {
    if (!fs.statSync(targetPath).isFile()) {
      return false;
    }
    fs.accessSync(targetPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function canWriteSessionArtifact(sessionRoot) {
  let sessionStats;
  try {
    sessionStats = fs.statSync(sessionRoot);
  } catch {
    return false;
  }
  if (!sessionStats.isDirectory()) {
    return false;
  }

  try {
    fs.accessSync(sessionRoot, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return false;
  }

  const bundleDir = path.join(sessionRoot, 'bundle');
  let artifactRoot = sessionRoot;
  if (fs.existsSync(bundleDir)) {
    try {
      if (!fs.statSync(bundleDir).isDirectory()) {
        return false;
      }
      artifactRoot = bundleDir;
    } catch {
      return false;
    }
  }
  try {
    fs.accessSync(artifactRoot, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sessionSignal(sessionRoot) {
  const logMtimes = LOG_NAMES
    .map((logName) => path.join(sessionRoot, logName))
    .filter((logPath) => isReadableRegularFile(logPath))
    .map((logPath) => safeMtimeMs(logPath))
    .filter((mtimeMs) => mtimeMs !== null);
  const dirMtime = safeMtimeMs(sessionRoot);
  if (dirMtime === null) return null;
  return {
    dir: sessionRoot,
    hasWatcherLogs: logMtimes.length > 0,
    watcherLogMtime: logMtimes.length > 0 ? Math.max(...logMtimes) : Number.NEGATIVE_INFINITY,
    dirMtime,
  };
}

function compareSessionSignals(left, right) {
  if (left.hasWatcherLogs !== right.hasWatcherLogs) {
    return Number(right.hasWatcherLogs) - Number(left.hasWatcherLogs);
  }
  if (left.watcherLogMtime !== right.watcherLogMtime) {
    return right.watcherLogMtime - left.watcherLogMtime;
  }
  return right.dirMtime - left.dirMtime;
}

function lastLines(text, limit = 1000) {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - limit));
}

function evidenceFor(lines, reason = null) {
  if (reason) return reason;
  const matches = lines.filter((line) => (
    line.includes(BANNER) || /iteration .*?(completed|starting)/i.test(line)
  ));
  return matches.join('\n');
}

function resolveArtifactPath(sessionRoot) {
  if (process.env.SECTION_C_ARTIFACT_PATH) {
    return process.env.SECTION_C_ARTIFACT_PATH;
  }
  if (sessionRoot) {
    return path.join(sessionRoot, 'bundle', 'section-c-still-needed.json');
  }
  return DEFAULT_RUNTIME_ARTIFACT_PATH;
}

function writeArtifact(artifactPath, payload) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { artifactPath, ...payload };
}

function readWatcherLogs(sessionRoot) {
  return LOG_NAMES
    .map((logName) => path.join(sessionRoot, logName))
    .filter((logPath) => isReadableRegularFile(logPath))
    .flatMap((logPath) => {
      try {
        return [{ logPath, text: fs.readFileSync(logPath, 'utf8') }];
      } catch {
        return [];
      }
    });
}

export function evaluateSectionC({ sessionRoot } = {}) {
  const resolvedSession = sessionRoot ?? newestSessionRoot();
  if (!resolvedSession || !fs.existsSync(resolvedSession)) {
    const artifactPath = resolveArtifactPath(null);
    return writeArtifact(artifactPath, {
      still_needed: true,
      evidence: 'No recent session found; defaulting Section C to still needed.',
    });
  }
  if (!canWriteSessionArtifact(resolvedSession)) {
    const artifactPath = resolveArtifactPath(null);
    return writeArtifact(artifactPath, {
      still_needed: true,
      evidence: `Session ${resolvedSession} is missing, unreadable, or not writable; defaulting Section C to still needed.`,
    });
  }

  const artifactPath = resolveArtifactPath(resolvedSession);
  const logEntries = readWatcherLogs(resolvedSession);
  if (logEntries.length === 0) {
    return writeArtifact(artifactPath, {
      still_needed: true,
      evidence: `${LOG_NAMES.join(' and ')} missing or unreadable in ${resolvedSession}; defaulting Section C to still needed.`,
    });
  }

  const logContents = logEntries.map(({ text }) => text);
  const logPaths = logEntries.map(({ logPath }) => logPath);
  const lines = logContents.flatMap((text) => lastLines(text));
  const stillNeeded = logContents.some((text) => text.includes(BANNER));
  const sampledBannerVisible = lines.some((line) => line.includes(BANNER));
  return writeArtifact(artifactPath, {
    still_needed: stillNeeded,
    evidence: stillNeeded && !sampledBannerVisible
      ? `${BANNER} found earlier in watcher log outside the trailing evidence sample.`
      : evidenceFor(lines) || `No ${BANNER} found in ${logPaths.join(', ')}.`,
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'section-c-still-needed.js') {
  try {
    const { session } = parseArgs(process.argv);
    const artifact = evaluateSectionC({ sessionRoot: session });
    process.stdout.write(`section-c-still-needed ${artifact.still_needed ? 'STILL_NEEDED' : 'CLEARED'} ${artifact.artifactPath}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
