#!/usr/bin/env node

/**
 * pipeline-runner — Sequential phase orchestrator.
 *
 * Phases (in order):
 *   1. pickle       → mux-runner.js        (build/implement)
 *   2. anatomy-park → microverse-runner.js  (deep subsystem review)
 *   3. szechuan-sauce → microverse-runner.js (principle-driven deslopping)
 *
 * Each phase runs as a child process. Between phases the runner resets
 * state.json, creates required config files, and spawns the next runner.
 *
 * Usage: node pipeline-runner.js <session-dir>
 * Expects: pipeline.json in session-dir with phase configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type { State } from '../types/index.js';
import { StateManager } from '../services/state-manager.js';
import {
  getExtensionRoot,
  Style,
  formatTime,
  printMinimalPanel,
  safeErrorMessage,
  ensureMonitorWindow,
} from '../services/pickle-utils.js';
import { isWorkingTreeDirty } from '../services/git-utils.js';
import { logActivity } from '../services/activity-logger.js';
import {
  resolveScope,
  refreshScope,
  filterBySubsystem,
  ScopeError,
  type ScopeJson,
} from '../services/scope-resolver.js';

const sm = new StateManager();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PipelinePhase = 'pickle' | 'anatomy-park' | 'szechuan-sauce';

interface PipelineConfig {
  phases: PipelinePhase[];
  target: string;
  szechuan_domain?: string;
  szechuan_focus?: string;
  anatomy_stall_limit: number;
  szechuan_stall_limit: number;
  anatomy_max_iterations: number;
  szechuan_max_iterations: number;
}

type PipelineStatusKind = 'running' | 'completed' | 'failed' | 'cancelled';

interface PipelineStatus {
  status: PipelineStatusKind;
  current_phase: PipelinePhase | null;
  completed_phases: number;
  skipped_phases: number;
  total_phases: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Config Parsing
// ---------------------------------------------------------------------------

/** Parse and validate pipeline.json with safe defaults for all numeric fields. */
export function parsePipelineConfig(raw: Record<string, unknown>): PipelineConfig {
  return {
    phases: Array.isArray(raw.phases) ? raw.phases as PipelinePhase[] : [],
    target: (raw.target as string) || '',
    szechuan_domain: raw.szechuan_domain as string | undefined,
    szechuan_focus: raw.szechuan_focus as string | undefined,
    anatomy_stall_limit: Number.isFinite(Number(raw.anatomy_stall_limit)) ? Number(raw.anatomy_stall_limit) : 3,
    szechuan_stall_limit: Number.isFinite(Number(raw.szechuan_stall_limit)) ? Number(raw.szechuan_stall_limit) : 5,
    anatomy_max_iterations: Number.isFinite(Number(raw.anatomy_max_iterations)) ? Number(raw.anatomy_max_iterations) : 100,
    szechuan_max_iterations: Number.isFinite(Number(raw.szechuan_max_iterations)) ? Number(raw.szechuan_max_iterations) : 50,
  };
}

// ---------------------------------------------------------------------------
// Subsystem Discovery (mirrors anatomy-park.md Step 3)
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx']);
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.git', '.turbo', '.vercel',
]);

const TEST_PATTERNS = ['.test.', '.spec.', '__test__', '__spec__'];

export function isTestFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEST_PATTERNS.some(p => lower.includes(p));
}

