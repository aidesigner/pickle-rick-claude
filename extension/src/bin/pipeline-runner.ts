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
} from '../services/pickle-utils.js';
import { logActivity } from '../services/activity-logger.js';

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
      path.join(extensionRoot, 'bin', 'init-microverse.js'),
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
    path.join(extensionRoot, 'bin', 'init-microverse.js'),
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

export async function main(sessionDir: string): Promise<void> {
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

  let config: PipelineConfig;
  try {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    const raw = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
    config = parsePipelineConfig(raw);
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
    if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM');
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux' });
    process.exit(1);
  };
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGHUP', () => handleShutdown('SIGHUP'));

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

    let exitCode: number;

    if (phase === 'pickle') {
      // Ensure chain_meeseeks is off so mux-runner exits cleanly back to us
      // instead of transitioning to the deprecated meeseeks review loop.
      sm.update(statePath, s => { s.chain_meeseeks = false; });
      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'bin', 'mux-runner.js'), sessionDir,
      ]);
    } else if (phase === 'anatomy-park') {
      cleanPhaseArtifacts(sessionDir, 'pickle');
      resetStateForPhase(statePath, 'anatomy-park.md', config.anatomy_max_iterations);

      const setupOk = setupAnatomyPark(
        sessionDir, config.target || workingDir,
        config.anatomy_stall_limit, extensionRoot, log,
      );
      if (!setupOk) { skippedPhases++; log(`Phase ${phase} skipped (setup returned false)`); continue; }

      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'bin', 'microverse-runner.js'), sessionDir,
      ]);
    } else if (phase === 'szechuan-sauce') {
      cleanPhaseArtifacts(sessionDir, 'anatomy-park');
      resetStateForPhase(statePath, 'szechuan-sauce.md', config.szechuan_max_iterations);

      const setupOk = setupSzechuanSauce(
        sessionDir, config.target || workingDir,
        config.szechuan_stall_limit, extensionRoot,
        config.szechuan_domain, config.szechuan_focus, log,
      );
      if (!setupOk) { skippedPhases++; log(`Phase ${phase} skipped (setup returned false)`); continue; }

      exitCode = await spawnRunner('node', [
        path.join(extensionRoot, 'bin', 'microverse-runner.js'), sessionDir,
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
  process.exit(pipelineFailed ? 1 : 0);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'pipeline-runner.js') {
  const sessionDir = process.argv[2];
  if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
    console.error('Usage: node pipeline-runner.js <session-dir>');
    process.exit(1);
  }
  main(sessionDir).catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
