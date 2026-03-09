import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { State } from './types/index.js';
import { getExtensionRoot, loadConfig } from './services/config.js';
import { updateSessionMap, pruneSessionMap } from './services/session-map.js';

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export async function setup(args: string[]): Promise<string> {
  const extensionRoot = getExtensionRoot();
  const sessionsRoot = path.join(extensionRoot, 'sessions');
  const config = loadConfig();

  fs.mkdirSync(sessionsRoot, { recursive: true });

  // Defaults from config
  let maxIterations = config.defaults.max_iterations;
  let maxTimeMinutes = config.defaults.max_time_minutes;
  let workerTimeout = config.defaults.worker_timeout_seconds;
  let runtime = config.primary_cli;
  let commandTemplate: string | undefined;
  let chainMeeseeks = config.defaults.chain_meeseeks;
  const taskArgs: string[] = [];

  // Arg parsing
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runtime') {
      runtime = args[++i];
      if (!runtime) die('--runtime requires a value');
    } else if (arg === '--max-iterations') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v < 0) die('--max-iterations requires a non-negative integer');
      maxIterations = v;
    } else if (arg === '--max-time') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v < 0) die('--max-time requires a non-negative integer');
      maxTimeMinutes = v;
    } else if (arg === '--worker-timeout') {
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v <= 0) die('--worker-timeout requires a positive integer');
      workerTimeout = v;
    } else if (arg === '--template') {
      commandTemplate = args[++i];
      if (!commandTemplate) die('--template requires a value');
      if (/[/\\]|\.\./.test(commandTemplate)) die('--template must be a plain filename');
    } else if (arg === '--chain-meeseeks') {
      chainMeeseeks = true;
    } else {
      taskArgs.push(arg);
    }
  }

  const taskStr = taskArgs.join(' ').trim();
  if (!taskStr) die('No task specified');

  const today = new Date().toISOString().split('T')[0];
  const hash = crypto.randomBytes(4).toString('hex');
  const sessionId = `${today}-${hash}`;
  const sessionDir = path.join(sessionsRoot, sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });

  const now = new Date();
  const state: State = {
    active: true,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: maxIterations,
    max_time_minutes: maxTimeMinutes,
    worker_timeout_seconds: workerTimeout,
    start_time_epoch: Math.floor(now.getTime() / 1000),
    completion_promise: null,
    original_prompt: taskStr,
    current_ticket: null,
    history: [],
    started_at: now.toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    min_iterations: 0,
    command_template: commandTemplate,
    chain_meeseeks: chainMeeseeks,
    runtime,
  };

  // Atomic write state.json
  const statePath = path.join(sessionDir, 'state.json');
  const tmp = statePath + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, statePath);

  // Register in session map
  await updateSessionMap(process.cwd(), sessionDir);

  // Prune old sessions from map
  try { await pruneSessionMap(); } catch { /* non-fatal */ }

  return sessionDir;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'setup.js') {
  setup(process.argv.slice(2))
    .then((sessionDir) => {
      process.stdout.write(sessionDir + '\n');
    })
    .catch((err) => die(err instanceof Error ? err.message : String(err)));
}