export function discoverSubsystems(target: string): { name: string; fileCount: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch { return []; }

  const subsystems: { name: string; fileCount: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(target, entry.name);
    let sourceCount = 0;
    let testCount = 0;
    const visited = new Set<string>();

    const walk = (p: string) => {
      // Resolve real path to detect symlink loops
      let realP: string;
      try { realP = fs.realpathSync(p); } catch { return; }
      if (visited.has(realP)) return;
      visited.add(realP);

      let children: fs.Dirent[];
      try { children = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const child of children) {
        if (child.isDirectory() && !EXCLUDED_DIRS.has(child.name)) {
          walk(path.join(p, child.name));
        } else if (child.isFile() && SOURCE_EXTS.has(path.extname(child.name))) {
          sourceCount++;
          if (isTestFile(child.name)) testCount++;
        }
      }
    };
    walk(fullPath);

    // Exclude test-only directories (>80% test files) per anatomy-park spec
    if (sourceCount >= 3 && testCount / sourceCount <= 0.8) {
      subsystems.push({ name: entry.name, fileCount: sourceCount });
    }
  }

  return subsystems.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Pre-flight: Clean Working Tree
// ---------------------------------------------------------------------------

/**
 * Pipelines run long and span multiple phases. Starting with a dirty tree
 * masks which phase introduced which change — downstream microverse phases
 * would otherwise auto-commit the user's pre-existing work under a generic
 * message. Fail fast so the user makes that call deliberately.
 */
export function assertCleanWorkingTree(workingDir: string): void {
  if (!isWorkingTreeDirty(workingDir)) return;
  throw new Error(
    `Working tree at ${workingDir} is dirty. Commit, stash, or discard changes before starting the pipeline (git status).`,
  );
}

// ---------------------------------------------------------------------------
// Child Process Management
// ---------------------------------------------------------------------------

let activeChild: ChildProcess | null = null;

function spawnRunner(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: 'inherit' });
    activeChild = child;
    child.on('exit', (code) => { if (!settled) { settled = true; activeChild = null; resolve(code ?? 1); } });
    child.on('error', (err) => { if (!settled) { settled = true; activeChild = null; reject(err); } });
  });
}

