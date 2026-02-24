#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'node:crypto';
import { printMinimalPanel, Style, getExtensionRoot, withSessionMapLock, pruneOldSessions } from '../services/pickle-utils.js';
import { writeStateFile } from '../hooks/resolve-state.js';
import { State } from '../types/index.js';

function die(message: string): never {
  console.error(`${Style.RED}❌ Error: ${message}${Style.RESET}`);
  process.exit(1);
}

async function main() {
  const ROOT_DIR = getExtensionRoot();
  const SESSIONS_ROOT = path.join(ROOT_DIR, 'sessions');
  const JAR_ROOT = path.join(ROOT_DIR, 'jar');
  const WORKTREES_ROOT = path.join(ROOT_DIR, 'worktrees');
  const SESSIONS_MAP = path.join(ROOT_DIR, 'current_sessions.json');

  const updateSessionMap = (cwd: string, sessionPath: string) => {
    withSessionMapLock(SESSIONS_MAP + '.lock', () => {
      let map: Record<string, string> = {};
      if (fs.existsSync(SESSIONS_MAP)) {
        try {
          map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
        } catch {
          /* ignore */
        }
      }
      map[cwd] = sessionPath;
      const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
        fs.renameSync(tmpMap, SESSIONS_MAP);
      } catch (err) {
        try { fs.unlinkSync(tmpMap); } catch { /* cleanup best-effort */ }
        throw err;
      }
    });
  };

  // Ensure core directories exist
  [SESSIONS_ROOT, JAR_ROOT, WORKTREES_ROOT].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // Silently prune sessions older than 7 days that are no longer active
  pruneOldSessions(SESSIONS_ROOT);

  // Defaults
  let loopLimit = 5;
  let timeLimit = 60;
  let workerTimeout = 1200;
  let promiseToken: string | null = null;
  let resumeMode = false;
  let resumePath: string | null = null;
  let resetMode = false;
  let pausedMode = false;
  let tmuxMode = false;
  const taskArgs: string[] = [];
  const explicitFlags = new Set<string>();

  const startEpoch = Math.floor(Date.now() / 1000);

  // Load Settings
  const settingsFile = path.join(ROOT_DIR, 'pickle_settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.default_max_iterations) loopLimit = settings.default_max_iterations;
      if (settings.default_max_time_minutes) timeLimit = settings.default_max_time_minutes;
      if (settings.default_worker_timeout_seconds)
        workerTimeout = settings.default_worker_timeout_seconds;
    } catch {
      /* ignore */
    }
  }

  // Argument Parser
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--max-iterations') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v < 0) die(`--max-iterations requires a non-negative integer`);
      loopLimit = v;
      explicitFlags.add('max-iterations');
    } else if (arg === '--max-time') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v < 0) die(`--max-time requires a non-negative integer`);
      timeLimit = v;
      explicitFlags.add('max-time');
    } else if (arg === '--worker-timeout') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v <= 0) die(`--worker-timeout requires a positive integer`);
      workerTimeout = v;
      explicitFlags.add('worker-timeout');
    } else if (arg === '--completion-promise') {
      promiseToken = args[++i];
    } else if (arg === '--resume') {
      resumeMode = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        resumePath = args[++i];
      }
    } else if (arg === '--reset') {
      resetMode = true;
    } else if (arg === '--paused') {
      pausedMode = true;
    } else if (arg === '--tmux') {
      tmuxMode = true;
    } else if (arg === '--task') {
      if (i + 1 < args.length) taskArgs.push(args[++i]);
    } else if (arg === '-s' || arg === '--session-id') {
      // Ignore legacy session-id flag; consume the next arg if it's not a flag
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        i++;
      }
    } else {
      taskArgs.push(arg);
    }
  }

  let taskStr = taskArgs.join(' ').trim();
  let fullSessionPath = '';
  let currentIteration = 1;

  if (resumeMode) {
    if (resumePath) {
      fullSessionPath = resolvePath(resumePath);
    } else if (fs.existsSync(SESSIONS_MAP)) {
      try {
        const map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
        fullSessionPath = map[process.cwd()] || '';
      } catch {
        /* corrupt map — no session path */
      }
    }

    if (!fullSessionPath || !fs.existsSync(fullSessionPath)) {
      die(`No active session found or path invalid: ${fullSessionPath}`);
    }

    const statePath = path.join(fullSessionPath, 'state.json');
    let state: State;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as State;
    } catch {
      die(`state.json is missing or corrupt in ${fullSessionPath}`);
    }

    state.active = !pausedMode;
    if (resetMode) {
      state.iteration = 0;
      state.start_time_epoch = startEpoch;
    }

    // Only override limits that were explicitly passed on the command line;
    // otherwise preserve the values from the stored session state.
    if (explicitFlags.has('max-iterations')) state.max_iterations = loopLimit;
    if (explicitFlags.has('max-time')) state.max_time_minutes = timeLimit;
    if (explicitFlags.has('worker-timeout')) state.worker_timeout_seconds = workerTimeout;
    if (promiseToken) state.completion_promise = promiseToken;

    // Sync local vars with (potentially preserved) state for display
    loopLimit = state.max_iterations;
    timeLimit = state.max_time_minutes;
    workerTimeout = state.worker_timeout_seconds;

    writeStateFile(statePath, state);
    currentIteration = state.iteration + 1;
    promiseToken = state.completion_promise;
    fullSessionPath = state.session_dir; // Use stored path
  } else {
    if (!taskStr && !pausedMode) die('No task specified. Run /pickle --help for usage.');
    if (!taskStr) taskStr = 'PRD Interview (task to be determined via interview)';

    const today = new Date().toISOString().split('T')[0];
    const hash = crypto.randomBytes(4).toString('hex');
    const sessionId = `${today}-${hash}`;
    fullSessionPath = path.join(SESSIONS_ROOT, sessionId);

    if (!fs.existsSync(fullSessionPath)) fs.mkdirSync(fullSessionPath, { recursive: true });

    const state: State = {
      // tmux mode: start inactive so the main Claude window's stop hook never fires.
      // tmux-runner.ts takes ownership by setting active: true before its loop begins.
      active: !pausedMode && !tmuxMode,
      working_dir: process.cwd(),
      step: 'prd',
      iteration: 0,
      max_iterations: loopLimit,
      max_time_minutes: timeLimit,
      worker_timeout_seconds: workerTimeout,
      start_time_epoch: startEpoch,
      completion_promise: promiseToken,
      original_prompt: taskStr,
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: fullSessionPath,
      tmux_mode: tmuxMode,
    };

    writeStateFile(path.join(fullSessionPath, 'state.json'), state);
  }

  updateSessionMap(process.cwd(), fullSessionPath);

  printMinimalPanel(
    'Pickle Rick Activated!',
    {
      Iteration: currentIteration,
      Limit: loopLimit > 0 ? loopLimit : '∞',
      'Max Time': `${timeLimit}m`,
      'Worker TO': `${workerTimeout}s`,
      Promise: promiseToken || 'None',
      Extension: ROOT_DIR,
      Path: fullSessionPath,
    },
    'GREEN',
    '🥒'
  );

  // Machine-readable line for reliable parsing even when ANSI codes are present
  process.stdout.write(`SESSION_ROOT=${fullSessionPath}\n`);

  if (promiseToken) {
    console.log(`
${Style.YELLOW}⚠️  STRICT EXIT CONDITION ACTIVE${Style.RESET}`);
    console.log(`   You must output: <promise>${promiseToken}</promise>
`);
  }
}

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
