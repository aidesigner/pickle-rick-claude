#!/usr/bin/env node

/**
 * lock-scope — Mid-flight recovery for scopeless pipeline sessions.
 *
 * Usage: node lock-scope.js <session-root> --mode branch [--scope-base <ref>]
 *
 * Validates the session is paused (no live pipeline-runner.js PID), then
 * patches pipeline.json + state.json + pipeline-status.json so the session
 * can be resumed with scope enabled.
 *
 * Collapses the 6-step manual state patch to one command (R-PSAI-4).
 */

import * as fs from 'fs';
import * as path from 'path';
import { StateManager, clearExitReason, isProcessAlive } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { Defaults, type State } from '../types/index.js';

const USAGE = `Usage: node lock-scope.js <session-root> --mode branch [--scope-base <ref>]

  <session-root>       Path to the pipeline session directory
  --mode branch        Scope mode (only "branch" supported)
  --scope-base <ref>   Optional base ref for branch diff (default: main)

Example:
  node lock-scope.js ~/.local/share/pickle-rick/sessions/2026-05-09-abc/def --mode branch
  node lock-scope.js ~/.local/share/pickle-rick/sessions/2026-05-09-abc/def --mode branch --scope-base main
`;

function parseArgs(argv: string[]): { sessionRoot: string; mode: string; scopeBase?: string } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const sessionRoot = args[0];
  if (!sessionRoot || sessionRoot.startsWith('--')) {
    process.stderr.write(`lock-scope: missing <session-root> argument\n\n${USAGE}`);
    process.exit(1);
  }

  let mode = '';
  let scopeBase: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--mode') {
      mode = args[++i] ?? '';
    } else if (args[i] === '--scope-base') {
      scopeBase = args[++i];
    } else {
      process.stderr.write(`lock-scope: unknown argument: ${args[i]}\n\n${USAGE}`);
      process.exit(1);
    }
  }

  if (!mode) {
    process.stderr.write(`lock-scope: --mode is required\n\n${USAGE}`);
    process.exit(1);
  }
  if (mode !== 'branch') {
    process.stderr.write(`lock-scope: unsupported mode "${mode}". Only "branch" is supported.\n`);
    process.exit(1);
  }

  return { sessionRoot, mode, scopeBase };
}

function validateSessionDir(sessionRoot: string): void {
  if (!fs.existsSync(sessionRoot)) {
    process.stderr.write(`lock-scope: session-root not found: ${sessionRoot}\n`);
    process.exit(1);
  }
  const statePath = path.join(sessionRoot, 'state.json');
  if (!fs.existsSync(statePath)) {
    process.stderr.write(`lock-scope: state.json not found in ${sessionRoot}\n`);
    process.exit(1);
  }
  const pipelinePath = path.join(sessionRoot, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) {
    process.stderr.write(`lock-scope: pipeline.json not found in ${sessionRoot}\n`);
    process.exit(1);
  }
}

function refuseLiveRunner(statePath: string): void {
  const sm = new StateManager();
  let state: State;
  try {
    state = sm.read(statePath);
  } catch {
    return;
  }
  const pid = typeof state.pid === 'number' ? state.pid : null;
  if (pid !== null && isProcessAlive(pid)) {
    process.stderr.write(
      `lock-scope: refusing to run — pipeline-runner.js PID ${pid} is still alive.\n` +
      `Stop the pipeline first (e.g. kill ${pid}), then re-run lock-scope.\n`,
    );
    process.exit(1);
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function patchPipelineJson(pipelinePath: string, mode: string, scopeBase?: string): void {
  const raw = readRecoverableJsonObject(pipelinePath) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') {
    process.stderr.write(`lock-scope: pipeline.json is not a valid object\n`);
    process.exit(1);
  }
  raw['scope'] = mode;
  if (scopeBase !== undefined) {
    raw['scope_base'] = scopeBase;
  }
  writeJsonAtomic(pipelinePath, raw);
  process.stdout.write(`lock-scope: pipeline.json patched — scope=${mode}${scopeBase ? ` scope_base=${scopeBase}` : ''}\n`);
}

function patchStateJson(statePath: string): void {
  const sm = new StateManager();
  clearExitReason(statePath);
  sm.update(statePath, (s: State) => {
    s.active = true;
    if (typeof s.worker_timeout_seconds !== 'number' || s.worker_timeout_seconds <= 0) {
      s.worker_timeout_seconds = Defaults.WORKER_TIMEOUT_SECONDS;
    }
  });
  process.stdout.write(`lock-scope: state.json patched — active=true, exit_reason cleared\n`);
}

function patchPipelineStatusJson(sessionRoot: string, pipelinePath: string): void {
  const statusPath = path.join(sessionRoot, 'pipeline-status.json');

  const pipelineRaw = readRecoverableJsonObject(pipelinePath) as Record<string, unknown> | null;
  const phases = Array.isArray(pipelineRaw?.['phases']) ? (pipelineRaw!['phases'] as string[]) : [];

  let completedPhases = 0;
  if (fs.existsSync(statusPath)) {
    const existingStatus = readRecoverableJsonObject(statusPath) as Record<string, unknown> | null;
    const rawCompleted = existingStatus?.['completed_phases'];
    if (typeof rawCompleted === 'number' && rawCompleted >= 0) {
      completedPhases = rawCompleted;
    }
  }

  const nextPhase = phases[completedPhases] ?? null;
  const statusPayload: Record<string, unknown> = {
    status: 'running',
    current_phase: nextPhase,
    completed_phases: completedPhases,
    skipped_phases: 0,
    total_phases: phases.length,
    updated_at: new Date().toISOString(),
  };

  if (fs.existsSync(statusPath)) {
    const existing = readRecoverableJsonObject(statusPath) as Record<string, unknown> | null;
    if (existing && typeof existing['skipped_phases'] === 'number') {
      statusPayload['skipped_phases'] = existing['skipped_phases'];
    }
    if (existing && typeof existing['total_phases'] === 'number') {
      statusPayload['total_phases'] = existing['total_phases'];
    }
  }

  writeJsonAtomic(statusPath, statusPayload);
  process.stdout.write(`lock-scope: pipeline-status.json patched — status=running current_phase=${String(nextPhase)}\n`);
}

function main(): void {
  const { sessionRoot, mode, scopeBase } = parseArgs(process.argv);

  validateSessionDir(sessionRoot);

  const statePath = path.join(sessionRoot, 'state.json');
  const pipelinePath = path.join(sessionRoot, 'pipeline.json');

  refuseLiveRunner(statePath);
  patchPipelineJson(pipelinePath, mode, scopeBase);
  patchStateJson(statePath);
  patchPipelineStatusJson(sessionRoot, pipelinePath);

  const home = process.env.HOME ?? '~';
  process.stdout.write(
    `\nlock-scope: scope=${mode} patched. Resume with:\n` +
    `  node "${home}/.claude/pickle-rick/extension/bin/pipeline-runner.js" "${sessionRoot}"\n`,
  );
}

if (process.argv[1] && path.basename(process.argv[1]) === 'lock-scope.js') {
  main();
}