export function writePipelineStatus(
  sessionDir: string,
  status: PipelineStatusKind,
  details: Partial<Omit<PipelineStatus, 'status' | 'updated_at'>> = {},
): void {
  const payload: PipelineStatus = {
    status,
    current_phase: details.current_phase ?? null,
    completed_phases: details.completed_phases ?? 0,
    skipped_phases: details.skipped_phases ?? 0,
    total_phases: details.total_phases ?? 0,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(sessionDir, 'pipeline-status.json'), JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

export function resetStateForPhase(statePath: string, template: string, maxIterations: number): void {
  sm.update(statePath, (s: State) => {
    // Set inactive — the runner takes ownership and activates on start.
    s.active = false;
    s.iteration = 0;
    s.current_ticket = null;
    s.start_time_epoch = Math.floor(Date.now() / 1000);
    s.max_iterations = maxIterations;
    s.command_template = template;
    s.step = 'review';
    s.chain_meeseeks = false;
    s.tmux_mode = true;
  });
}

function archiveFile(sessionDir: string, filename: string, phase: string): void {
  const src = path.join(sessionDir, filename);
  if (!fs.existsSync(src)) return;
  try { fs.copyFileSync(src, path.join(sessionDir, `${path.basename(filename, path.extname(filename))}-${phase}${path.extname(filename)}`)); } catch { /* best effort */ }
}

/** Archive and remove inter-phase artifacts that could confuse the next phase. */
export function cleanPhaseArtifacts(sessionDir: string, phase: string): void {
  // TASK_NOTES.md — stale notes from previous phase
  const notesPath = path.join(sessionDir, 'TASK_NOTES.md');
  if (fs.existsSync(notesPath)) {
    archiveFile(sessionDir, 'TASK_NOTES.md', phase);
    try { fs.unlinkSync(notesPath); } catch { /* best effort */ }
  }
  // gap_analysis.md — stale findings could cause szechuan-sauce to skip Phase 0
  const gapPath = path.join(sessionDir, 'gap_analysis.md');
  if (fs.existsSync(gapPath)) {
    archiveFile(sessionDir, 'gap_analysis.md', phase);
    try { fs.unlinkSync(gapPath); } catch { /* best effort */ }
  }
  // handoff.txt — stale handoff from previous runner
  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (fs.existsSync(handoffPath)) {
    try { fs.unlinkSync(handoffPath); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Scope Lifecycle
// ---------------------------------------------------------------------------

export interface SetupScopeArgs {
  sessionDir: string;
  workingDir: string;
  target: string;
  scopeFlag: string;
  scopeBase?: string;
  log: (msg: string) => void;
}

/**
 * Setup-time scope resolution. Writes `scope.json` and initializes
 * `state.phases_entered = []`. SCOPE_EMPTY_DIFF is demoted to a WARN (CUJ-6a):
 * a scope-configured session with no diff at setup should not kill the
 * pipeline — the build phase may still produce one. Returns the resolved
 * scope, or `null` when the scope is empty at setup (warning path).
 */
export function setupScope(args: SetupScopeArgs): ScopeJson | null {
  const { sessionDir, workingDir, target, scopeFlag, scopeBase, log } = args;
  const statePath = path.join(sessionDir, 'state.json');

  try {
    const scope = resolveScope({
      scopeFlag,
      scopeBase,
      target,
      sessionRoot: sessionDir,
      repoRoot: workingDir,
    });
    sm.update(statePath, (s) => { s.phases_entered = []; });
    log(`scope-setup: mode=${scope.mode} strategy=${scope.strategy} base=${scope.base_ref ?? '-'} allowed=${scope.allowed_paths.length}`);
    return scope;
  } catch (err) {
    if (err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF') {
      log(`scope-setup WARN: SCOPE_EMPTY_DIFF — ${err.message} (continuing; build phase may produce diff)`);
      sm.update(statePath, (s) => { s.phases_entered = []; });
      return null;
    }
    throw err;
  }
}

/**
 * Write `archive/skipped_by_scope.<phase>.json` — an observability record of
 * what scope filtered out for `phase`. Pure audit file; worker-side filters
 * (A6/A7) are out of scope for this ticket.
 */
export function writeSkippedByScope(
  sessionDir: string,
  phase: string,
  scope: ScopeJson,
  target: string,
  workingDir: string,
): void {
  const archiveDir = path.join(sessionDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const outPath = path.join(archiveDir, `skipped_by_scope.${phase}.json`);

  let payload: Record<string, unknown>;
  if (phase === 'anatomy-park') {
    const discovered = discoverSubsystems(target).map((s) => s.name);
    const kept = filterBySubsystem(discovered, scope.allowed_paths, target, workingDir);
    const keptSet = new Set(kept);
    const skipped = discovered.filter((n) => !keptSet.has(n));
    payload = {
      phase,
      head_sha: scope.head_sha,
      allowed_paths: scope.allowed_paths,
      subsystems_discovered: discovered,
      subsystems_kept: kept,
      subsystems_skipped: skipped,
    };
  } else {
    payload = {
      phase,
      head_sha: scope.head_sha,
      allowed_paths: scope.allowed_paths,
    };
  }

  const tmp = `${outPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, outPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase Setup: Anatomy Park
// ---------------------------------------------------------------------------

function setupAnatomyPark(
  sessionDir: string,
  target: string,
  stallLimit: number,
  extensionRoot: string,
  log: (msg: string) => void,
): boolean {
  const subsystems = discoverSubsystems(target);
  if (subsystems.length === 0) {
    log('No subsystems discovered — skipping anatomy-park phase');
    return false;
  }
  log(`Discovered ${subsystems.length} subsystems: ${subsystems.map(s => s.name).join(', ')}`);

  // anatomy-park.json — subsystem rotation state
  const apState = {
    subsystems: subsystems.map(s => s.name),
    current_index: 0,
    pass_counts: {} as Record<string, number>,
    consecutive_clean: {} as Record<string, number>,
    stall_counts: {} as Record<string, number>,
    stall_limit: stallLimit,
    findings_history: {} as Record<string, unknown[]>,
    trap_doors_added: [] as unknown[],
    trap_doors_committed: [] as unknown[],
  };
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify(apState, null, 2));

  // microverse.json — worker-managed convergence
  const runnerStallLimit = subsystems.length * 10;
  const metricJson = JSON.stringify({
    description: 'none', validation: 'none', type: 'none',
    timeout_seconds: 0, tolerance: 0, direction: 'lower',
  });
  try {
    execFileSync('node', [
      path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
      sessionDir, target,
      '--stall-limit', String(runnerStallLimit),
      '--convergence-mode', 'worker',
      '--convergence-file', 'anatomy-park.json',
      '--metric-json', metricJson,
    ], { timeout: 30_000, encoding: 'utf-8' });
  } catch (err) {
    log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
    return false;
  }

  // prd.md
  archiveFile(sessionDir, 'prd.md', 'pickle');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), [
    '# Anatomy Park: Deep Subsystem Review',
    '',
    '## Objective',
    `Systematically review and fix all subsystems in ${target} through phased review-fix-verify cycles. Catalog structural weaknesses as trap doors in subsystem CLAUDE.md files.`,
    '',
    '## Target',
    target,
    '',
    '## Subsystems',
    ...subsystems.map((s, i) => `${i + 1}. ${s.name} (${s.fileCount} files)`),
    '',
    '## Key Metric',
    '- **Type**: none (worker-managed convergence)',
    `- **Stall Limit**: ${stallLimit} per subsystem | ${runnerStallLimit} total (runner ceiling)`,
    '- **Target**: All subsystems pass clean for 2 consecutive passes',
    '',
    '## Process (each iteration)',
    '1. Select next subsystem from rotation',
    '2. Phase 1: Read-only review — trace data flows, rate all findings',
    '3. Phase 2: Fix the single highest-severity finding + write regression test',
    '4. Phase 3: Read-only self-review of the diff, revert if broken',
    '5. Catalog trap doors in subsystem CLAUDE.md',
    '6. Rotate to next subsystem',
    '',
    '## Rules',
    '- One subsystem per iteration, one fix per iteration',
    '- Three phases per iteration — never combine',
    '- Phase 1 and Phase 3 are READ-ONLY',
    '- Revert on regression, defer to next iteration',
    `- Skip subsystem after ${stallLimit} consecutive failed fixes`,
  ].join('\n'));

  log('Anatomy Park setup complete');
  return true;
}

// ---------------------------------------------------------------------------
// Phase Setup: Szechuan Sauce
// ---------------------------------------------------------------------------

function setupSzechuanSauce(
  sessionDir: string,
  target: string,
  stallLimit: number,
  extensionRoot: string,
  domain: string | undefined,
  focus: string | undefined,
  log: (msg: string) => void,
): boolean {
  const principlesPath = path.join(extensionRoot, 'szechuan-sauce-principles.md');
  let judgeContextArg: string | undefined;

  // Build judge context if domain or focus specified, or if base principles exist
  if (domain || focus) {
    const parts: string[] = [];
    try { parts.push(fs.readFileSync(principlesPath, 'utf-8')); } catch { /* base missing */ }
    if (domain) {
      const domainPath = path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`);
      try { parts.push(fs.readFileSync(domainPath, 'utf-8')); } catch {
        log(`Domain principles not found: ${domainPath}`);
      }
    }
    if (focus) {
      parts.push(`\n## Focus Directive\n\n${focus}\n\nViolations matching this focus are elevated by one priority level.`);
    }
    const contextPath = path.join(sessionDir, 'judge-context.md');
    fs.writeFileSync(contextPath, parts.join('\n\n'));
    judgeContextArg = contextPath;
  } else if (fs.existsSync(principlesPath)) {
    judgeContextArg = principlesPath;
  }

  // microverse.json — LLM-judged convergence to 0 (archive from previous phase)
  archiveFile(sessionDir, 'microverse.json', 'pre-szechuan');
  const initArgs = [
    path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
    sessionDir, target,
    '--stall-limit', String(stallLimit),
    '--convergence-target', '0',
  ];
  if (judgeContextArg) initArgs.push('--judge-context', judgeContextArg);
  try {
    execFileSync('node', initArgs, { timeout: 30_000, encoding: 'utf-8' });
  } catch (err) {
    log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
    return false;
  }

  // prd.md
  archiveFile(sessionDir, 'prd.md', 'anatomy-park');
  const prdParts = [
    '# Szechuan Sauce: Iterative Deslopping',
    '',
    '## Objective',
    `Eliminate all coding principle violations in ${target} through iterative review and fix cycles.`,
    '',
    '## Target',
    target,
    '',
    '## Principles Reference',
    `Read: ${principlesPath}`,
  ];
  if (domain) prdParts.push(`Read: ${path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`)}`);
  if (focus) prdParts.push('', '## Focus', focus);
  prdParts.push(
    '',
    '## Key Metric',
    '- **Type**: llm (LLM judge scoring)',
    '- **Direction**: lower',
    '- **Convergence Target**: 0',
    `- **Stall Limit**: ${stallLimit}`,
    '',
    '## Process',
    '### Iteration 1: Contract Discovery + Gap Analysis',
    '1. Extract all exports from target files',
    '2. Grep the entire codebase for importers — build contract map',
    '3. Flag cross-module mismatches as P1',
    '4. Catalog all violations into gap_analysis.md',
    '',
    '### Each subsequent iteration',
    '1. Read the principles reference and target code',
    '2. Identify the highest-priority violation (P0 > P1 > P2 > P3 > P4)',
    '3. Fix it — one logical change per iteration',
    '4. Run tests — ensure green',
    '5. Commit',
    '',
    '## Rules',
    '- One fix per iteration (atomic, revertible)',
    '- Never repeat a failed approach',
    '- P0 before P1 before P2 before P3 before P4',
  );
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prdParts.join('\n'));
  log('Szechuan Sauce setup complete');
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface MainOpts {
  scopeFlag?: string;
  scopeBase?: string;
}

export async function main(sessionDir: string, opts: MainOpts = {}): Promise<void> {
  const extensionRoot = getExtensionRoot();
  const statePath = path.join(sessionDir, 'state.json');
  const pipelinePath = path.join(sessionDir, 'pipeline.json');
  const runnerLog = path.join(sessionDir, 'pipeline-runner.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(runnerLog, line);
    process.stderr.write(line);
  };

  log('pipeline-runner started');

  // Auto-spawn the 4-pane monitor window. Matches mux-runner behaviour —
  // skill prompts no longer need a manual tmux-monitor.sh step.
  try {
    const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
    log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  } catch (err) {
    log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
  }

  let config: PipelineConfig;
  let pipelineRaw: Record<string, unknown>;
  try {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    pipelineRaw = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
    config = parsePipelineConfig(pipelineRaw);
  } catch (err) {
    throw new Error(`Cannot read pipeline.json: ${safeErrorMessage(err)}`);
  }

  // Validate state.json exists
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!fs.existsSync(statePath)) {
    throw new Error('state.json not found — run setup.js first');
  }

  let state: State;
  try {
    state = sm.read(statePath);
  } catch (err) {
    throw new Error(`Cannot read state.json: ${safeErrorMessage(err)}`);
  }
  const workingDir = state.working_dir || process.cwd();

  // Pre-flight: refuse to start on a dirty tree. Downstream phases auto-commit
  // on their own, which would roll the user's unrelated WIP into a pipeline
  // commit and obscure which phase changed what.
  assertCleanWorkingTree(workingDir);

  // Scope resolution (optional). argv > pipeline.json. Omitted → no scope.json,
  // no phases_entered — pipeline-runner behaves as it did pre-change.
  const scopeFlag = opts.scopeFlag ?? (typeof pipelineRaw.scope === 'string' ? pipelineRaw.scope : undefined);
  const scopeBase = opts.scopeBase ?? (typeof pipelineRaw.scope_base === 'string' ? pipelineRaw.scope_base : undefined);
  if (scopeFlag) {
    setupScope({
      sessionDir,
      workingDir,
      target: config.target || workingDir,
      scopeFlag,
      scopeBase,
      log,
    });
  }

  const startTime = Date.now();
  let completedPhases = 0;
  let skippedPhases = 0;

  const cancelMarker = path.join(sessionDir, 'pipeline-cancel');

  // Graceful shutdown — write cancel marker, kill the child runner (which
  // handles its own state cleanup), then exit. We do NOT write state.json
  // here to avoid a race where both the child and ours clobber the file.
  const handleShutdown = (signal: string) => {
    log(`Received ${signal} — shutting down pipeline`);
    try { fs.writeFileSync(cancelMarker, signal); } catch { /* best effort */ }
    try {
      writePipelineStatus(sessionDir, 'cancelled', {
        current_phase: null,
        completed_phases: completedPhases,
        skipped_phases: skippedPhases,
        total_phases: config.phases.length,
      });
    } catch { /* best effort */ }
    if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM');
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux' });
    process.exit(1);
  };
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGHUP', () => handleShutdown('SIGHUP'));

  writePipelineStatus(sessionDir, 'running', {
    current_phase: null,
    completed_phases: 0,
    skipped_phases: 0,
    total_phases: config.phases.length,
  });

  for (let i = 0; i < config.phases.length; i++) {
    const phase = config.phases[i];
    const phaseLabel = `${i + 1}/${config.phases.length}`;

    log(`\n${'═'.repeat(60)}`);
    log(`PHASE ${phaseLabel}: ${phase.toUpperCase()}`);
    log(`${'═'.repeat(60)}`);

    printMinimalPanel(`Pipeline Phase: ${phase}`, {
      Phase: phaseLabel,
      Target: config.target || workingDir,
    }, 'CYAN', '🧪');

    writePipelineStatus(sessionDir, 'running', {
      current_phase: phase,
      completed_phases: completedPhases,
      skipped_phases: skippedPhases,
      total_phases: config.phases.length,
    });

    let exitCode: number;

    if (phase === 'pickle') {
      // Ensure chain_meeseeks is off so mux-runner exits cleanly back to us
      // instead of transitioning to the deprecated meeseeks review loop.
      sm.update(statePath, s => { s.chain_meeseeks = false; });
      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'extension', 'bin', 'mux-runner.js'), sessionDir,
      ]);
    } else if (phase === 'anatomy-park') {
      cleanPhaseArtifacts(sessionDir, 'pickle');
      resetStateForPhase(statePath, 'anatomy-park.md', config.anatomy_max_iterations);

      try {
        const refreshed = refreshScope(sessionDir, 'anatomy-park', { repoRoot: workingDir, log });
        if (refreshed) {
          writeSkippedByScope(sessionDir, 'anatomy-park', refreshed, config.target || workingDir, workingDir);
        }
      } catch (err) {
        if (err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_POST_BUILD') {
          log(`SCOPE_EMPTY_POST_BUILD at anatomy-park — ${err.message}`);
          writePipelineStatus(sessionDir, 'failed', {
            current_phase: 'anatomy-park',
            completed_phases: completedPhases,
            skipped_phases: skippedPhases,
            total_phases: config.phases.length,
          });
          throw err;
        }
        throw err;
      }

      const setupOk = setupAnatomyPark(
        sessionDir, config.target || workingDir,
        config.anatomy_stall_limit, extensionRoot, log,
      );
      if (!setupOk) {
        skippedPhases++;
        writePipelineStatus(sessionDir, 'running', {
          current_phase: null,
          completed_phases: completedPhases,
          skipped_phases: skippedPhases,
          total_phases: config.phases.length,
        });
        log(`Phase ${phase} skipped (setup returned false)`);
        continue;
      }

      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'extension', 'bin', 'microverse-runner.js'), sessionDir,
      ]);
    } else if (phase === 'szechuan-sauce') {
      cleanPhaseArtifacts(sessionDir, 'anatomy-park');
      resetStateForPhase(statePath, 'szechuan-sauce.md', config.szechuan_max_iterations);

      const refreshedSz = refreshScope(sessionDir, 'szechuan-sauce', { repoRoot: workingDir, log });
      if (refreshedSz) {
        writeSkippedByScope(sessionDir, 'szechuan-sauce', refreshedSz, config.target || workingDir, workingDir);
      }

      const setupOk = setupSzechuanSauce(
        sessionDir, config.target || workingDir,
        config.szechuan_stall_limit, extensionRoot,
        config.szechuan_domain, config.szechuan_focus, log,
      );
      if (!setupOk) {
        skippedPhases++;
        writePipelineStatus(sessionDir, 'running', {
          current_phase: null,
          completed_phases: completedPhases,
          skipped_phases: skippedPhases,
          total_phases: config.phases.length,
        });
        log(`Phase ${phase} skipped (setup returned false)`);
        continue;
      }

      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'extension', 'bin', 'microverse-runner.js'), sessionDir,
      ]);
    } else {
      log(`Unknown phase: ${phase} — skipping`);
      continue;
    }

    log(`Phase ${phase} exited with code ${exitCode}`);

    // Known limitation: if the child is cancelled externally (eat-pickle,
    // external SIGTERM to child PID), it exits 0 (mux-runner maps 'cancelled'
    // to exit 0). Pipeline cannot distinguish this from genuine success.
    // Full pipeline stop = kill the tmux session or SIGTERM the pipeline PID.
    if (exitCode !== 0) {
      log(`Phase ${phase} failed (exit ${exitCode}) — stopping pipeline`);
      break;
    }

    completedPhases++;
    writePipelineStatus(sessionDir, 'running', {
      current_phase: null,
      completed_phases: completedPhases,
      skipped_phases: skippedPhases,
      total_phases: config.phases.length,
    });

    // Check for cancellation (signal handler writes this marker)
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (fs.existsSync(cancelMarker)) {
      log('Pipeline cancelled (cancel marker found) — stopping');
      break;
    }

    log(`Phase ${phase} completed successfully`);
  }

  // Finalize
  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  try { sm.update(statePath, s => { s.active = false; }); } catch { /* already inactive */ }

  const phasesSummary = skippedPhases > 0
    ? `${completedPhases}/${config.phases.length} (${skippedPhases} skipped)`
    : `${completedPhases}/${config.phases.length}`;

  printMinimalPanel('Pipeline Complete', {
    Phases: phasesSummary,
    Elapsed: formatTime(totalElapsed),
  }, 'GREEN', '🧪');

  log(`Pipeline finished: ${phasesSummary} phases, ${formatTime(totalElapsed)}`);

  logActivity({
    event: 'session_end', source: 'pickle',
    session: path.basename(sessionDir),
    duration_min: Math.round(totalElapsed / 60),
    mode: 'tmux',
  });

  // macOS notification
  if (process.platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const allDone = (completedPhases + skippedPhases) === config.phases.length;
    const title = allDone ? '🧪 Pipeline Complete' : '🧪 Pipeline Stopped';
    const body = `${phasesSummary} phases, ${formatTime(totalElapsed)}`;
    try {
      execFileSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
    } catch { /* best effort */ }
  }

  // Clean up cancel marker
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  try { fs.unlinkSync(cancelMarker); } catch { /* may not exist */ }

  // Explicit exit code so callers can detect pipeline failure.
  // Skipped phases (e.g. no subsystems for anatomy-park) are not failures.
  const pipelineFailed = (completedPhases + skippedPhases) < config.phases.length;
  writePipelineStatus(sessionDir, pipelineFailed ? 'failed' : 'completed', {
    current_phase: null,
    completed_phases: completedPhases,
    skipped_phases: skippedPhases,
    total_phases: config.phases.length,
  });
  process.exit(pipelineFailed ? 1 : 0);
}

/** Extract the value following `flag` in argv, or `undefined` if absent. */
function parseArgvFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

/** First argv token that's not a flag and not the value of a preceding flag. */
function findPositional(argv: string[], valuedFlags: Set<string>): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const prev = i > 0 ? argv[i - 1] : '';
    if (argv[i].startsWith('--')) continue;
    if (valuedFlags.has(prev)) continue;
    return argv[i];
  }
  return undefined;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'pipeline-runner.js') {
  const argv = process.argv.slice(2);
  const valuedFlags = new Set(['--scope', '--scope-base']);
  const sessionDir = findPositional(argv, valuedFlags);
  if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
    console.error('Usage: node pipeline-runner.js <session-dir> [--scope <flag>] [--scope-base <ref>]');
    process.exit(1);
  }
  const scopeFlag = parseArgvFlag(argv, '--scope');
  const scopeBase = parseArgvFlag(argv, '--scope-base');
  main(sessionDir, { scopeFlag, scopeBase }).catch((err) => {
    try {
      writePipelineStatus(sessionDir, 'failed');
    } catch { /* best effort */ }
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
