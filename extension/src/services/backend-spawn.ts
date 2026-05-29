import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Backend, BACKENDS, State, type BackendResolutionSource, type WorkerBackendResolutionSource } from '../types/index.js';
import { StateManager } from './state-manager.js';

/**
 * R-WSRC-4 — Test-harness sandbox assertion.
 *
 * Thrown by `buildClaudeWorkerInvocation` when `process.env.PICKLE_TEST_MODE === '1'`
 * AND any `addDirs[i]` resolves (via `fs.realpathSync`) outside the canonical
 * `os.tmpdir()`. Catches the leak class where a test fixture sets
 * `working_dir: REPO_ROOT` (or `EXTENSION_DIR: REPO_ROOT`), spawns a worker,
 * and the spawn timeout fires (R-MRWG-2) — the orphaned
 * `claude --dangerously-skip-permissions --add-dir <real-repo>` subprocess
 * then retains write access to the operator's real working tree.
 */
export class AddDirOutsideSandboxError extends Error {
  readonly offendingDirs: string[];
  readonly tmpdirRealpath: string;
  constructor(offendingDirs: string[], tmpdirRealpath: string) {
    super(
      `R-WSRC-4: PICKLE_TEST_MODE=1 but addDirs contain paths outside os.tmpdir() (${tmpdirRealpath}): ${offendingDirs.join(', ')}. ` +
        `Test fixtures must root working_dir/EXTENSION_DIR under os.tmpdir() to prevent leaked claude subprocesses ` +
        `retaining --add-dir <real-repo> write access.`,
    );
    this.name = 'AddDirOutsideSandboxError';
    this.offendingDirs = offendingDirs;
    this.tmpdirRealpath = tmpdirRealpath;
  }
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

function isUnderTmpdirRealpath(dir: string, tmpdirRealpath: string): boolean {
  const resolved = realpathOrSelf(dir);
  if (resolved === tmpdirRealpath) return true;
  return resolved.startsWith(tmpdirRealpath + path.sep);
}

/**
 * R-WSRC-4: assert each addDir resolves under os.tmpdir() when PICKLE_TEST_MODE=1.
 * No-op in production (env var unset). Returns silently on pass; throws
 * `AddDirOutsideSandboxError` listing every offender on fail.
 */
export function assertAddDirsUnderTmpdirIfTestMode(addDirs: readonly string[]): void {
  if (process.env.PICKLE_TEST_MODE !== '1') return;
  const tmpdirRealpath = realpathOrSelf(os.tmpdir());
  const offenders: string[] = [];
  for (const dir of addDirs) {
    if (!dir) continue;
    if (!isUnderTmpdirRealpath(dir, tmpdirRealpath)) offenders.push(dir);
  }
  if (offenders.length > 0) throw new AddDirOutsideSandboxError(offenders, tmpdirRealpath);
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface WorkerInvocationOptions {
  prompt: string;
  addDirs: string[];
  model?: string;
  outputFormat?: string;
  effort?: ReasoningEffort;
  toolset?: string;
  toolsets?: string[];
  provider?: string;
  maxTurns?: number;
  /** Inline JSON or file path for claude --mcp-config (claude backend only). */
  mcpConfig?: string;
}

export interface ManagerInvocationOptions {
  prompt: string;
  addDirs: string[];
  model?: string;
  maxTurns?: number;
  streamJson?: boolean;
  noSessionPersistence?: boolean;
  toolsets?: string[];
  provider?: string;
}

export interface JudgeInvocationOptions {
  prompt: string;
  addDirs: string[];
  model?: string;
  systemPrompt?: string;
}

export interface SpawnInvocation {
  cmd: string;
  args: string[];
  backend: Backend;
}

export function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && (BACKENDS as readonly string[]).includes(value);
}

// Dedupe by (source, value) so a bad state.json or typo'd env var warns once
// per process rather than N times per call site. Same silent-fallback trap-door
// class as the spawnSync-no-timeout cluster: a downgrade to 'claude' that should
// have been 'codex' wastes a whole Morty spawn with no signal.
const _warnedBackends = new Set<string>();
const _sm = new StateManager();
const BACKEND_FLIP_REASON_TTL_MS = 60_000;

export type BackendPreSpawnAssertion = {
  mode: 'match' | 'bypass' | 'mismatch';
  resolvedBackend: Backend;
  stateBackend?: Backend;
};

export type WorkerBackendResolution = {
  backend: Backend;
  source: WorkerBackendResolutionSource;
  workerBackend: Backend | null;
  managerBackend: Backend;
};

export function __resetBackendWarnings(): void {
  _warnedBackends.clear();
}

function parseBackendFlipTs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecentFlipReason(timestampMs: number, nowMs: number): boolean {
  if (timestampMs > nowMs) return false;
  return nowMs - timestampMs <= BACKEND_FLIP_REASON_TTL_MS;
}

function clearBackendFlipReasonFlags(statePath: string): void {
  try {
    _sm.update(statePath, state => {
      const flags = state.flags;
      if (typeof flags === 'object' && flags !== null) {
        delete flags.backend_flip_reason;
        delete flags.backend_flip_reason_ts;
        if (!Object.keys(flags).length) {
          state.flags = {};
        }
      }
    });
  } catch {
    // fail-open: worker execution can still continue without flip-carve-out cleanup
  }
}

// eslint-disable-next-line complexity -- HT-1 reviewed: backend resolution branches enumerate state/env/CLI precedence per R-XBL-2 trap door.
export function assertBackendPreSpawn(input: {
  statePath: string;
  resolvedBackend: Backend;
  source: BackendResolutionSource;
}): BackendPreSpawnAssertion {
  if (
    input.source === 'refinement-lock' ||
    input.source === 'cli-flag-override' ||
    input.source === 'settings' ||
    input.source === 'env' ||
    input.source === 'default'
  ) {
    // 'settings' is the enable_backend_routing_heuristic flip: an intentional,
    // configured routing decision, so resolved != state.backend is expected.
    return { mode: 'match', resolvedBackend: input.resolvedBackend };
  }

  const state = (() => {
    try {
      return _sm.read(input.statePath) as State | null;
    } catch {
      return null;
    }
  })();

  const stateBackend = isBackend(state?.backend) ? state?.backend : undefined;
  const stateWorkerBackend = isBackend((state as { worker_backend?: unknown } | null | undefined)?.worker_backend)
    ? (state as { worker_backend?: Backend }).worker_backend
    : undefined;
  if (!stateBackend || stateBackend === input.resolvedBackend || stateWorkerBackend === input.resolvedBackend) {
    return { mode: 'match', resolvedBackend: input.resolvedBackend, stateBackend };
  }

  const flipReason = typeof state?.flags?.backend_flip_reason === 'string' ? state.flags.backend_flip_reason : null;
  const flipTs = parseBackendFlipTs(state?.flags?.backend_flip_reason_ts);
  if (!flipReason || flipTs === null || !isRecentFlipReason(flipTs, Date.now())) {
    return { mode: 'mismatch', resolvedBackend: input.resolvedBackend, stateBackend };
  }

  clearBackendFlipReasonFlags(input.statePath);
  return { mode: 'bypass', resolvedBackend: input.resolvedBackend, stateBackend };
}

function warnBadBackend(sourceLabel: string, value: string): void {
  const key = `${sourceLabel}:${value}`;
  if (_warnedBackends.has(key)) return;
  _warnedBackends.add(key);
  process.stderr.write(
    `[pickle-rick] unrecognized backend ${JSON.stringify(value)} from ${sourceLabel} — falling back to 'claude' (valid: ${BACKENDS.join(', ')})\n`
  );
}

export function resolveBackend(source: State | { backend?: unknown } | null | undefined): Backend {
  // Refinement lock sentinel: PRD refinement is planning, not implementation.
  // Codex is reserved for implementation. This sentinel is set by
  // spawn-refinement-team and propagates to every grandchild via env
  // inheritance, so any downstream caller that reads state.json (e.g.
  // loadBackendFromSession) cannot leak codex back into the refinement phase.
  // Silent force — no warning, no log.
  if (process.env.PICKLE_REFINEMENT_LOCK === '1') return 'claude';
  const raw = source ? (source as { backend?: unknown }).backend : undefined;
  if (isBackend(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) warnBadBackend('state', raw);
  const env = process.env.PICKLE_BACKEND;
  if (isBackend(env)) return env;
  if (typeof env === 'string' && env.length > 0) warnBadBackend('PICKLE_BACKEND env', env);
  return 'claude';
}

function resolveManagerBackendValue(source: State | { backend?: unknown } | null | undefined): Backend {
  const raw = source ? (source as { backend?: unknown }).backend : undefined;
  if (isBackend(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) warnBadBackend('state', raw);
  const env = process.env.PICKLE_BACKEND;
  if (isBackend(env)) return env;
  if (typeof env === 'string' && env.length > 0) warnBadBackend('PICKLE_BACKEND env', env);
  return 'claude';
}

export function resolveWorkerBackendFromState(
  source: State | { backend?: unknown; worker_backend?: unknown } | null | undefined,
): WorkerBackendResolution {
  if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
    return {
      backend: 'claude',
      source: 'env_lock',
      workerBackend: null,
      managerBackend: resolveManagerBackendValue(source),
    };
  }

  const managerBackend = resolveManagerBackendValue(source);
  const rawWorkerBackend = source ? (source as { worker_backend?: unknown }).worker_backend : undefined;
  if (isBackend(rawWorkerBackend)) {
    return {
      backend: rawWorkerBackend,
      source: 'worker_backend',
      workerBackend: rawWorkerBackend,
      managerBackend,
    };
  }
  if (typeof rawWorkerBackend === 'string' && rawWorkerBackend.length > 0) {
    warnBadBackend('state.worker_backend', rawWorkerBackend);
  }

  return {
    backend: managerBackend,
    source: 'backend',
    workerBackend: null,
    managerBackend,
  };
}

export function resolveBackendFromStateFileWithSource(
  statePath: string,
  cliBackend?: Backend,
): { backend: Backend; source: BackendResolutionSource } {
  // Refinement lock is non-overridable: short-circuits on the lock variable
  // before disk-I/O so a stale/hostile state.json cannot recover codex for a
  // locked-in planning run.
  if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
    return { backend: 'claude', source: 'refinement-lock' };
  }

  // Explicit CLI override must beat persisted state/env because spawn-site
  // callers already validated the value and are intentionally overriding the
  // session's default backend for this launch.
  if (cliBackend !== undefined) {
    return { backend: cliBackend, source: 'cli-flag-override' };
  }

  let parsed: { backend?: unknown } | null = null;
  try {
    parsed = _sm.read(statePath) as { backend?: unknown } | null;
  } catch {
    // ignore read/parsing errors and continue to env/default fallback
  }

  if (isBackend(parsed?.backend)) {
    return { backend: parsed.backend, source: 'state' };
  }
  if (typeof parsed?.backend === 'string' && parsed.backend.length > 0) {
    warnBadBackend('state', parsed.backend);
  }

  const envBackend = process.env.PICKLE_BACKEND;
  if (isBackend(envBackend)) return { backend: envBackend, source: 'env' };
  if (typeof envBackend === 'string' && envBackend.length > 0) {
    warnBadBackend('PICKLE_BACKEND env', envBackend);
  }
  return { backend: 'claude', source: 'default' };
}

export function resolveWorkerBackendFromStateFile(statePath: string): WorkerBackendResolution {
  let parsed: { backend?: unknown; worker_backend?: unknown } | null;
  try {
    parsed = _sm.read(statePath) as { backend?: unknown; worker_backend?: unknown } | null;
  } catch {
    parsed = null;
  }
  return resolveWorkerBackendFromState(parsed);
}

export function resolveBackendFromStateFile(statePath: string): Backend {
  return resolveBackendFromStateFileWithSource(statePath).backend;
}

export function buildWorkerInvocation(backend: Backend, opts: WorkerInvocationOptions): SpawnInvocation {
  if (backend === 'codex') return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model, opts.effort);
  if (backend === 'hermes') return buildHermesWorkerInvocation(opts);
  return buildClaudeWorkerInvocation(opts);
}

