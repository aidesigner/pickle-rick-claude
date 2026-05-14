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
  const dirs = fs.readdirSync(DEFAULT_SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(DEFAULT_SESSIONS_DIR, entry.name))
    .map((dir) => sessionSignal(dir))
    .sort(compareSessionSignals);
  return dirs[0]?.dir ?? null;
}

function sessionSignal(sessionRoot) {
  const logMtimes = LOG_NAMES
    .map((logName) => path.join(sessionRoot, logName))
    .filter((logPath) => fs.existsSync(logPath))
    .map((logPath) => fs.statSync(logPath).mtimeMs);
  return {
    dir: sessionRoot,
    hasWatcherLogs: logMtimes.length > 0,
    watcherLogMtime: logMtimes.length > 0 ? Math.max(...logMtimes) : Number.NEGATIVE_INFINITY,
    dirMtime: fs.statSync(sessionRoot).mtimeMs,
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

export function evaluateSectionC({ sessionRoot } = {}) {
  const resolvedSession = sessionRoot ?? newestSessionRoot();
  const artifactPath = resolveArtifactPath(resolvedSession);
  if (!resolvedSession || !fs.existsSync(resolvedSession)) {
    return writeArtifact(artifactPath, {
      still_needed: true,
      evidence: 'No recent session found; defaulting Section C to still needed.',
    });
  }

  const logPaths = LOG_NAMES
    .map((logName) => path.join(resolvedSession, logName))
    .filter((logPath) => fs.existsSync(logPath));
  if (logPaths.length === 0) {
    return writeArtifact(artifactPath, {
      still_needed: true,
      evidence: `${LOG_NAMES.join(' and ')} missing in ${resolvedSession}; defaulting Section C to still needed.`,
    });
  }

  const lines = logPaths.flatMap((logPath) => lastLines(fs.readFileSync(logPath, 'utf8')));
  const stillNeeded = lines.some((line) => line.includes(BANNER));
  return writeArtifact(artifactPath, {
    still_needed: stillNeeded,
    evidence: evidenceFor(lines) || `No ${BANNER} found in ${logPaths.join(', ')}.`,
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
