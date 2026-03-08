import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { SpawnManagerArgs, SpawnWorkerArgs, SpawnResult } from './types/index.js';
import { loadConfig } from './services/config.js';
import {
  buildManagerSpawnCommand,
  buildWorkerSpawnCommand,
  formatDryRun,
  listRuntimes,
} from './services/runtime-adapter.js';

// ---------------------------------------------------------------------------
// Kill Escalation
// ---------------------------------------------------------------------------

export async function killWithEscalation(pid: number, graceSeconds: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // Process already dead
  }

  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      try {
        // Signal 0 tests if process exists without sending a signal
        process.kill(pid, 0);
      } catch {
        // Process is dead
        clearInterval(checkInterval);
        clearTimeout(escalation);
        resolve();
      }
    }, 100);

    const escalation = setTimeout(() => {
      clearInterval(checkInterval);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
      resolve();
    }, graceSeconds * 1000);
  });
}

// ---------------------------------------------------------------------------
// Shared spawn logic
// ---------------------------------------------------------------------------

interface InternalSpawnOpts {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  timeout: number;
  graceSeconds: number;
}

function spawnProcess(opts: InternalSpawnOpts): Promise<SpawnResult> {
  const { cmd, cwd, env, logFile, timeout, graceSeconds } = opts;

  // Ensure log directory exists
  const logDir = path.dirname(logFile);
  fs.mkdirSync(logDir, { recursive: true });

  const [bin, ...args] = cmd;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return new Promise<SpawnResult>((resolve) => {
    let settled = false;

    const proc = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(hangGuard);

      // Write log regardless of outcome
      try {
        fs.writeFileSync(logFile, result.stdout);
      } catch {
        // Log write failed — non-fatal
      }

      resolve(result);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Timeout → kill with escalation
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (proc.pid) {
        killWithEscalation(proc.pid, graceSeconds).catch(() => {});
      }
    }, timeout * 1000);

    // Safety net: force-resolve if process hangs
    const hangGuard = setTimeout(() => {
      settle({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        timedOut: true,
      });
    }, (timeout + 30) * 1000);
    hangGuard.unref();

    proc.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      settle({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: msg,
        timedOut: false,
      });
    });

    proc.on('close', (code) => {
      settle({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Manager Spawn
// ---------------------------------------------------------------------------

export async function spawnManager(args: SpawnManagerArgs): Promise<SpawnResult> {
  const config = loadConfig();
  const cmd = buildManagerSpawnCommand(args.runtime, config, args);

  // Clone env — never mutate process.env
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Manager env contract
  env['PICKLE_STATE_FILE'] = path.join(args.sessionDir, 'state.json');
  env['PYTHONUNBUFFERED'] = '1';

  // Apply runtime env_set
  const runtime = config.runtimes[args.runtime];
  if (runtime) {
    for (const [k, v] of Object.entries(runtime.env_set)) {
      env[k] = v;
    }
    // Apply runtime env_delete
    for (const k of runtime.env_delete) {
      delete env[k];
    }
  }

  // Apply caller-provided env overrides
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      env[k] = v;
    }
  }

  // Manager DELETES PICKLE_ROLE — managers must never have a role
  delete env['PICKLE_ROLE'];
  // Delete CLAUDECODE to avoid nested-session detection
  delete env['CLAUDECODE'];

  return spawnProcess({
    cmd,
    cwd: args.cwd,
    env,
    logFile: args.logFile,
    timeout: args.timeout,
    graceSeconds: config.defaults.sigkill_grace_seconds,
  });
}

// ---------------------------------------------------------------------------
// Worker Spawn
// ---------------------------------------------------------------------------

export async function spawnWorker(args: SpawnWorkerArgs): Promise<SpawnResult> {
  const config = loadConfig();
  const cmd = buildWorkerSpawnCommand(args.runtime, config, args);

  // Clone env — never mutate process.env
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Worker env contract
  env['PICKLE_STATE_FILE'] = path.join(path.dirname(args.ticketPath), 'state.json');
  env['PICKLE_ROLE'] = 'worker';
  env['PYTHONUNBUFFERED'] = '1';

  // Apply runtime env_set
  const runtime = config.runtimes[args.runtime];
  if (runtime) {
    for (const [k, v] of Object.entries(runtime.env_set)) {
      env[k] = v;
    }
    // Apply runtime env_delete
    for (const k of runtime.env_delete) {
      delete env[k];
    }
  }

  // Apply caller-provided env overrides
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      env[k] = v;
    }
  }

  // Delete CLAUDECODE to avoid nested-session detection
  delete env['CLAUDECODE'];

  return spawnProcess({
    cmd,
    cwd: args.cwd,
    env,
    logFile: args.logFile,
    timeout: args.timeout,
    graceSeconds: config.defaults.sigkill_grace_seconds,
  });
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list-runtimes')) {
    const config = loadConfig();
    console.log(listRuntimes(config));
    return;
  }

  if (args.includes('--dry-run')) {
    const config = loadConfig();
    const runtimeName = args[args.indexOf('--runtime') + 1] || config.primary_cli;
    const prompt = args[args.indexOf('--prompt') + 1] || '<prompt>';
    const mode = args.includes('--worker') ? 'worker' : 'manager';

    let cmd: string[];
    if (mode === 'worker') {
      cmd = buildWorkerSpawnCommand(runtimeName, config, {
        prompt,
        runtime: runtimeName,
        cwd: process.cwd(),
        logFile: '/dev/null',
        timeout: config.defaults.worker_timeout_seconds,
        ticketPath: '<ticket-path>',
        extensionRoot: '<extension-root>',
      });
    } else {
      cmd = buildManagerSpawnCommand(runtimeName, config, {
        prompt,
        runtime: runtimeName,
        cwd: process.cwd(),
        logFile: '/dev/null',
        timeout: config.defaults.worker_timeout_seconds,
        sessionDir: '<session-dir>',
        extensionRoot: '<extension-root>',
        maxTurns: config.defaults.tmux_max_turns,
      });
    }

    console.log(formatDryRun(cmd));
    return;
  }

  console.error('Usage: spawn-worker.js [--dry-run [--runtime <name>] [--prompt <text>] [--worker]] [--list-runtimes]');
  process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-worker.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