export function buildManagerInvocation(backend: Backend, opts: ManagerInvocationOptions): SpawnInvocation {
  if (backend === 'codex') return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
  if (backend === 'hermes') return buildHermesWorkerInvocation(opts);
  return buildClaudeManagerInvocation(opts);
}

function buildClaudeWorkerInvocation(opts: WorkerInvocationOptions): SpawnInvocation {
  // R-WSRC-4: test-harness sandbox assertion. No-op unless PICKLE_TEST_MODE=1.
  assertAddDirsUnderTmpdirIfTestMode(opts.addDirs);
  const args: string[] = ['--dangerously-skip-permissions'];
  for (const dir of opts.addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (opts.outputFormat && opts.outputFormat !== 'text') {
    args.push('--output-format', opts.outputFormat);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  // NOTE: claude CLI has no public reasoning-effort flag for `claude -p`; opts.effort
  // is intentionally ignored here. Don't inject --append-system-prompt or env vars
  // as a workaround — the value still survives in state.json for future logging/use.
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

function buildCodexInvocation(prompt: string, addDirs: string[], model?: string, effort?: ReasoningEffort): SpawnInvocation {
  const args: string[] = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--ephemeral',
    // Bypass user-level rule files (`~/.codex/AGENTS.md`, `~/.codex/CLAUDE.md`,
    // `~/.codex/skills/*/SKILL.md`). A stale or parallel-universe codex
    // installation can otherwise misdirect the manager into chasing
    // non-existent paths mid-iteration. Pickle-rick's prompts already carry
    // every contract codex needs — letting `~/.codex/` rules override them
    // produces FM-4 (stall-on-imaginary-worker) where codex narrates a worker
    // that doesn't exist instead of invoking spawn-morty.js.
    '--ignore-rules',
    '--ignore-user-config',
  ];
  for (const dir of addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (model) args.push('-m', model);
  // Codex `-c key=value` is the documented config-override syntax. Must come
  // BEFORE the `--` prompt separator or codex parses it as part of the prompt.
  if (effort) args.push('-c', `reasoning.effort=${effort}`);
  args.push('--', prompt);
  return { cmd: 'codex', args, backend: 'codex' };
}

function buildHermesWorkerInvocation(opts: WorkerInvocationOptions): SpawnInvocation {
  const args: string[] = [
    'chat',
    '-q', opts.prompt,
    '-Q',
    '--ignore-rules',
    '--ignore-user-config',
  ];
  if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  const toolset = opts.toolset?.trim() || opts.toolsets?.map(t => t.trim()).filter(Boolean).join(',');
  if (toolset) args.push('--toolsets', toolset);
  if (opts.provider?.trim()) args.push('--provider', opts.provider.trim());
  if (opts.model?.trim()) args.push('-m', opts.model.trim());
  return { cmd: 'hermes', args, backend: 'hermes' };
}

/**
 * Build a read-only judge invocation.
 *
 * The LLM judge scores candidate diffs — it MUST NOT write files, commit, or
 * shell out. Both backend paths are explicitly locked down:
 *
 * - claude: `--allowedTools Read,Glob,Grep` + `--no-session-persistence`,
 *   threads `--system-prompt` and `-p <prompt>`. No Bash/Edit/Write tools.
 * - codex: `codex exec -s read-only` (codex's built-in read-only sandbox;
 *   see `codex exec --help`). Also passes `--ignore-rules` and
 *   `--ignore-user-config` so the judge cannot be biased by user- or
 *   project-level execpolicy / config TOML. `--ephemeral` keeps the session
 *   off disk. Crucially the bypass flag is DROPPED — the judge never gets
 *   full FS access.
 *
 * codex exec does NOT expose `--system-prompt` / `--allowedTools` /
 * `--no-session-persistence`. The system prompt is inlined as a prefix to the
 * user prompt; the read-only sandbox replaces the tool allowlist.
 */
export function buildJudgeInvocation(backend: Backend, opts: JudgeInvocationOptions): SpawnInvocation {
  if (backend === 'codex') return buildCodexJudgeInvocation(opts);
  return buildClaudeJudgeInvocation(opts);
}

function buildClaudeJudgeInvocation(opts: JudgeInvocationOptions): SpawnInvocation {
  const args: string[] = ['--dangerously-skip-permissions'];
  for (const dir of opts.addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  // Read-only tool allowlist — judge MUST NOT write, edit, or execute.
  args.push('--allowedTools', 'Read,Glob,Grep');
  args.push('--no-session-persistence');
  args.push('-p', opts.prompt);
  return { cmd: 'claude', args, backend: 'claude' };
}

function buildCodexJudgeInvocation(opts: JudgeInvocationOptions): SpawnInvocation {
  // Inline the system prompt as a prefix since `codex exec` has no
  // --system-prompt flag. The read-only sandbox enforces the actual safety
  // guarantee; the system prompt only shapes the scoring contract.
  const composedPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.prompt}`
    : opts.prompt;

  const args: string[] = [
    'exec',
    // Read-only sandbox — no file writes, no shell exec, no network.
    // Replaces --dangerously-bypass-approvals-and-sandbox; DO NOT add that
    // flag back into the judge path.
    '-s', 'read-only',
    // Ignore user CLAUDE.md / AGENTS.md / .rules files so project-specific
    // rules cannot bias the judge's scoring contract.
    '--ignore-rules',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--ephemeral',
  ];
  for (const dir of opts.addDirs) {
    if (dir && existsSilently(dir)) args.push('--add-dir', dir);
  }
  if (opts.model) args.push('-m', opts.model);
  args.push('--', composedPrompt);
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
