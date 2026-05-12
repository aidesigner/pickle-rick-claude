#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'bundle', 'section-c-still-needed.json');
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.local', 'share', 'pickle-rick', 'sessions');
const LOG_NAMES = Object.freeze(['tmux-runner.log', 'pipeline-runner.log']);
const BANNER = '◤ FEED TERMINATED ◢';

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
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.dir ?? null;
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

function writeArtifact(payload) {
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function evaluateSectionC({ sessionRoot } = {}) {
  const resolvedSession = sessionRoot ?? newestSessionRoot();
  if (!resolvedSession || !fs.existsSync(resolvedSession)) {
    return writeArtifact({
      still_needed: true,
      evidence: 'No recent session found; defaulting Section C to still needed.',
      });
  }

  const logPaths = LOG_NAMES
    .map((logName) => path.join(resolvedSession, logName))
    .filter((logPath) => fs.existsSync(logPath));
  if (logPaths.length === 0) {
    return writeArtifact({
      still_needed: true,
      evidence: `${LOG_NAMES.join(' and ')} missing in ${resolvedSession}; defaulting Section C to still needed.`,
    });
  }

  const lines = logPaths.flatMap((logPath) => lastLines(fs.readFileSync(logPath, 'utf8')));
  const stillNeeded = lines.some((line) => line.includes(BANNER));
  return writeArtifact({
    still_needed: stillNeeded,
    evidence: evidenceFor(lines) || `No ${BANNER} found in ${logPaths.join(', ')}.`,
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'section-c-still-needed.js') {
  try {
    const { session } = parseArgs(process.argv);
    const artifact = evaluateSectionC({ sessionRoot: session });
    process.stdout.write(`section-c-still-needed ${artifact.still_needed ? 'STILL_NEEDED' : 'CLEARED'} ${ARTIFACT_PATH}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
