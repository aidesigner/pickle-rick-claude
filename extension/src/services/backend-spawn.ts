import * as fs from 'fs';
import * as path from 'path';
import { Backend, BACKENDS, State } from '../types/index.js';

export interface WorkerInvocationOptions {
  prompt: string;
  addDirs: string[];
  model?: string;
  outputFormat?: string;
}

export interface ManagerInvocationOptions {
  prompt: string;
  addDirs: string[];
  model?: string;
  maxTurns?: number;
  streamJson?: boolean;
  noSessionPersistence?: boolean;
}

export interface SpawnInvocation {
  cmd: string;
  args: string[];
  backend: Backend;
}

export function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && (BACKENDS as readonly string[]).includes(value);
}

export function resolveBackend(source: State | { backend?: unknown } | null | undefined): Backend {
  if (source && isBackend((source as { backend?: unknown }).backend)) {
    return (source as { backend: Backend }).backend;
  }
  const env = process.env.PICKLE_BACKEND;
  if (isBackend(env)) return env;
  return 'claude';
}

export function resolveBackendFromStateFile(statePath: string): Backend {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return resolveBackend(parsed);
  } catch {
    return resolveBackend(null);
  }
}

export function buildWorkerInvocation(backend: Backend, opts: WorkerInvocationOptions): SpawnInvocation {
  if (backend === 'codex') return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
  return buildClaudeWorkerInvocation(opts);
}

export function buildManagerInvocation(backend: Backend, opts: ManagerInvocationOptions): SpawnInvocation {
  if (backend === 'codex') return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
  return buildClaudeManagerInvocation(opts);
}

function buildClaudeWorkerInvocation(opts: WorkerInvocationOptions): SpawnInvocation {
  const args: string[] = ['--dangerously-skip-permissions'];
  for (const dir of opts.addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (opts.outputFormat && opts.outputFormat !== 'text') {
    args.push('--output-format', opts.outputFormat);
  }
  if (opts.model) args.push('--model', opts.model);
  args.push('-p', opts.prompt);
  return { cmd: 'claude', args, backend: 'claude' };
}

function buildClaudeManagerInvocation(opts: ManagerInvocationOptions): SpawnInvocation {
  const args: string[] = ['--dangerously-skip-permissions'];
  for (const dir of opts.addDirs) {
    if (dir) args.push('--add-dir', dir);
  }
  if (opts.noSessionPersistence) args.push('--no-session-persistence');
  if (opts.streamJson) args.push('--output-format', 'stream-json', '--verbose');
  if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  if (opts.model) args.push('--model', opts.model);
  args.push('-p', opts.prompt);
  return { cmd: 'claude', args, backend: 'claude' };
}

function buildCodexInvocation(prompt: string, addDirs: string[], model?: string): SpawnInvocation {
  const args: string[] = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--ephemeral',
  ];
  for (const dir of addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (model) args.push('-m', model);
  args.push('--', prompt);
  return { cmd: 'codex', args, backend: 'codex' };
}

function existsSilently(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

export function backendEnvOverrides(backend: Backend): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PICKLE_BACKEND: backend };
  return env;
}

export function loadBackendFromSession(sessionDir: string): Backend {
  return resolveBackendFromStateFile(path.join(sessionDir, 'state.json'));
}
