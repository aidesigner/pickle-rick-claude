#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';

const EXTENSION_DIR = process.env.EXTENSION_DIR || join(os.homedir(), '.claude/pickle-rick');
const HANDLERS_DIR = join(EXTENSION_DIR, 'extension', 'hooks', 'handlers');
const LOG_PATH = join(EXTENSION_DIR, 'debug.log');

// Prevent EPIPE errors from crashing the dispatcher when Claude Code closes the pipe
const handleEpipe = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
};
process.stdout.on('error', handleEpipe);
process.stderr.on('error', handleEpipe);

function log(message: string) {
  try {
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_PATH, `[${timestamp}] [dispatcher] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function logError(message: string) {
  console.error(`Dispatcher Error: ${message}`);
  log(`ERROR: ${message}`);
}

function approve() {
  console.log(JSON.stringify({ decision: 'approve' }));
}

function findExecutable(name: string): string | null {
  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];

  for (const p of paths) {
    for (const ext of extensions) {
      const fullPath = join(p, name + ext);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: dispatch_hook <hook_name> [args...]');
    process.exit(1);
  }

  const [hookName, ...extraArgs] = args;
  if (hookName.includes('/') || hookName.includes('\\') || hookName.includes('..')) {
    logError(`Invalid hook name (path traversal rejected): ${hookName}`);
    approve();
    process.exit(0);
  }
  log(`Dispatching hook: ${hookName} (cwd: ${process.cwd()})`);
  const isWindows = process.platform === 'win32';

  let scriptPath: string;
  let cmd: string;
  let cmdArgs: string[];

  const jsPath = join(HANDLERS_DIR, `${hookName}.js`);
  if (existsSync(jsPath)) {
    scriptPath = jsPath;
    cmd = 'node';
    cmdArgs = [scriptPath, ...extraArgs];
  } else if (isWindows) {
    scriptPath = join(HANDLERS_DIR, `${hookName}.ps1`);
    const exe = findExecutable('pwsh') || findExecutable('powershell');
    if (!exe) {
      logError('PowerShell not found.');
      approve();
      process.exit(0);
    }
    cmd = exe;
    cmdArgs = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs];
  } else {
    scriptPath = join(HANDLERS_DIR, `${hookName}.sh`);
    cmd = 'bash';
    cmdArgs = [scriptPath, ...extraArgs];
  }

  if (!existsSync(scriptPath)) {
    logError(`Hook script not found: ${scriptPath}`);
    approve();
    process.exit(0);
  }

  let inputData = '';
  if (!process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      inputData = Buffer.concat(chunks).toString();
      log(`Input received: ${inputData.length} bytes`);
    } catch (e) {
      log(`Error reading stdin: ${e}`);
    }
  }

  try {
    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, EXTENSION_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      logError(`Child stdin error: ${err}`);
    });

    if (inputData) {
      try {
        child.stdin?.write(inputData);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
      }
    }
    child.stdin?.end();

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => (stdout += data.toString()));
    child.stderr?.on('data', (data) => (stderr += data.toString()));

    child.on('close', (code) => {
      if (stderr) process.stderr.write(stderr);

      if (stderr.trim()) {
        log(`Hook ${hookName} stderr: ${stderr.trim()}`);
      }

      if (!stdout.trim()) {
        if (code !== 0 && code !== null) {
          logError(`Hook ${hookName} exited with code ${code} and no output. stderr: ${stderr.trim() || '(none)'}`);
        }
        approve();
      } else {
        // Validate handler output is well-formed JSON with a decision field before forwarding
        let parsed: { decision: string } | null = null;
        try {
          const obj = JSON.parse(stdout.trim());
          if (obj.decision === 'approve' || obj.decision === 'block') {
            parsed = obj;
          } else {
            log(`Hook ${hookName} returned invalid decision: ${JSON.stringify(obj.decision)}`);
          }
        } catch {
          log(`Hook ${hookName} returned non-JSON stdout — falling back to approve`);
        }
        if (parsed) {
          console.log(JSON.stringify(parsed));
        } else {
          approve();
        }
      }
      process.exit(code ?? 0);
    });

    child.on('error', (err) => {
      logError(`Failed to start child process: ${err}`);
      approve();
      process.exit(0);
    });
  } catch (e) {
    logError(`Unexpected execution error: ${e}`);
    approve();
    process.exit(0);
  }
}

main().catch((err) => {
  try {
    log(`FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } catch { /* ignore */ }
  approve();
  process.exit(0);
});
