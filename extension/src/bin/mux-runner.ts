#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, collectTickets, getTicketStatus, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification, parseTicketFrontmatter, getTicketTierBudgetWithOverrides, readFrontmatterField, upsertFrontmatterField, hasCompletionCommit, ticketFilePath, VALID_TICKET_COMPLEXITY_TIERS, composeManagerPromptFromSkill, resolveWorkerTestGateTimeoutMs, type TicketInfo, type TicketStatus, type TicketTierBudget } from '../services/pickle-utils.js';
import { State, PromiseTokens, hasToken, VALID_STEPS, Defaults, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact, type Backend, type RateLimitInfo, type IterationExitResult, type IterationOutcome, type RateLimitAction, type WorkerRole, type Step } from '../types/index.js';
import { StateManager, safeDeactivate, finalizeTerminalState, recordExitReason, clearExitReason, writeActivityEntry, writeTimeoutStub, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerState } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, resolveBackendFromStateFileWithSource, backendEnvOverrides } from '../services/backend-spawn.js';
import { resolveCodexModel } from './spawn-morty.js';
import { autoFillCompletionCommit } from './auto-fill-completion-commit.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { extractAssistantContent, detectOutputFormat, observeCodexToolCallStream, CODEX_DELIMITER_RE } from '../services/classifier-utils.js';
import { updateTicketStatusInTransaction } from '../services/transaction-ticket-ops.js';
import { emitCrossTicketRegressionLinearComment } from '../lib/linear-comment.js';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
  type ManagerRelaunchExitKind,
} from '../services/manager-relaunch.js';
import { getHeadBranch } from '../services/git-utils.js';
export { extractAssistantContent, detectOutputFormat, observeCodexToolCallStream } from '../services/classifier-utils.js';
export { hasCompletionCommit, stripSetupSection } from '../services/pickle-utils.js';
export {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../services/manager-relaunch.js';
export {
  evaluateManagerRelaunch as evaluateCodexManagerRelaunch,
  recordManagerRelaunch as recordCodexManagerRelaunch,
} from '../services/manager-relaunch.js';

const sm = new StateManager();

let currentChildProc: import('child_process').ChildProcess | null = null;
let qualityGateLegacyWarningLogged = false; // R-MUXQG test-reset contract — see prds/p1-bug-fix-bundle-b-release-drift-2026-05-26.md

export interface OrphanDetectionResult {
  orphan_session_path: string;
  orphan_started_at: number;
  parent_session_hash: string;
  orphan_pid: number;
}

function readSiblingState(siblingStatePath: string): Record<string, unknown> | null {
  try {
    const recovered = readRecoverableJsonObject(siblingStatePath);
    if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered)) return null;
    return recovered as Record<string, unknown>;
  } catch { return null; }
}

function siblingQualifiesAsOrphan(
  sibling: Record<string, unknown>,
  parentWorkingDir: string | undefined,
): { qualifies: boolean; parentHash: string | null } {
  const parentHash = typeof sibling.parent_session_hash === 'string' && sibling.parent_session_hash
    ? sibling.parent_session_hash : null;
  const isManagerSubprocess = sibling.invocation_source === 'manager_subprocess';
  if (!parentHash && !isManagerSubprocess) return { qualifies: false, parentHash };
  if (sibling.working_dir !== parentWorkingDir) return { qualifies: false, parentHash };
  return { qualifies: true, parentHash };
}

/** Scans session directories for orphaned pickle-rick processes. */
export function detectOrphanSessions(
  state: State,
  dataRoot: string,
  sessionDir: string,
): OrphanDetectionResult[] {
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const parentWorkingDir = state.working_dir;
  const results: OrphanDetectionResult[] = [];
  const alreadyDetected = new Set(Array.isArray(state.orphans_detected) ? state.orphans_detected : []);
  let entries: string[];
  try { entries = fs.readdirSync(sessionsRoot); } catch { return results; }
  for (const entry of entries) {
    if (path.join(sessionsRoot, entry) === sessionDir) continue;
    if (alreadyDetected.has(entry)) continue;
    const sibling = readSiblingState(path.join(sessionsRoot, entry, 'state.json'));
    if (!sibling) continue;
    const { qualifies, parentHash } = siblingQualifiesAsOrphan(sibling, parentWorkingDir);
    if (!qualifies) continue;
    results.push({
      orphan_session_path: path.join(sessionsRoot, entry),
      orphan_started_at: typeof sibling.start_time_epoch === 'number' ? sibling.start_time_epoch : 0,
      parent_session_hash: parentHash ?? 'unknown',
      orphan_pid: typeof sibling.pid === 'number' ? sibling.pid : 0,
    });
  }
  return results;
}

/**
 * R-WSRC-2: schema-ahead graceful exit at the top-of-loop state read.
 *
 * `sm.read()` throws `SchemaVersionAheadError` (R-WSRC-1) or a raw
 * `SCHEMA_MISMATCH` `StateError` when `state.json` carries a `schema_version`
 * newer than the currently-deployed runtime supports (e.g., a worker writes a
 * forward-schema state in violation of `send-to-morty.md:61`, or a mid-deploy
 * schema bump leaves the on-disk file ahead of the running binary). Before
 * R-WSRC-2, only the cap-check site routed SCHEMA_MISMATCH to `'continue'`;
 * every other read site threw upward, the outer loop retried, and the runner
 * wedged at 1 warn/sec indefinitely (R-QGSK-3 incident class).
 *
 * The wrapper catches both error shapes and forces a graceful, attributable
 * exit: stamp `exit_reason = 'state_schema_version_ahead'`, deactivate, then
 * `process.exit(3)` (PipelineRunnerExitCode.PhaseIncomplete) so auto-resume.sh
 * R-CNAR-4(c) stops the loop instead of running the operator's budget down.
 */
export function readRunnerState(statePath: string): State {
  try {
    return sm.read(statePath);
  } catch (err) {
    if (isSchemaVersionAheadError(err)) {
      handleSchemaVersionAhead(statePath, err);
    }
    throw err;
  }
}

export function isSchemaVersionAheadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string };
  return e.code === 'SCHEMA_MISMATCH' || e.name === 'SchemaVersionAheadError';
}

function handleSchemaVersionAhead(statePath: string, err: unknown): never {
  const msg = safeErrorMessage(err);
  try {
    process.stderr.write(
      `[FATAL] state.json schema is ahead of this runtime: ${msg}. ` +
      `Exiting with state_schema_version_ahead (code 3).\n`,
    );
  } catch { /* stderr write must not crash the exit path */ }
  // recordExitReason + safeDeactivate go through forceWriteMutate, which itself
  // calls sm.read(); on a schema-ahead state.json those reads also fail and the
  // forensic stamp is dropped. Bypass via a direct forceWrite of the minimal
  // forensic envelope. The on-disk forward-schema state is sacrificed (it was
  // unreadable anyway) in favor of a parseable {active:false, exit_reason:...}
  // record so dead-pid recovery, stop-hook, and auto-resume.sh R-CNAR-4(c) all
  // see the exit attribution.
  try {
    // R-WSRC-2: lock cannot be acquired because the lock-protected path
    // (StateManager.update → sm.read) fails on SCHEMA_MISMATCH; the whole
    // point of this handler is to replace the unreadable state with a
    // minimal forensic envelope so subsequent reads work.
    // eslint-disable-next-line pickle/no-raw-state-write
    sm.forceWrite(statePath, { active: false, exit_reason: 'state_schema_version_ahead' });
  } catch { /* never throw on forensic stamp */ }
  try { recordExitReason(statePath, 'state_schema_version_ahead'); } catch { /* never throw on forensic stamp */ }
  try { safeDeactivate(statePath); } catch { /* never throw on deactivate */ }
  process.exit(3);
}

function removeRunnerSessionMapEntry(statePath: string, log: (msg: string) => void): void {
  const sessionsMapPath = path.join(getDataRoot(), 'current_sessions.json');
  const sessionDir = path.dirname(statePath);
  const cwd = (() => {
    try {
      const state = readRunnerState(statePath);
      return typeof state.working_dir === 'string' ? state.working_dir : '';
    } catch {
      return '';
    }
  })();
  if (!cwd) return;
  try {
    const map = (readRecoverableJsonObject(sessionsMapPath) || {}) as Record<string, unknown>;
    let removed = false;
    for (const [entryCwd, entryValue] of Object.entries(map)) {
      const mappedSessionPath =
        typeof entryValue === 'string'
          ? entryValue
          : (entryValue && typeof entryValue === 'object' && typeof (entryValue as Record<string, unknown>).sessionPath === 'string')
              ? String((entryValue as Record<string, unknown>).sessionPath)
              : '';
      if (entryCwd === cwd || (mappedSessionPath && path.resolve(mappedSessionPath) === path.resolve(sessionDir))) {
        delete map[entryCwd];
        removed = true;
      }
    }
    if (!removed) return;
    const tmpMap = `${sessionsMapPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
      fs.renameSync(tmpMap, sessionsMapPath);
    } catch (err) {
      try { fs.unlinkSync(tmpMap); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  } catch (err) {
    log(`WARNING: failed to remove current_sessions.json entry for forensic exit: ${safeErrorMessage(err)}`);
  }
}

export function killCurrentChild(): void {
  if (currentChildProc && !currentChildProc.killed) {
    currentChildProc.kill('SIGTERM');
  }
}

interface IterationRuntimeOverrides {
  envOverrides?: NodeJS.ProcessEnv;
  maxIterationSeconds?: number;
  outputStallSeconds?: number;
}

const TASK_NOTE_PRIORITY: Record<string, number> = {
  'Next': 0,
  'Dead Ends': 1,
  'Key Discoveries': 2,
  'Progress': 3,
};

const TASK_NOTE_TRUNC_MARKER = '[truncated]';

interface TaskNoteSection { name: string; body: string; }

function parseTaskNoteSections(content: string): { preamble: string; sections: TaskNoteSection[] } {
  const sectionRegex = /^## .+$/gm;
  const sections: TaskNoteSection[] = [];
  let preamble = '';
  let lastIndex = 0;
  let lastHeader = '';
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(content)) !== null) {
    if (lastIndex === 0 && match.index > 0) {
      preamble = content.slice(0, match.index);
    } else if (lastHeader) {
      sections.push({ name: lastHeader, body: content.slice(lastIndex, match.index) });
    }
    lastHeader = match[0].replace(/^## /, '').trim();
    lastIndex = match.index;
  }
  if (lastHeader) {
    sections.push({ name: lastHeader, body: content.slice(lastIndex) });
  }
  return { preamble, sections };
}

function priorityFor(name: string): number {
  return TASK_NOTE_PRIORITY[name] ?? 3;
}

type WorkerGateFailureSummaryEvent = {
  event: 'worker_gate_failed';
  ticket_id?: string;
  gate_phase?: string;
  retry_count?: number;
  failures?: Array<{
    name?: string;
    file?: string;
    message?: string;
  }>;
  ts?: string;
};

export type BetweenTicketGateFailure = {
  name: string;
  file: string;
};

export type BetweenTicketGateResult = {
  ok: boolean;
  failures: BetweenTicketGateFailure[];
  timed_out: boolean;
  timeout_ms: number | null;
};

export interface OrphanedFastTestRunner {
  pid: number;
  ppid: number;
  etime_seconds: number;
  argv_summary: string;
}

type RunBetweenTicketFastGateInput = {
  statePath: string;
  workingDir: string;
  completedTicketId: string;
  nextTicketId: string | null;
  landedStatus: string | null | undefined;
  log: (msg: string) => void;
  now?: () => number;
  runTestFast?: (extensionDir: string) => BetweenTicketGateResult;
};

function parsePsElapsedSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const [dayPart, clockPart] = value.includes('-') ? value.split('-', 2) : [null, value];
  const segments = clockPart.split(':').map(segment => Number(segment));
  if (segments.some(segment => !Number.isFinite(segment) || segment < 0)) return null;
  const days = dayPart === null ? 0 : Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return null;
  if (segments.length === 2) {
    const [minutes, seconds] = segments;
    return (days * 86400) + (minutes * 60) + seconds;
  }
  if (segments.length === 3) {
    const [hours, minutes, seconds] = segments;
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
  }
  return null;
}

function isFastTestRunnerCommand(command: string, extensionDir: string): boolean {
  if (!command.includes(extensionDir)) return false;
  const normalized = command.replace(/\s+/g, ' ').trim();
  const isNpmFastTest = /\bnpm(?:\s|$)/.test(normalized) && normalized.includes('run test:fast');
  const isNodeTestChild = /\bnode(?:\s|$)/.test(normalized) && normalized.includes('--test');
  return isNpmFastTest || isNodeTestChild;
}

export function parseOrphanedFastTestRunnersFromPs(
  psOutput: string,
  extensionDir: string,
  minAgeSeconds = 600,
): OrphanedFastTestRunner[] {
  const results: OrphanedFastTestRunner[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const rawPid = Number(match[1]);
    const rawPpid = Number(match[2]);
    const pid = Number.isFinite(rawPid) ? rawPid : 0;
    const ppid = Number.isFinite(rawPpid) ? rawPpid : 0;
    const etimeSeconds = parsePsElapsedSeconds(match[3]);
    const command = match[4].trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || etimeSeconds === null) continue;
    if (ppid !== 1) continue;
    if (etimeSeconds <= minAgeSeconds) continue;
    if (!isFastTestRunnerCommand(command, extensionDir)) continue;
    results.push({
      pid,
      ppid,
      etime_seconds: etimeSeconds,
      argv_summary: command,
    });
  }
  return results;
}

export function reapOrphanedFastTestRunnersOnStartup(
  statePath: string,
  extensionDir: string,
  log: (msg: string) => void,
  opts: {
    psOutput?: string;
    scan?: (extensionDir: string) => string;
    kill?: (pid: number) => void;
  } = {},
): OrphanedFastTestRunner[] {
  const scan = opts.scan ?? (() => execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 1024 * 1024 * 8,
  }));
  const kill = opts.kill ?? ((pid: number) => {
    process.kill(pid, 'SIGKILL');
  });
  const psOutput = opts.psOutput ?? scan(extensionDir);
  const orphans = parseOrphanedFastTestRunnersFromPs(psOutput, extensionDir);
  for (const orphan of orphans) {
    kill(orphan.pid);
    writeActivityEntry(statePath, {
      event: 'orphan_test_runner_reaped',
      ts: new Date().toISOString(),
      pid: orphan.pid,
      etime_seconds: orphan.etime_seconds,
      argv_summary: orphan.argv_summary,
    });
    log(`reaped orphan fast-test runner pid=${orphan.pid} etime_seconds=${orphan.etime_seconds}`);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// R-OMS: orphan manager reaping at iteration boundaries
// ---------------------------------------------------------------------------

/** R-OMS-1: Write the active manager pid sidecar. */
export function writeActivePidFile(sessionDir: string, pid: number): void {
  fs.writeFileSync(path.join(sessionDir, '.active_manager.pid'), String(pid));
}

/** R-OMS-1: Clear the active manager pid sidecar (ENOENT-safe). */
export function clearActivePidFile(sessionDir: string): void {
  try {
    fs.unlinkSync(path.join(sessionDir, '.active_manager.pid'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** R-OMS-2: Parse orphaned claude manager processes from ps output. */
export function parseOrphanedManagersFromPs(
  psOutput: string,
  sessionDir: string,
): Array<{ pid: number; argv_summary: string }> {
  const results: Array<{ pid: number; argv_summary: string }> = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const rawPid = Number(match[1]);
    if (!Number.isInteger(rawPid) || rawPid <= 0) continue;
    const command = match[4].trim();
    // Must be the claude binary
    const binaryPart = command.split(/\s+/)[0] ?? '';
    if (path.basename(binaryPart) !== 'claude') continue;
    // Must have --dangerously-skip-permissions
    if (!command.includes('--dangerously-skip-permissions')) continue;
    // Must reference this sessionDir
    if (!command.includes(sessionDir)) continue;
    results.push({ pid: rawPid, argv_summary: command });
  }
  return results;
}

/** R-OMS-2: Reap stray manager processes at iteration_start before spawning a new one. */
export function reapOrphanedManagersAtIterationStart(
  statePath: string,
  sessionDir: string,
  log: (msg: string) => void,
  opts: {
    psOutput?: string;
    kill?: (pid: number) => void;
  } = {},
): Array<{ pid: number; argv_summary: string }> {
  const kill = opts.kill ?? ((pid: number) => { process.kill(pid, 'SIGTERM'); });
  const psOutput = opts.psOutput ?? execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 1024 * 1024 * 8,
  });

  // Build suspect set: ps-scan first, then pidfile
  const suspects = new Map<number, string>();
  for (const orphan of parseOrphanedManagersFromPs(psOutput, sessionDir)) {
    suspects.set(orphan.pid, orphan.argv_summary);
  }

  // Add pid from sidecar pidfile (covers processes that exited but left the pidfile)
  const pidfilePath = path.join(sessionDir, '.active_manager.pid');
  try {
    const raw = fs.readFileSync(pidfilePath, 'utf-8').trim();
    const pidFromFile = Number(raw);
    if (Number.isInteger(pidFromFile) && pidFromFile > 0 && !suspects.has(pidFromFile)) {
      suspects.set(pidFromFile, 'from-pidfile');
    }
  } catch {
    // ENOENT or unreadable — no pidfile, skip
  }

  const reaped: Array<{ pid: number; argv_summary: string }> = [];
  for (const [pid, argv_summary] of suspects) {
    if (pid === process.pid) continue; // never kill self
    try { kill(pid); } catch { /* best effort — process may have already exited */ }
    writeActivityEntry(statePath, {
      event: 'orphan_manager_reaped',
      ts: new Date().toISOString(),
      pid,
      argv_summary,
    });
    log(`reaped orphan manager pid=${pid}`);
    reaped.push({ pid, argv_summary });
  }
  return reaped;
}

function normalizeBetweenTicketFailureFile(rawFile: string, workingDir: string): string {
  const trimmed = rawFile.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\\/g, '/');
  if (!path.isAbsolute(normalized)) return normalized;
  const relative = path.relative(workingDir, normalized).replace(/\\/g, '/');
  return relative.startsWith('..') ? normalized : relative;
}

export function parseBetweenTicketFastGateFailures(output: string, workingDir: string): BetweenTicketGateFailure[] {
  const failures: BetweenTicketGateFailure[] = [];
  const lines = output.split(/\r?\n/);
  let activeFailure: BetweenTicketGateFailure | null = null;

  const flushFailure = () => {
    if (!activeFailure) return;
    failures.push({
      name: activeFailure.name,
      file: activeFailure.file,
    });
    activeFailure = null;
  };

  for (const line of lines) {
    const failureStart = line.match(/^not ok(?:\s+\d+)?\s+-\s+(.+)$/);
    if (failureStart) {
      flushFailure();
      activeFailure = { name: failureStart[1].trim(), file: '' };
      continue;
    }
    if (!activeFailure) continue;
    if (line.trim() === '...') {
      flushFailure();
      continue;
    }
    const locationMatch = line.match(/location:\s*'([^']+)'/) ?? line.match(/location:\s*"([^"]+)"/);
    if (locationMatch && !activeFailure.file) {
      activeFailure.file = normalizeBetweenTicketFailureFile(locationMatch[1], workingDir);
    }
  }

  flushFailure();
  if (failures.length > 0) return failures;

  const fallback = lines.map(line => line.trim()).find(Boolean) ?? 'npm run test:fast failed';
  return [{ name: fallback, file: '' }];
}

export function runBetweenTicketFastTests(
  extensionDir: string,
  extensionRoot = getExtensionRoot(),
): BetweenTicketGateResult {
  const timeoutMs = resolveWorkerTestGateTimeoutMs(extensionRoot);
  const result = spawnSync('npm', ['run', 'test:fast'], {
    cwd: extensionDir,
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  const timedOut =
    (result.error?.name === 'Error' && result.error.message.includes('ETIMEDOUT')) ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (timedOut) {
    return {
      ok: false,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
      timed_out: true,
      timeout_ms: timeoutMs,
    };
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    ok: result.status === 0,
    failures: result.status === 0
      ? []
      : parseBetweenTicketFastGateFailures(output, path.dirname(extensionDir)),
    timed_out: false,
    timeout_ms: timeoutMs,
  };
}

export function runBetweenTicketFastGate(input: RunBetweenTicketFastGateInput): BetweenTicketGateResult | null {
  const extensionDir = path.join(input.workingDir, 'extension');
  if (!fs.existsSync(extensionDir)) return null;

  const runTestFast = input.runTestFast ?? runBetweenTicketFastTests;
  const ts = (input.now ?? Date.now)();
  const result = runTestFast(extensionDir);

  sm.update(input.statePath, state => {
    state.last_between_ticket_gate = {
      ts,
      ok: result.ok,
      failures: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
      })),
      timed_out: result.timed_out,
      timeout_ms: result.timeout_ms,
    };
  });

  if (result.timed_out) {
    writeActivityEntry(input.statePath, {
      event: 'between_ticket_gate_timeout',
      ts: new Date(ts).toISOString(),
      ticket_id: input.nextTicketId || input.completedTicketId,
      prior_ticket_id: input.completedTicketId,
      gate_payload: {
        command: 'npm run test:fast',
        timeout_ms: result.timeout_ms,
      },
    });
  }

  if (!result.ok && normalizedStatus(input.landedStatus) === 'done') {
    writeActivityEntry(input.statePath, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(ts).toISOString(),
      ticket_id: input.nextTicketId || input.completedTicketId,
      prior_ticket_id: input.completedTicketId,
      failing_tests: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
      })),
    });
    emitCrossTicketRegressionLinearComment({
      sessionDir: path.dirname(input.statePath),
      priorTicketId: input.completedTicketId,
      regressedTicketId: input.nextTicketId || input.completedTicketId,
      failingTests: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
      })),
      log: input.log,
    });
  }

  input.log(
    `between-ticket fast gate for ${input.completedTicketId}: ${result.ok ? 'passed' : `failed (${result.failures.length} failure(s))`}`,
  );
  return result;
}

function formatWorkerGateFailureLine(failure: { name?: string; file?: string; message?: string }): string {
  const label = failure.file || failure.name || 'unknown';
  const message = failure.message || failure.name || 'unknown failure';
  return `  - ${label}: ${message}`;
}

export function buildWorkerGateFailureSummary(state: Partial<State>): string {
  const events = (Array.isArray(state.activity) ? state.activity : [])
    .filter((entry): entry is WorkerGateFailureSummaryEvent => entry?.event === 'worker_gate_failed')
    .slice(-3);
  if (events.length === 0) return '';

  const lines = ['=== RECENT WORKER GATE FAILURES ==='];
  for (const entry of events) {
    lines.push(
      `worker_gate_failed ticket_id=${entry.ticket_id || 'unknown'} gate_phase=${entry.gate_phase || 'unknown'} retry_count=${Number.isInteger(entry.retry_count) ? entry.retry_count : 0}`,
    );
    const failures = Array.isArray(entry.failures) ? entry.failures.slice(0, 3) : [];
    if (failures.length === 0) {
      lines.push('  - unknown: no structured failures recorded');
      continue;
    }
    for (const failure of failures) {
      lines.push(formatWorkerGateFailureLine(failure));
    }
  }
  return lines.join('\n');
}

function buildIterationHandoffSummary(state: Partial<State>, sessionDir: string, iterationNum?: number): string {
  const handoffSummary = buildHandoffSummary(state, sessionDir, iterationNum);
  const workerGateFailureSummary = buildWorkerGateFailureSummary(state);
  return workerGateFailureSummary ? `${handoffSummary}\n\n${workerGateFailureSummary}` : handoffSummary;
}

/**
 * Truncate TASK_NOTES.md content with section-aware priority.
 * Preserves ## Next and ## Dead Ends fully, trims ## Progress from oldest.
 * Sections without recognized headers are treated as Progress.
 */
export function truncateTaskNotes(content: string, maxChars: number = 2000): string {
  if (!content || !content.trim()) return '';
  if (content.length <= maxChars) return content;

  const { preamble, sections } = parseTaskNoteSections(content);

  // No recognized sections — treat entire content as trimmable from top
  if (sections.length === 0) {
    const marker = `${TASK_NOTE_TRUNC_MARKER}\n`;
    return marker + content.slice(content.length - (maxChars - marker.length));
  }

  // Phase 1: Drop Progress/unrecognized sections; add back the tail of the
  // most recent Progress section if any budget remains.
  const withoutProgress = sections.filter(s => priorityFor(s.name) < 3);
  let result = preamble + withoutProgress.map(s => s.body).join('');
  if (result.length <= maxChars) {
    const progress = sections.filter(s => priorityFor(s.name) === 3);
    const remaining = maxChars - result.length;
    if (remaining > 20 && progress.length > 0) {
      const tail = progress[progress.length - 1].body;
      result += `\n${TASK_NOTE_TRUNC_MARKER}\n` + tail.slice(tail.length - remaining);
    }
    return result.length <= maxChars ? result : result.slice(0, maxChars);
  }

  // Phase 2: Drop Key Discoveries too.
  const highPriority = sections.filter(s => priorityFor(s.name) <= 1);
  result = preamble + highPriority.map(s => s.body).join('');
  if (result.length <= maxChars) return `${result}\n${TASK_NOTE_TRUNC_MARKER}`;

  // Phase 3: Hard truncate from end.
  return result.slice(0, maxChars - (TASK_NOTE_TRUNC_MARKER.length + 2)) + `\n${TASK_NOTE_TRUNC_MARKER}`;
}

/**
 * R-MRFP: resolves a directory to its enclosing git repository root. Falls
 * back to the absolute directory path when it is not inside a git repo (or
 * does not exist), so forward-created dirs still get a stable identity.
 */
function resolveRepoRoot(dir: string, stableBase: string): string {
  const absDir = path.isAbsolute(dir) ? dir : path.resolve(stableBase, dir);
  try {
    const out = execFileSync('git', ['-C', absDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch { /* not a git repo / missing dir — fall back to the path itself */ }
  return absDir;
}

/**
 * Detects whether tickets in a session span multiple repositories.
 * Returns an array of distinct repo roots if 2+, null otherwise.
 * Tickets with working_dir: null are excluded (they use session default).
 *
 * R-MRFP: dedupe by the enclosing git repo root, not the raw working_dir
 * string. A monorepo with per-workspace working_dirs (`packages/api`,
 * `packages/app`, repo root) is ONE repo — flagging it as multi-repo is a
 * false positive that spams the iteration-1 log on every relaunch.
 */
export function detectMultiRepo(sessionDir: string, stableBase: string): string[] | null {
  const tickets = collectTickets(sessionDir);
  const dirs = new Set(
    tickets
      .map(t => t.working_dir)
      .filter((d): d is string => d !== null && d !== undefined)
  );
  const roots = new Set([...dirs].map(d => resolveRepoRoot(d, stableBase)));
  return roots.size >= 2 ? [...roots] : null;
}

type MuxLifecycleStep = Extract<Step, 'research' | 'plan' | 'implement' | 'review'>;

const MUX_LIFECYCLE_ORDER: Record<MuxLifecycleStep, number> = {
  research: 0,
  plan: 1,
  implement: 2,
  review: 3,
};

function normalizeTicketStatus(status: string | null): string {
  return (status || '').toLowerCase().replace(/["']/g, '').trim();
}

function writeTicketStatus(sessionDir: string, ticketId: string, status: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, status, sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

function chooseInProgressWinner(inProgress: readonly { id: string | null }[], currentTicket: string | null): string | null {
  if (currentTicket && inProgress.some(ticket => ticket.id === currentTicket)) return currentTicket;
  return inProgress.find(ticket => !!ticket.id)?.id ?? currentTicket;
}

export interface TicketDesyncResolution {
  winner: string | null;
  action: 'sync' | 'noop';
}

function collectFrontmatterInProgress(frontmatterStatuses: Map<string, TicketStatus>): { id: string }[] {
  const inProgress: { id: string }[] = [];
  for (const [ticketId, status] of frontmatterStatuses.entries()) {
    if (normalizedStatus(status) === 'in progress') {
      inProgress.push({ id: ticketId });
    }
  }
  return inProgress;
}

function hasManagerHandoffSnapshot(sessionDir: string, currentTicket: string | null): boolean {
  if (!currentTicket) return false;
  if (typeof sessionDir !== 'string' || !sessionDir) return false;
  return readLatestTicketConformanceSnapshot(path.join(sessionDir, currentTicket)).hasManagerHandoff;
}

function frontmatterStatusForCurrentTicket(state: State, frontmatterStatuses: Map<string, TicketStatus>): string {
  const currentTicket = typeof state.current_ticket === 'string' ? state.current_ticket : null;
  if (!currentTicket) return '';
  return normalizedStatus(frontmatterStatuses.get(currentTicket) ?? '');
}

function alreadyInSync(state: State, inProgress: readonly { id: string }[]): boolean {
  if (inProgress.length !== 1) return false;
  const currentTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  return !!currentTicket && inProgress.some(ticket => ticket.id === currentTicket);
}

function shouldSkipDesyncSync(state: State, sessionDir: string, inProgress: readonly { id: string }[], frontmatterStatuses: Map<string, TicketStatus>): boolean {
  if (inProgress.length !== 0) return false;
  const currentStatus = frontmatterStatusForCurrentTicket(state, frontmatterStatuses);
  if (currentStatus !== 'failed' && currentStatus !== 'done') return false;
  if (currentStatus === 'failed') return true;
  return hasManagerHandoffSnapshot(sessionDir, typeof state.current_ticket === 'string' ? state.current_ticket : null);
}

export function resolveTicketDesyncWinner(state: State, frontmatterStatuses: Map<string, TicketStatus>, sessionDir = ''): TicketDesyncResolution {
  const currentTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  const inProgress = collectFrontmatterInProgress(frontmatterStatuses);
  const winner = chooseInProgressWinner(inProgress, currentTicket);
  if (frontmatterStatuses.size === 0) {
    return { winner: null, action: 'noop' };
  }
  if (alreadyInSync(state, inProgress)) {
    return { winner, action: 'noop' };
  }
  // Prefer the explicit sessionDir argument when callers pass it; fall back to
  // state.session_dir for legacy callers (tests built around the typed signature).
  const effectiveSessionDir = sessionDir || (typeof state.session_dir === 'string' ? state.session_dir : '');
  if (shouldSkipDesyncSync(state, effectiveSessionDir, inProgress, frontmatterStatuses)) {
    return { winner, action: 'noop' };
  }
  return { winner, action: 'sync' };
}

function reconcileInProgressSet(
  tickets: readonly { id: string | null }[],
  frontmatterStatuses: Map<string, TicketStatus>,
): { id: string; status: string }[] {
  const inProgress: { id: string; status: string }[] = [];
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    const status = normalizedStatus(frontmatterStatuses.get(ticket.id) ?? '');
    if (status === 'in progress') {
      inProgress.push({ id: ticket.id, status });
    }
  }

  return inProgress;
}

function applyTicketDesyncWrites(sessionDir: string, winner: string, inProgress: readonly { id: string }[]) {
  if (!inProgress.some((ticket) => ticket.id === winner)) {
    writeTicketStatus(sessionDir, winner, 'In Progress');
  }
  for (const ticket of inProgress) {
    if (ticket.id === winner) continue;
    writeTicketStatus(sessionDir, ticket.id, 'Todo');
  }
}

function reconcileTicketStateDesync(
  statePath: string,
  sessionDir: string,
  currentTicket: string | null,
  iteration: number | undefined,
  log: (msg: string) => void,
): State {
  const tickets = collectTickets(sessionDir);
  if (tickets.length === 0) {
    log('WARN: ticket_state_desync check found no ticket directories');
    return readRunnerState(statePath);
  }
  const state = readRunnerState(statePath);
  const frontmatterStatuses = new Map<string, TicketStatus>();
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    try {
      frontmatterStatuses.set(ticket.id, getTicketStatus(sessionDir, ticket.id));
    } catch {
      frontmatterStatuses.set(ticket.id, '');
    }
  }
  const resolution = resolveTicketDesyncWinner(state, frontmatterStatuses, sessionDir);
  if (resolution.action === 'noop') return state;

  const winner = resolution.winner;
  if (!winner) return readRunnerState(statePath);
  const inProgress = reconcileInProgressSet(tickets, frontmatterStatuses);

  logActivity({
    event: 'ticket_state_desync_detected',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration,
    ticket: winner ?? currentTicket ?? undefined,
    reason: `current_ticket=${currentTicket ?? 'none'} in_progress=${inProgress.map(t => t.id || '?').join(',') || 'none'}`,
  });
  applyTicketDesyncWrites(sessionDir, winner, inProgress);

  if (winner && winner !== currentTicket) {
    return updateMuxLifecycleState(statePath, {
      currentTicket: winner,
      step: inferTicketLifecycleStep(sessionDir, winner, state.step),
    });
  }
  return readRunnerState(statePath);
}

function isPendingMuxTicket(sessionDir: string, ticket: TicketInfo): boolean {
  if (!ticket.id) return false;
  let status: string;
  try {
    status = normalizeTicketStatus(getTicketStatus(sessionDir, ticket.id));
  } catch {
    return false;
  }
  return !!ticket.id && status !== 'done' && status !== 'skipped';
}

function findNextPendingTicketId(sessionDir: string): string | null {
  return collectTickets(sessionDir).find(ticket => isPendingMuxTicket(sessionDir, ticket))?.id ?? null;
}

/**
 * R-AISLOW: Find the topologically-first pending (non-terminal) ticket.
 * Reuses collectTickets (already topo-sorted via topoSortTickets) +
 * getTicketStatus + isTerminalTicketStatus. Returns null when all tickets
 * are terminal or the session has no tickets.
 *
 * Used at iteration_start to detect when state.current_ticket is already
 * Done/Skipped, enabling the preskip path that avoids a wasted manager spawn.
 */
export function findFirstPendingTicket(sessionDir: string): TicketInfo | null {
  const tickets = collectTickets(sessionDir); // already topo-sorted by dependency/order
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    try {
      if (!isTerminalTicketStatus(getTicketStatus(sessionDir, ticket.id))) {
        return ticket;
      }
    } catch {
      continue; // unreadable ticket — treat as not-pending
    }
  }
  return null;
}

function withFreshTicketStatuses(sessionDir: string, tickets: readonly TicketInfo[]): TicketInfo[] {
  return tickets.map(ticket => {
    if (!ticket.id) return { ...ticket };
    try {
      return { ...ticket, status: getTicketStatus(sessionDir, ticket.id) };
    } catch {
      return { ...ticket, status: null };
    }
  });
}

export interface CorrectPhantomDoneTicketsInput {
  sessionDir: string;
  workingDir: string;
  startCommit: string | null;
  iteration: number;
  /** Persisted state flags; honors `allow_inferred_completion_commit` (R-PDWR). */
  flags?: Record<string, unknown> | null;
  log?: (msg: string) => void;
}

// R-CCR-1: memoize "can git run in this dir" per process lifetime to avoid
// redundant probes across multiple tickets with the same stale working_dir.
// true = git ran successfully, false = exit 128 or ENOENT (git-could-not-run).
const _gitReachabilityCache = new Map<string, boolean>();

type GitCommitReachability = 'reachable' | 'not-reachable' | 'git-could-not-run';

/**
 * R-CCR-1: probe whether `sha` is an ancestor of HEAD in `dir`. Distinguishes a
 * clean not-an-ancestor result (exit 1) from git being unable to run at all
 * (exit 128 / ENOENT) — only the latter justifies a fallback-dir retry.
 */
/**
 * Classify a thrown `git merge-base --is-ancestor` error. A clean exit 1 is a
 * definitive "not an ancestor". Exit 128, ENOENT, and timeouts (the child was
 * SIGTERM-killed before it could answer) all mean git produced no answer —
 * return 'git-could-not-run' so the R-CCR-1 fallback-dir retry fires. A timeout
 * misclassified as 'not-reachable' dead-ends the fallback and reverts a
 * genuinely-Done ticket to Todo.
 */
export function classifyGitProbeError(err: unknown): 'not-reachable' | 'git-could-not-run' {
  const e = err as { status?: number | null; code?: string; signal?: string | null };
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return 'git-could-not-run';
  return e.status === 128 || e.code === 'ENOENT' ? 'git-could-not-run' : 'not-reachable';
}

function probeCommitReachable(dir: string, sha: string): GitCommitReachability {
  try {
    execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, 'HEAD'], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'reachable';
  } catch (err) {
    return classifyGitProbeError(err);
  }
}

/**
 * R-PDWR: a lenient, watcher-only re-check before a destructive revert.
 * `hasCompletionCommit`'s strict explicit path can return 'absent' for a
 * genuinely-complete ticket — a stamped `completion_commit` carrying
 * decoration (backticks), a stale `workingDir`, or a transient read all
 * defeat it. Reverting a real completion to Todo costs a full redo, so before
 * the phantom-Done watcher reverts, give the stamped field the benefit of the
 * doubt: if it resolves to a real commit reachable from HEAD, the ticket is
 * genuinely done.
 *
 * R-CCR-1: when `workingDir` is a stale/non-existent dir and git exits 128
 * (or ENOENT), retry once against `fallbackDir` (the session working dir).
 * A clean not-an-ancestor exit (1) does NOT trigger the fallback.
 */
function frontmatterCompletionCommitReachable(
  ticketPath: string,
  workingDir: string,
  fallbackDir?: string,
): { reachable: boolean; usedFallback: boolean } {
  let content: string;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch {
    return { reachable: false, usedFallback: false };
  }
  for (const field of ['completion_commit', 'completion_commit_inferred']) {
    const raw = readFrontmatterField(content, field);
    if (!raw) continue;
    const sha = raw.replace(/[`'"]/g, '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;

    const primaryCanRun = _gitReachabilityCache.get(workingDir) !== false;
    if (primaryCanRun) {
      const primary = probeCommitReachable(workingDir, sha);
      if (primary === 'reachable') {
        _gitReachabilityCache.set(workingDir, true);
        return { reachable: true, usedFallback: false };
      }
      if (primary === 'not-reachable') {
        // Clean not-ancestor (exit 1): git ran fine, SHA just not reachable.
        // Do NOT retry against fallback — only git-could-not-run triggers it.
        _gitReachabilityCache.set(workingDir, true);
        continue;
      }
      _gitReachabilityCache.set(workingDir, false); // git-could-not-run
    }

    // workingDir is unusable for git — retry once against fallbackDir.
    if (!fallbackDir || fallbackDir === workingDir) continue;
    const fallbackCanRun = _gitReachabilityCache.get(fallbackDir) !== false;
    if (!fallbackCanRun) continue;

    const fallback = probeCommitReachable(fallbackDir, sha);
    if (fallback === 'reachable') {
      _gitReachabilityCache.set(fallbackDir, true);
      return { reachable: true, usedFallback: true };
    }
    _gitReachabilityCache.set(fallbackDir, fallback === 'git-could-not-run' ? false : true);
  }
  return { reachable: false, usedFallback: false };
}

/**
 * R-PDWR: decides whether the phantom-Done watcher must leave a Done ticket
 * alone despite `hasCompletionCommit` returning 'absent'.
 * R-CCR-1: threads `input.workingDir` as the session-dir fallback.
 */
function phantomDoneShouldKeepDone(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  workingDir: string,
): { keepDone: boolean; fallbackFired: boolean } {
  if ((input.flags ?? {})['allow_inferred_completion_commit'] === true) {
    return { keepDone: true, fallbackFired: false };
  }
  const result = frontmatterCompletionCommitReachable(
    ticketFilePath(input.sessionDir, ticketId),
    workingDir,
    input.workingDir,
  );
  return { keepDone: result.reachable, fallbackFired: result.usedFallback };
}

/**
 * R-CCR-1: emit the phantom-Done "kept" log lines, including the fallback-probe
 * note. Extracted from `correctPhantomDoneTickets` to keep that loop under the
 * eslint complexity ceiling.
 */
function logPhantomDoneKept(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  workingDir: string,
  fallbackFired: boolean,
): void {
  if (fallbackFired) {
    input.log?.(`Phantom-Done watcher: per-ticket working_dir '${workingDir}' unusable for git; retried in session dir '${input.workingDir}'. Ticket ${ticketId} kept Done.`);
  }
  input.log?.(`Phantom-Done watcher kept ticket ${ticketId} Done — valid completion_commit evidence`);
}

export function correctPhantomDoneTickets(input: CorrectPhantomDoneTicketsInput): number {
  let corrected = 0;
  for (const ticket of collectTickets(input.sessionDir)) {
    let status: string;
    try {
      status = ticket.id ? normalizedStatus(getTicketStatus(input.sessionDir, ticket.id)) : '';
    } catch {
      continue;
    }
    if (!ticket.id || status !== 'done') continue;

    const workingDir = ticket.working_dir || input.workingDir || process.cwd();
    const conformance = readLatestTicketConformanceSnapshot(path.join(input.sessionDir, ticket.id));
    if (conformance.hasManagerHandoff) continue;
    // R-CCC-5: completion_commit frontmatter is the FIRST gate. Bundle commits
    // use R-* codes in the subject (not ticket hashes) so the legacy git-log
    // scan in hasCommitReferencingTicketSince misses 100% of them. The watcher
    // (inspectPhantomDoneTicketFile) already short-circuits on the field; this
    // closes the second revert path.
    // R-RIC-EXPLICIT-4: `source === 'explicit'` is NOT reachability-verified —
    // R-RIC-EXPLICIT-2 decoupled gitCommitExists from the explicit branch so the
    // GUARD path (guardCompletionCommitBeforeDone) stops false-fataling. The
    // phantom-revert watcher has the opposite risk profile: a stamped-but-
    // unreachable SHA (typo, foreign repo, dropped commit) must still revert. So
    // only `inferred` (already gitCommitExists/grep-verified) short-circuits here;
    // `explicit` and `absent` both fall through to the reachability probe below.
    const evidence = hasCompletionCommit({ sessionDir: input.sessionDir, ticketId: ticket.id, workingDir });
    if (evidence.source === 'inferred') continue;
    // R-PDWR: keep the ticket Done when the operator bypass is set, or when a
    // stamped completion_commit resolves to a real HEAD-reachable commit that
    // the strict hasCompletionCommit check missed.
    // R-CCR-1: fallbackFired is true when the per-ticket dir was unusable and
    // the session dir was used as the fallback probe.
    const keepDoneResult = phantomDoneShouldKeepDone(input, ticket.id, workingDir);
    if (keepDoneResult.keepDone) {
      logPhantomDoneKept(input, ticket.id, workingDir, keepDoneResult.fallbackFired);
      continue;
    }
    if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo')) continue;

    corrected++;
    input.log?.(`Corrected phantom Done ticket ${ticket.id} back to Todo (no completion commit found)`);
    logActivity({
      event: 'ticket_phantom_done_corrected',
      source: 'pickle',
      session: path.basename(input.sessionDir),
      ticket: ticket.id,
      iteration: input.iteration,
      reason: 'done_frontmatter_without_completion_commit',
    });
  }
  return corrected;
}

export interface PhantomDoneInspectResult {
  /** True when the ticket file was mutated (either reverted to prior status or backfilled with a commit SHA). */
  changed: boolean;
  /**
   * - 'reverted': status flipped back to prior value (no commit found / git lookup failed)
   * - 'backfilled': real commit found; completion_commit field inserted
   * - 'has_completion_commit': frontmatter already had completion_commit; nothing to do
   * - 'not_done': status is not Done; nothing to do
   * - 'unparseable': read or write failed
   * - 'missing_id': frontmatter has no `id:` field
   */
  reason:
    | 'reverted'
    | 'backfilled'
    | 'has_completion_commit'
    | 'not_done'
    | 'unparseable'
    | 'missing_id';
  /** When 'reverted', the prior status that was restored ('Todo' | 'In Progress'). */
  priorStatus?: string;
  /** When 'reverted' and git lookup failed (vs. clean "no matches"), the failure reason. */
  gitFailureReason?: string;
  /** When 'backfilled', the commit SHA written into completion_commit. */
  commit?: string;
}

/**
 * Insert or replace `completion_commit_inferred: "<sha>"` in ticket frontmatter.
 * Preserves all other body content and leaves explicit `completion_commit:` intact.
 */
function insertCompletionCommitField(content: string, sha: string): string | null {
  if (readFrontmatterField(content, 'completion_commit')) return null;
  return upsertFrontmatterField(content, 'completion_commit_inferred', sha);
}

/**
 * R-ICP-5: Inspect a single linear_ticket_*.md file. If frontmatter status
 * is 'Done' but no `completion_commit:` field is present, take a three-way
 * decision:
 *   1. If git log shows a commit referencing the ticket id since HEAD~10 —
 *      backfill `completion_commit:` with that SHA (work was real, field
 *      missing).
 *   2. If no commit found — revert status to its prior value (Todo or
 *      In Progress).
 *   3. If git lookup throws/times out — treat as "no commit" (revert path)
 *      but surface the failure reason for the caller's log line.
 *
 * `priorStatus` defaults to 'Todo' but the watcher caller passes the last
 * known good status from before the flip (read off the previous mtime
 * snapshot). Pure side-effect on the ticket file plus a structured result —
 * caller owns activity-event + stderr log writes.
 */
export function inspectPhantomDoneTicketFile(
  filePath: string,
  sessionDir: string,
  workingDir: string,
  priorStatus: string = 'Todo',
): PhantomDoneInspectResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { changed: false, reason: 'unparseable' };
  }
  const status = readFrontmatterField(content, 'status');
  if (!status || status.toLowerCase() !== 'done') {
    return { changed: false, reason: 'not_done' };
  }
  const explicitCommit = readFrontmatterField(content, 'completion_commit');
  if (explicitCommit) {
    return { changed: false, reason: 'has_completion_commit' };
  }
  const ticketId = readFrontmatterField(content, 'id');
  if (!ticketId) {
    return { changed: false, reason: 'missing_id' };
  }

  let foundSha: string | null = null;
  try {
    const evidence = hasCompletionCommit({
      sessionDir,
      ticketId,
      ticketPath: filePath,
      workingDir,
    });
    if (evidence.source === 'inferred') {
      foundSha = evidence.sha;
    }
  } catch (err) {
    return { changed: false, reason: 'unparseable', gitFailureReason: safeErrorMessage(err) };
  }

  if (foundSha) {
    const updated = insertCompletionCommitField(content, foundSha);
    if (!updated) {
      return { changed: false, reason: 'unparseable' };
    }
    try {
      fs.writeFileSync(filePath, updated);
    } catch {
      return { changed: false, reason: 'unparseable' };
    }
    return { changed: true, reason: 'backfilled', commit: foundSha };
  }

  const wrote = writeTicketStatus(sessionDir, ticketId, priorStatus);
  if (!wrote) {
    return { changed: false, reason: 'unparseable' };
  }
  const result: PhantomDoneInspectResult = { changed: true, reason: 'reverted', priorStatus };
  return result;
}

function hasArtifact(files: readonly string[], prefix: string): boolean {
  return files.some(file => file.startsWith(prefix) && file.endsWith('.md'));
}

function inferTicketLifecycleStep(sessionDir: string, ticketId: string | null, fallback: Step): MuxLifecycleStep {
  if (!ticketId) return fallback === 'review' ? 'review' : 'research';

  let files: string[];
  try {
    files = fs.readdirSync(path.join(sessionDir, ticketId));
  } catch {
    return 'research';
  }

  if (hasArtifact(files, 'conformance_') || hasArtifact(files, 'code_review_')) return 'review';
  if (hasArtifact(files, 'plan_')) return 'implement';
  if (hasArtifact(files, 'research_')) return 'plan';
  return 'research';
}

function maxLifecycleStep(current: Step, next: MuxLifecycleStep): MuxLifecycleStep {
  if (current in MUX_LIFECYCLE_ORDER) {
    const currentLifecycle = current as MuxLifecycleStep;
    return MUX_LIFECYCLE_ORDER[currentLifecycle] > MUX_LIFECYCLE_ORDER[next] ? currentLifecycle : next;
  }
  return next;
}

function updateMuxLifecycleState(
  statePath: string,
  patch: { iteration?: number; currentTicket?: string | null; step?: MuxLifecycleStep },
): State {
  return sm.update(statePath, s => {
    if (patch.iteration !== undefined) s.iteration = patch.iteration;
    const ticketChanged = patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket;
    if (patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket) {
      s.current_ticket = patch.currentTicket;
      delete s.current_ticket_tier;
      delete s.current_ticket_budget;
      delete s.current_ticket_max_iterations;
      delete s.current_ticket_worker_timeout_seconds;
      delete s.current_ticket_budget_start_iteration;
    }
    if (patch.step !== undefined) {
      s.step = ticketChanged ? patch.step : maxLifecycleStep(s.step, patch.step);
    }
  });
}

function readTicketBudgetForState(state: State, sessionDir: string): TicketTierBudget {
  const ticketId = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  if (!ticketId) return sessionRunnerBudget(state);

  const ticketPath = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
  if (!fs.existsSync(ticketPath)) return sessionRunnerBudget(state);

  const cachedTier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : undefined;
  if (cachedTier) return getTicketTierBudgetWithOverrides(state, cachedTier);
  return ticketInfoBudgetFromPath(state, ticketPath);
}

function ticketInfoBudgetFromPath(state: State, ticketPath: string): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(state, parseTicketFrontmatter(ticketPath)?.complexity_tier);
}

function sessionRunnerBudget(state: State): TicketTierBudget {
  const max_iterations = Number(state.max_iterations);
  const worker_timeout_seconds = Number(state.worker_timeout_seconds);
  const fallback = getTicketTierBudgetWithOverrides(state, undefined);
  return {
    tier: 'medium',
    max_iterations: Number.isFinite(max_iterations) && max_iterations > 0 ? max_iterations : fallback.max_iterations,
    worker_timeout_seconds: Number.isFinite(worker_timeout_seconds) && worker_timeout_seconds > 0
      ? worker_timeout_seconds
      : fallback.worker_timeout_seconds,
  };
}

export function applyTicketTierBudget(state: State, sessionDir: string): TicketTierBudget {
  const budget = readTicketBudgetForState(state, sessionDir);
  if (state.current_ticket_budget_start_iteration === undefined) {
    state.current_ticket_budget_start_iteration = Math.max(0, (Number(state.iteration) || 0) - 1);
  }
  state.current_ticket_tier = budget.tier;
  state.current_ticket_max_iterations = budget.max_iterations;
  state.current_ticket_worker_timeout_seconds = budget.worker_timeout_seconds;
  // R-CNAR-1 part 2: do NOT overwrite state.max_iterations here. Per the
  // trap-door invariant in extension/CLAUDE.md, state.max_iterations is the
  // GLOBAL manager-loop cap (operator-set at session start). The per-ticket
  // tier ceiling lives in state.current_ticket_max_iterations (set above).
  // The cap-check at runMuxLoop reads BOTH and exits whichever fires first.
  // worker_timeout_seconds is documented as the per-spawn worker budget so it
  // remains overwritten here — workers want the per-ticket timeout.
  state.worker_timeout_seconds = budget.worker_timeout_seconds;
  return budget;
}

function ticketBudgetIterationCount(state: State, currentIteration: number): number {
  if (!state.current_ticket || typeof state.current_ticket_tier !== 'string') return currentIteration;
  const start = Number(state.current_ticket_budget_start_iteration);
  if (!Number.isFinite(start) || start < 0) return currentIteration;
  return Math.max(0, currentIteration - start);
}

/**
 * R-CNAR-7: Atomic clear of all five `current_ticket_*` cache fields.
 * Called when `state.current_ticket` is null/undefined and the per-ticket
 * cap-check sees a stale, non-zero `current_ticket_max_iterations` left over
 * from a previously-completed ticket. Without this, --resume of a
 * clean-success exit (which leaves the cache populated) trips
 * `iteration_cap_exhausted` on iteration 1 before any new ticket starts.
 *
 * Returns the count of fields cleared (0 = state was already clean).
 */
export function clearStaleTicketCacheFields(state: State): number {
  let cleared = 0;
  if (state.current_ticket_tier !== undefined) { delete state.current_ticket_tier; cleared++; }
  if (state.current_ticket_budget !== undefined) { delete state.current_ticket_budget; cleared++; }
  if (state.current_ticket_max_iterations !== undefined) { delete state.current_ticket_max_iterations; cleared++; }
  if (state.current_ticket_worker_timeout_seconds !== undefined) { delete state.current_ticket_worker_timeout_seconds; cleared++; }
  if (state.current_ticket_budget_start_iteration !== undefined) { delete state.current_ticket_budget_start_iteration; cleared++; }
  return cleared;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function hasStalePerTicketCacheFields(state: Pick<State,
  'current_ticket_tier'
  | 'current_ticket_budget'
  | 'current_ticket_max_iterations'
  | 'current_ticket_worker_timeout_seconds'
  | 'current_ticket_budget_start_iteration'>): boolean {
  return state.current_ticket_tier !== undefined
    || state.current_ticket_budget !== undefined
    || state.current_ticket_max_iterations !== undefined
    || state.current_ticket_worker_timeout_seconds !== undefined
    || state.current_ticket_budget_start_iteration !== undefined;
}

export function isValidPerTicketCapCache(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_max_iterations'
  | 'current_ticket_budget_start_iteration'>): boolean {
  if (state.current_ticket === null || state.current_ticket === undefined) return false;
  if (!isPositiveInteger(state.current_ticket_max_iterations)) return false;
  if (!isNonNegativeInteger(state.current_ticket_budget_start_iteration)) return false;
  if (typeof state.current_ticket_tier !== 'string') return false;
  return (VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(state.current_ticket_tier.toLowerCase());
}

export function stalePerTicketCacheDiagnostic(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_max_iterations'
  | 'current_ticket_budget_start_iteration'>): string {
  return `per-ticket cap-check skipped: stale cache (current_ticket=${String(state.current_ticket)}, max_iter=${String(state.current_ticket_max_iterations)}, budget_start=${String(state.current_ticket_budget_start_iteration)}, tier=${String(state.current_ticket_tier)})`;
}

function shouldEmitStalePerTicketCapSkip(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_budget'
  | 'current_ticket_max_iterations'
  | 'current_ticket_worker_timeout_seconds'
  | 'current_ticket_budget_start_iteration'>): boolean {
  return hasStalePerTicketCacheFields(state) && !isValidPerTicketCapCache(state);
}

export function clearStalePerTicketCacheAtIterationStart(
  statePath: string,
  state: State,
  log: (msg: string) => void,
): State {
  if (state.current_ticket !== null || !hasStalePerTicketCacheFields(state)) return state;
  log('clearing stale per-ticket cache fields (current_ticket=null)');
  return sm.update(statePath, s => {
    clearStaleTicketCacheFields(s);
  });
}

/**
 * Proactive empty-queue completion check, run at iteration_start before any
 * manager spawn. If all `linear_ticket_*.md` files in the session report
 * `status: Done` (and there is at least one ticket), synthesizes an
 * EPIC_COMPLETED terminal state atomically and returns true so the caller
 * can break the outer loop.
 *
 * Guard conditions (bias: don't fire):
 *   - N=0 tickets — ambiguous; could be a setup error
 *   - Any ticket file unparseable — cannot confirm all Done
 *   - Not all statuses normalize to 'done'
 *
 * On success mutates state.json twice:
 *   1. sm.update  — sets completion_promise (JSON) + appends activity entry
 *   2. finalizeTerminalState — sets active=false, step='completed', exit_reason='completed'
 */
export function applyAllTicketsDoneCompletion(
  statePath: string,
  sessionDir: string,
  iteration: number,
  log: (msg: string) => void,
): boolean {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const ticketPaths: string[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(sessionDir, entry.name);
    try {
      const files = fs.readdirSync(subDir);
      for (const file of files) {
        if (file.startsWith('linear_ticket_') && file.endsWith('.md')) {
          ticketPaths.push(path.join(subDir, file));
        }
      }
    } catch {
      // subdir unreadable — skip
    }
  }

  if (ticketPaths.length === 0) return false;

  const statuses: string[] = [];
  for (const ticketPath of ticketPaths) {
    const parsed = parseTicketFrontmatter(ticketPath);
    if (!parsed) {
      log(`all-tickets-done-check: cannot parse ${path.basename(path.dirname(ticketPath))} — skipping completion synthesis`);
      return false;
    }
    statuses.push(normalizeTicketStatus(parsed.status || ''));
  }

  if (!statuses.every(s => s === 'done')) return false;

  const ts = new Date().toISOString();
  sm.update(statePath, s => {
    s.completion_promise = JSON.stringify({ kind: PromiseTokens.EPIC_COMPLETED, reason: 'all-tickets-done', ts });
    if (!Array.isArray(s.activity)) s.activity = [];
    s.activity.push({ event: 'epic_completed', kind: PromiseTokens.EPIC_COMPLETED, ts });
  });
  finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'completed' });
  log(`all-tickets-done (${ticketPaths.length}/${ticketPaths.length}): synthesizing ${PromiseTokens.EPIC_COMPLETED} completion`);
  return true;
}

/**
 * Returns tickets that are still pending (not Done, not Skipped) excluding
 * `currentTicket`. Used to fail-loud when the model emits EPIC_COMPLETED but
 * the ticket queue is not actually drained — silent loop-termination on a
 * partial epic is the most expensive class of bug for autonomous agents.
 *
 * Status comparison is case-insensitive and strips quotes (matches the
 * normalisation already used at line ~1017 and in monitor.ts).
 */
export function findPendingNonCurrentTickets(
  tickets: readonly TicketInfo[],
  currentTicket: string | null
): TicketInfo[] {
  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();
  return tickets.filter(t => {
    if (!t.id) return false;
    if (t.id === currentTicket) return false;
    const s = norm(t.status);
    return s !== 'done' && s !== 'skipped';
  });
}

/**
 * Decision returned by `evaluateEpicCompletion`. Replaces the prior fail-loud
 * "exit 1 on any false EPIC_COMPLETED" behaviour with structural recovery.
 *
 * - `genuine` — every ticket reports `status: Done` (case/quote-insensitive).
 *   Behave as today: mark current Done, exit success or chain meeseeks.
 * - `recover_advance` — manager lied about epic completion BUT current_ticket
 *   really is Done. Treat as a single TASK_COMPLETED; advance to next ticket,
 *   keep iterating. Increment false-epic counter for telemetry.
 * - `recover_retry` — manager lied AND current_ticket is not Done either.
 *   Force another iteration on the same ticket with a stricter retry brief.
 *   Increment counter; reset on next genuine advance.
 * - `persistent_hallucination` — counter has crossed the threshold for the
 *   same ticket. Bail with a distinct exit class so a human can intervene.
 *
 * Pure function — no I/O. Caller owns ticket collection, state mutation, and
 * iteration handoff. Behaviour is fully deterministic from inputs.
 */
export type EpicCompletionDecision =
  | { kind: 'genuine'; doneCount: number; totalCount: number }
  | { kind: 'recover_advance'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'recover_retry'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'persistent_hallucination'; doneCount: number; totalCount: number; ticket: string; nextCount: number };

export interface EvaluateEpicCompletionInput {
  tickets: readonly TicketInfo[];
  currentTicket: string | null;
  /** Prior counter value from `state.false_epic_completed_count` (0 if absent). */
  priorFalseCount: number;
  /** Ticket the prior counter is associated with. Counter resets when this differs from `currentTicket`. */
  priorFalseTicket: string | null;
  /** Threshold beyond which we exit with MANAGER_PERSISTENT_HALLUCINATION. Defaults to FALSE_EPIC_THRESHOLD. */
  threshold?: number;
}

/**
 * Decide what to do when the manager emits EPIC_COMPLETED. This is the
 * single source of truth for the recovery state machine — the main loop just
 * acts on the returned decision.
 */
export function evaluateEpicCompletion(input: EvaluateEpicCompletionInput): EpicCompletionDecision {
  const { tickets, currentTicket, priorFalseCount, priorFalseTicket } = input;
  const threshold = input.threshold ?? FALSE_EPIC_THRESHOLD;

  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();

  const totalCount = tickets.filter(t => !!t.id).length;
  const doneCount = tickets.filter(t => !!t.id && norm(t.status) === 'done').length;
  const pendingIds = tickets
    .filter(t => !!t.id && norm(t.status) !== 'done' && norm(t.status) !== 'skipped' && t.id !== currentTicket)
    .map(t => t.id!)
    .filter((s): s is string => typeof s === 'string');

  const currentInfo = currentTicket ? tickets.find(t => t.id === currentTicket) : null;
  const currentIsDone = !!currentInfo && norm(currentInfo.status) === 'done';

  // The current ticket is allowed to count as "about to be Done" because the
  // manager normally marks it Done in the same iteration as EPIC_COMPLETED.
  // We treat it as Done iff it is BOTH actually Done AND no other tickets are
  // pending. This keeps the genuine path identical to the prior guard.
  if (pendingIds.length === 0 && (currentTicket == null || currentIsDone)) {
    return { kind: 'genuine', doneCount, totalCount };
  }

  // From here on the manager lied. Bump the counter (resetting when ticket
  // changes — different ticket means we're not stuck in the same loop).
  const sameTicket = currentTicket != null && priorFalseTicket === currentTicket;
  const nextCount = (sameTicket ? priorFalseCount : 0) + 1;

  if (currentTicket != null && nextCount > threshold) {
    return { kind: 'persistent_hallucination', doneCount, totalCount, ticket: currentTicket, nextCount };
  }

  if (currentIsDone) {
    return { kind: 'recover_advance', doneCount, totalCount, pendingIds, nextCount };
  }
  return { kind: 'recover_retry', doneCount, totalCount, pendingIds, nextCount };
}

/**
 * Classifies iteration output into a completion result.
 * EPIC_COMPLETED → 'task_completed' (exits the loop — all tickets done)
 * EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES → 'review_clean' (subject to min_iterations gate)
 * TASK_COMPLETED / anything else → 'continue' (single ticket done, loop continues)
 *
 * Only checks assistant message content (via extractAssistantContent) to avoid
 * false positives from promise tokens in reviewed source code.
 */
export function classifyCompletion(output: string): 'task_completed' | 'review_clean' | 'continue' {
  const content = extractAssistantContent(output);
  if (hasToken(content, PromiseTokens.EPIC_COMPLETED)) {
    return 'task_completed';
  }
  if (hasToken(content, PromiseTokens.EXISTENCE_IS_PAIN) || hasToken(content, PromiseTokens.THE_CITADEL_APPROVES)) {
    return 'review_clean';
  }
  return 'continue';
}

/** Scans a full iteration log for codex Bash tool-calls invoking setup.js. */
export function checkIterationLogForCodexSelfBootstrap(
  output: string,
  backend: Backend,
  currentTicket: string | null | undefined,
  iterationNum: number,
): Array<{ attempted_argv: string[]; ticket: string | null; iteration: number }> {
  if (backend !== 'codex') return [];
  const fmt = detectOutputFormat(output);
  if (fmt === 'plain-text') return [];
  const results: Array<{ attempted_argv: string[]; ticket: string | null; iteration: number }> = [];
  const lines = output.split('\n');
  let inToolCallBlock = false;
  for (const line of lines) {
    if (fmt === 'codex-block') {
      if (CODEX_DELIMITER_RE.test(line)) {
        inToolCallBlock = /^tool_call\s*$/.test(line);
        continue;
      }
      if (!inToolCallBlock) continue;
    }
    const obs = observeCodexToolCallStream(line, fmt === 'stream-json' ? 'stream-json' : 'codex-block');
    if (obs?.isSetupInvocation) {
      results.push({ attempted_argv: obs.argv, ticket: currentTicket ?? null, iteration: iterationNum });
    }
  }
  return results;
}

/**
 * Post-hoc safety net: validates whether a ticket was actually completed
 * before marking it Done. TASK_COMPLETED token is strong evidence. Otherwise
 * require a ticket-scoped lifecycle artifact — unscoped git diff alone is a
 * ghost source (changes from any other ticket in the tree pass). Never throws.
 */
export function classifyTicketCompletion(
  iterLogFile: string,
  workingDir: string,
  ticketDir?: string,
  role: WorkerRole = 'implementation'
): 'completed' | 'skipped' {
  try {
    const logContent = fs.readFileSync(iterLogFile, 'utf-8');
    const assistantContent = extractAssistantContent(logContent);
    if (hasToken(assistantContent, PromiseTokens.TASK_COMPLETED)) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:log-read] ${safeErrorMessage(err)}\n`); /* fall through to artifact check */ }

  if (!ticketDir) return 'skipped';
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return 'skipped'; }
  if (!hasLifecycleArtifact(files, role)) return 'skipped';

  // Artifact exists — corroborate with git diff. Artifacts alone are
  // sufficient because the worker wrote them during its lifecycle, but a
  // dirty tree is a stronger signal that code actually changed.
  try {
    const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (uncommitted.length > 0) return 'completed';
    const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
    if (staged.length > 0) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:git-probe] ${safeErrorMessage(err)}\n`); /* artifact alone suffices */ }

  return 'completed';
}

export type AutoTicketCompletionValidation =
  | { action: 'done'; reason: 'commit_and_acceptance_checked' }
  | { action: 'skip'; reason: string }
  | { action: 'leave'; reason: string };

function normalizedStatus(status: string | null | undefined): string {
  return (status || '').toLowerCase().replace(/^["']|["']$/g, '').trim();
}

function isTerminalTicketStatus(status: string | null | undefined): boolean {
  const normalized = normalizedStatus(status);
  return normalized === 'done' || normalized === 'skipped';
}

function acceptanceCriteriaSection(content: string): string {
  const match = /^## Acceptance Criteria\s*$/m.exec(content);
  if (!match) return '';
  const rest = content.slice(match.index + match[0].length);
  const next = /^## \S.*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

type AcceptanceCriteriaOwner = 'worker' | 'manager' | 'unassigned';

interface AcceptanceCriteriaCheckbox {
  checked: boolean;
  owner: AcceptanceCriteriaOwner;
}

function acceptanceCriteriaCheckboxes(content: string): AcceptanceCriteriaCheckbox[] {
  const section = acceptanceCriteriaSection(content);
  const checkboxes: AcceptanceCriteriaCheckbox[] = [];
  for (const match of section.matchAll(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/gm)) {
    const criterion = match[2].trim();
    const owner: AcceptanceCriteriaOwner = /^\[manager\](?:\s|$)/i.test(criterion)
      ? 'manager'
      : /^\[worker\](?:\s|$)/i.test(criterion)
        ? 'worker'
        : 'unassigned';
    checkboxes.push({
      checked: match[1].toLowerCase() === 'x',
      owner,
    });
  }
  return checkboxes;
}

function hasCheckedAcceptanceCriteria(content: string): boolean {
  const boxes = acceptanceCriteriaCheckboxes(content);
  if (boxes.length === 0) return false;
  return boxes
    .filter((box) => box.owner !== 'manager')
    .every((box) => box.checked);
}

function readHeadCommit(workingDir: string): string | null {
  try {
    const head = runCmd(['git', 'rev-parse', 'HEAD'], { cwd: workingDir, check: false }).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

function emitMuxWastedIter(input: {
  sessionDir: string;
  iteration: number;
  action: string;
  preIterSha: string | null;
  postIterSha: string | null;
}): void {
  const wasted = input.action === 'revert' || input.postIterSha === input.preIterSha;
  logActivity({
    event: 'wasted_iter',
    source: 'pickle',
    session: path.basename(input.sessionDir),
    iteration: input.iteration,
    runner: 'mux',
    action: input.action,
    wasted,
    pre_iter_sha: input.preIterSha,
    post_iter_sha: input.postIterSha,
  });
}

function gitCommitEpoch(workingDir: string, sha: string | null): number | null {
  if (!sha) return null;
  try {
    const raw = execFileSync('git', ['-C', workingDir, 'show', '-s', '--format=%ct', sha], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function validateAutoTicketCompletion(
  sessionDir: string,
  ticketId: string,
  workingDir: string,
  startCommit: string | null
): AutoTicketCompletionValidation {
  const filePath = ticketFilePath(sessionDir, ticketId);
  try {
    if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) return { action: 'leave', reason: 'ticket_already_terminal' };
  } catch {
    return { action: 'leave', reason: 'malformed_or_missing_ticket_frontmatter' };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { action: 'leave', reason: 'ticket_file_unreadable' };
  }

  if (!hasCheckedAcceptanceCriteria(content)) {
    return { action: 'skip', reason: 'acceptance_criteria_not_checked' };
  }
  const evidence = hasCompletionCommit({
    sessionDir,
    ticketId,
    workingDir,
    startTimeEpoch: gitCommitEpoch(workingDir, startCommit),
  });
  if (evidence.source === 'absent') {
    return { action: 'skip', reason: 'no_commit_referencing_ticket_since_current_set' };
  }

  return { action: 'done', reason: 'commit_and_acceptance_checked' };
}

export interface ApplyAutoTicketCompletionInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  startCommit: string | null;
  iteration: number;
  log?: (msg: string) => void;
  statePath: string;
  flags: Record<string, unknown> | null;
}

export function applyAutoTicketCompletionValidation(input: ApplyAutoTicketCompletionInput): AutoTicketCompletionValidation {
  const verdict = validateAutoTicketCompletion(input.sessionDir, input.ticketId, input.workingDir, input.startCommit);
  if (verdict.action === 'done') {
    // R-CCRC-2: route Done-flip through guard so the R-WUWC SOFT-variant
    // auto-fill runs and completion_commit is persisted to the frontmatter.
    // Manager drift path: ticket starts 'In Progress', so the guard's internal
    // autoFillCompletionCommit (which requires status=Done) cannot run yet.
    // Allow inferred evidence here; autoFillCompletionCommit runs post-markTicketDone.
    const guard = guardCompletionCommitBeforeDone({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      flags: { ...(input.flags ?? {}), allow_inferred_completion_commit: true },
    });
    if (!guard.ok) {
      const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
      input.log?.(msg);
      process.stderr.write(`${msg}\n`);
      recordExitReason(input.statePath, 'done_without_commit_evidence');
      safeDeactivate(input.statePath);
      return { action: 'leave', reason: 'guard_failed_no_commit_evidence' };
    }
    // R-PEDC: clear any stale done_without_commit_evidence before marking Done.
    clearStaleDoneWithoutCommitEvidence(input.statePath);
    if (markTicketDone(input.sessionDir, input.ticketId)) {
      input.log?.(`Marked ticket ${input.ticketId} as Done (validated: evidence found, completion_commit: ${guard.sha})`);
    }
    // R-WUWC SOFT-variant (manager path): ticket was 'In Progress' at guard
    // time so the auto-fill inside guardCompletionCommitBeforeDone couldn't
    // write completion_commit (autoFillCompletionCommit requires status=Done).
    // Now that markTicketDone has flipped the status, run auto-fill to persist
    // the SHA. Best-effort: failure must not block the Done flip.
    try {
      autoFillCompletionCommit({
        sessionDir: input.sessionDir,
        workingDir: input.workingDir,
        ticketId: input.ticketId,
        statePath: input.statePath,
      });
    } catch { /* best-effort */ }
    return verdict;
  }
  if (verdict.action === 'skip') {
    if (markTicketSkipped(input.sessionDir, input.ticketId)) {
      input.log?.(`Marked ticket ${input.ticketId} as Skipped (${verdict.reason})`);
      logActivity({
        event: 'ticket_auto_skip_no_evidence',
        source: 'pickle',
        session: path.basename(input.sessionDir),
        ticket: input.ticketId,
        iteration: input.iteration,
        reason: verdict.reason,
      });
    }
    return verdict;
  }
  input.log?.(`Warning: leaving ticket ${input.ticketId} unchanged (${verdict.reason})`);
  return verdict;
}

/**
 * Reads `pickle_settings.json` as an untyped bag, returning `{}` on any
 * read/parse failure. Emits a labeled stderr breadcrumb keyed by the caller
 * site so a missing/corrupt settings file never silently yields defaults.
 * Every call site in this module consumes its own subset of keys with its
 * own defaults; this helper owns only the file I/O + JSON decode step.
 */
function loadSettingsBag(extensionRoot: string, site: string): Record<string, unknown> {
  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  const raw = readRecoverableJsonObject(settingsPath);
  if (raw) return raw as Record<string, unknown>;
  if (!fs.existsSync(settingsPath)) return {};
  try {
    fs.readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`[${site}] ${safeErrorMessage(err)}\n`);
  }
  return {};
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Transitions a session from ticket-execution mode to Meeseeks review mode.
 * Pure function — returns a new state object without side effects.
 */
export function transitionToMeeseeks(state: State, extensionRoot: string): State {
  let minPasses = 10;
  let maxPasses = 50;

  const settings = loadSettingsBag(extensionRoot, 'mux-runner:transition-meeseeks:settings');
  const rawMin = Number(settings.default_meeseeks_min_passes);
  if (Number.isFinite(rawMin) && rawMin > 0) minPasses = rawMin;
  const rawMax = Number(settings.default_meeseeks_max_passes);
  if (Number.isFinite(rawMax) && rawMax > 0) maxPasses = rawMax;

  return {
    ...state,
    chain_meeseeks: false,
    command_template: 'meeseeks.md',
    min_iterations: minPasses,
    max_iterations: maxPasses,
    iteration: 0,
    step: 'review',
    current_ticket: null,
  };
}

// eslint-disable-next-line -- legacy model tier resolver retained behavior-preserving for global bin acceptance
export function loadMeeseeksModel(extensionRoot: string, passCount: number = 1): string {
  const fallback = 'sonnet';
  let defaultModel = fallback;
  let tiers: Record<string, string> | null = null;
  let maxOpusPasses = 3;
  let enableModelTiers = true;

  const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-meeseeks-model:settings');
  if (typeof raw.default_meeseeks_model === 'string' && raw.default_meeseeks_model.length > 0) {
    defaultModel = raw.default_meeseeks_model;
  }
  if (raw.meeseeks_model_tiers && typeof raw.meeseeks_model_tiers === 'object') {
    tiers = raw.meeseeks_model_tiers as Record<string, string>;
  }
  const rawCap = Number(raw.max_opus_passes);
  if (Number.isFinite(rawCap) && rawCap > 0) maxOpusPasses = rawCap;
  // Feature flag: enable_model_tiers (default true — missing flag = enabled)
  if (raw.enable_model_tiers === false) enableModelTiers = false;

  if (!tiers || !enableModelTiers) return defaultModel;

  // Find the highest threshold that doesn't exceed passCount
  let resolvedModel = defaultModel;
  let highestThreshold = 0;
  for (const [key, model] of Object.entries(tiers)) {
    const threshold = Number(key);
    if (Number.isFinite(threshold) && threshold <= passCount && threshold > highestThreshold) {
      highestThreshold = threshold;
      resolvedModel = String(model);
    }
  }

  // Cap opus passes: if resolved model is opus and we've used more than the allowed count, fall back to sonnet
  if (resolvedModel === 'opus') {
    const opusPassNumber = passCount - highestThreshold + 1;
    if (opusPassNumber > maxOpusPasses) resolvedModel = 'sonnet';
  }

  return resolvedModel;
}

export function loadRateLimitSettings(extensionRoot: string): { waitMinutes: number; maxRetries: number } {
  let waitMinutes = 5;
  let maxRetries = 3;
  const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-rate-limit-settings');
  const rawWait = raw.default_rate_limit_wait_minutes;
  if (typeof rawWait === 'number' && rawWait >= 1) waitMinutes = rawWait;
  const rawRetries = raw.default_max_rate_limit_retries;
  if (typeof rawRetries === 'number' && rawRetries >= 1) maxRetries = rawRetries;
  return { waitMinutes, maxRetries };
}

export function detectRateLimitInLog(logFile: string): RateLimitInfo {
  const result: RateLimitInfo = { limited: false, sawEvents: false };
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100);
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'rate_limit_event') continue;
        result.sawEvents = true;
        // Real API nests under rate_limit_info; check both paths for robustness
        const info = parsed.rate_limit_info ?? parsed;
        const status = info.status;
        if (status === 'rejected') {
          result.limited = true;
          if (typeof info.resetsAt === 'number') result.resetsAt = info.resetsAt;
          if (typeof info.rateLimitType === 'string') result.rateLimitType = info.rateLimitType;
        }
      } catch { /* not JSON */ }
    }
  } catch { /* file missing */ }
  return result;
}

export function detectRateLimitInText(logFile: string): boolean {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    // Only check the very tail — rate limit messages appear at the end when
    // the process is killed. 20 lines is plenty; 100 was catching assistant
    // text *about* rate limits as false positives.
    const tail = lines.slice(-20);
    // Filter out JSON content fields (assistant text, user messages, tool results)
    // to avoid matching on *discussion about* rate limits
    const filtered = tail.filter(l =>
      !l.includes('"type":"user"') &&
      !l.includes('"type":"tool_result"') &&
      !l.includes('"type":"assistant"') &&
      !l.includes('"type":"text"') &&
      !l.includes('"content":[') &&
      !l.includes('"content":"')
    );
    const text = filtered.join('\n');
    // Tightened patterns — require more specific phrasing to avoid matching
    // code comments or discussions about rate limiting
    const patterns = [
      /your .* usage limit has been reached/i,
      /usage is limited.*try again/i,
      /out of (extra )?usage/i,
      /rate limited.*try again/i,
    ];
    return patterns.some(p => p.test(text));
  } catch { /* file missing */ }
  return false;
}

function readLastResultEventFromLog(logFile: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = fs.readFileSync(logFile, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') continue;
    const ev = parsed as Record<string, unknown>;
    if (ev.type === 'result') return ev;
  }
  return null;
}

export function detectManagerMaxTurnsExit(managerResult: IterationOutcome, logFile: string, maxTurns: number | null): boolean {
  if (managerResult.completion !== 'error') return false;
  if (managerResult.timedOut || managerResult.exitCode !== 0) {
    return false;
  }
  if (!Number.isFinite(maxTurns) || maxTurns === null || maxTurns <= 0) return false;
  const event = readLastResultEventFromLog(logFile);
  if (!event) return false;
  if (event.stop_reason !== 'end_turn') return false;
  if (event.terminal_reason !== 'completed') return false;
  if (event.is_error !== false) return false;
  const eventTurns = typeof event.num_turns === 'number'
    ? event.num_turns
    : (typeof event.turn_count === 'number' ? event.turn_count : null);
  if (!Number.isFinite(eventTurns) || eventTurns === null) return false;
  return eventTurns >= maxTurns;
}

function emitMaxTurnsClassifiedEvent(
  sessionDir: string,
  iterationNum: number,
  logFile: string,
  maxTurns: number | null,
  wallSeconds: number,
): void {
  const resultEvent = readLastResultEventFromLog(logFile);
  const numTurns: number =
    (typeof resultEvent?.num_turns === 'number' ? resultEvent.num_turns
      : typeof resultEvent?.turn_count === 'number' ? resultEvent.turn_count
      : maxTurns) ?? 0;
  logActivity({
    event: 'iteration_classified_at_max_turns',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration_num: iterationNum,
    num_turns: numTurns,
    max_turns: maxTurns ?? 0,
    wall_seconds: wallSeconds,
  });
}

export function classifyManagerRelaunchExit(
  state: State,
  outcome: IterationOutcome | undefined,
  logFile: string,
  maxTurns: number | null,
): ManagerRelaunchExitKind {
  const backend = resolveBackend(state);
  if (backend === 'claude' && outcome && detectManagerMaxTurnsExit(outcome, logFile, maxTurns)) {
    return 'claude_max_turns';
  }
  if (backend === 'codex' && outcome?.timedOut === true) {
    return 'codex_4h_hang_guard';
  }
  return 'other_error';
}

export function classifyIterationExit(
  completionResult: string,
  logFile: string,
  timing?: { didTimeout: boolean; exitCode: number | null; wallSeconds: number },
): IterationExitResult {
  if (completionResult === 'inactive') return { type: 'inactive' };
  if (completionResult === 'error') return { type: 'error' };
  if (completionResult === 'task_completed' || completionResult === 'review_clean') return { type: 'success' };
  const rlInfo = detectRateLimitInLog(logFile);
  if (rlInfo.limited) return { type: 'api_limit', rateLimitInfo: rlInfo };
  // Only fall back to text detection if we found NO structured rate_limit_event
  // entries at all. If structured events exist but none say 'rejected', trust
  // that — don't let fuzzy text matching override structured signals.
  if (!rlInfo.sawEvents && detectRateLimitInText(logFile)) return { type: 'api_limit' };
  if (timing?.didTimeout) {
    return { type: 'timeout', exitCode: timing.exitCode, wallSeconds: timing.wallSeconds };
  }
  return { type: 'success' };
}

/**
 * Pure decision function: given rate limit context, returns whether to wait or bail.
 * Extracted from main() for testability. No side effects.
 *
 * When resetsAt is available from the API, always waits (the API told us when to come back).
 * Only bails when no resetsAt AND consecutive retries >= max.
 * Resets the counter after an API-guided wait completes.
 */
export function computeRateLimitAction(
  exitResult: IterationExitResult,
  consecutiveRateLimits: number,
  maxRetries: number,
  configWaitMinutes: number,
): RateLimitAction {
  const configWaitMs = configWaitMinutes * 60 * 1000;
  const maxApiWaitMs = configWaitMs * 3;
  let waitMs = configWaitMs;
  let waitSource: 'api' | 'config' = 'config';
  const rlResetsAt = exitResult.type === 'api_limit' ? exitResult.rateLimitInfo?.resetsAt : undefined;
  const hasResetsAt = typeof rlResetsAt === 'number' && rlResetsAt > 0;

  if (hasResetsAt) {
    const apiWaitMs = (rlResetsAt * 1000) - Date.now();
    if (apiWaitMs > 0 && apiWaitMs <= maxApiWaitMs) {
      waitMs = apiWaitMs + 30_000; // 30s buffer
      waitSource = 'api';
    }
    // apiWaitMs > maxApiWaitMs → capped, falls through to config default
    // apiWaitMs <= 0 → resetsAt in the past, use config default
  }

  // Bail only when blind (no resetsAt) AND retries exhausted
  if (!hasResetsAt && consecutiveRateLimits >= maxRetries) {
    return { action: 'bail', waitMs: 0, waitSource: 'config', resetCounter: false, hasResetsAt };
  }

  return {
    action: 'wait',
    waitMs,
    waitSource,
    resetCounter: waitSource === 'api',
    hasResetsAt,
  };
}

// eslint-disable-next-line -- legacy iteration loop retained behavior-preserving for global bin acceptance
export async function runIteration(
  sessionDir: string,
  iterationNum: number,
  extensionRoot: string,
  qualityPassModel: string,
  runtimeOverrides: IterationRuntimeOverrides = {},
): Promise<IterationOutcome> {
  const statePath = path.join(sessionDir, 'state.json');
  let state: State;
  try {
    state = readRunnerState(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
  }

  if (state.active !== true) return { completion: 'inactive', timedOut: false, exitCode: null, wallSeconds: 0 };

  const templateName = state.command_template || 'pickle.md';
  // Validate at read time (not just at setup.ts CLI parse time) — state.json could be tampered with
  if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
    throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
  }
  // Check internal templates first (hidden from slash command list), then user-facing commands.
  // Use extensionRoot for templatesDir so tests can inject an isolated directory via EXTENSION_DIR.
  const templatesDir = path.join(extensionRoot, 'templates');
  const commandsDir = path.join(os.homedir(), '.claude/commands');
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
    ? path.join(templatesDir, templateName)
    : path.join(commandsDir, templateName);
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!fs.existsSync(picklePromptPath)) {
    throw new Error(`${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.`);
  }
  // Pre-compute handoff text (mutually exclusive: handoffText OR iterationSummary)
  let handoffText: string | undefined;
  let iterationSummary: string | undefined;
  const handoffPath = path.join(sessionDir, 'handoff.txt');
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (fs.existsSync(handoffPath)) {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    handoffText = fs.readFileSync(handoffPath, 'utf-8');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    try { fs.unlinkSync(handoffPath); } catch (unlinkErr) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'ENOENT') {
        console.warn(`[mux-runner] WARNING: Cannot remove handoff.txt (${code})`);
      }
    }
  } else {
    iterationSummary = buildIterationHandoffSummary(state, sessionDir, iterationNum);
  }

  const settings = loadSettingsBag(extensionRoot, 'mux-runner:run-iteration:settings');

  // Feature flag: enable_task_notes (default true — missing flag = enabled)
  const enableTaskNotes = settings.enable_task_notes !== false;
  let taskNotes: string | undefined;
  if (enableTaskNotes) {
    const taskNotesPath = path.join(sessionDir, 'TASK_NOTES.md');
    try {
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      if (fs.existsSync(taskNotesPath)) {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const raw = fs.readFileSync(taskNotesPath, 'utf-8');
        const truncated = truncateTaskNotes(raw, 2000);
        if (truncated.trim()) taskNotes = truncated;
      }
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      console.warn(`[mux-runner] WARNING: task notes subsystem failed: ${msg}`);
    }
  }

  const backend = resolveBackend(state);
  const managerPrompt = composeManagerPromptFromSkill(picklePromptPath, backend, {
    argumentSubstitution: `--resume ${sessionDir}`,
    handoffText,
    iterationSummary,
    taskNotes,
  });
  if (backend === 'codex') process.env.PICKLE_PARENT_SESSION_HASH = path.basename(sessionDir);

  let maxTurns: number = Defaults.MANAGER_MAX_TURNS;
  maxTurns = positiveIntegerOrNull(settings.default_tmux_max_turns)
    ?? positiveIntegerOrNull(settings.default_manager_max_turns)
    ?? maxTurns;
  const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
  const isQualityPassTemplate = templateName === 'meeseeks.md' || templateName === 'szechuan-sauce.md';
  // Quality review passes can run on a selected Claude model. Codex exposes a
  // different model vocabulary, so only apply the override for claude.
  const iterationModel = isQualityPassTemplate && qualityPassModel && backend === 'claude'
    ? qualityPassModel
    : undefined;
  // Codex manager spawns plumb the resolved codex model so `--ignore-user-config`
  // doesn't strip away the configured `-m`. Quality-pass-template Claude
  // overrides (meeseeks/szechuan) remain claude-only above.
  const codexManagerModel = backend === 'codex' ? resolveCodexModel(extensionRoot, state) : undefined;
  const invocation = buildManagerInvocation(backend, {
    prompt: managerPrompt,
    addDirs: [extensionRoot, getDataRoot(), sessionDir],
    model: backend === 'hermes' ? state.hermes_model : (backend === 'codex' ? codexManagerModel : iterationModel),
    maxTurns: backend === 'hermes' ? positiveIntegerOrNull(state.hermes_max_turns) ?? maxTurns : maxTurns,
    streamJson: true,
    noSessionPersistence: true,
    toolsets: backend === 'hermes' ? state.hermes_toolsets : undefined,
    provider: backend === 'hermes' ? state.hermes_provider : undefined,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...runtimeOverrides.envOverrides,
    ...backendEnvOverrides(backend),
    PICKLE_STATE_FILE: statePath,
    PYTHONUNBUFFERED: '1',
  };
  // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
  // inside another Claude Code session (which would alter its behavior).
  delete env['CLAUDECODE'];
  // Remove PICKLE_ROLE so manager subprocesses aren't misidentified as workers
  // by the stop-hook (tmux-runner spawns managers, not workers).
  delete env['PICKLE_ROLE'];

  // Use a raw file descriptor with synchronous writes so every chunk hits
  // the disk immediately. Node's WriteStream buffers up to 16KB internally,
  // which starves log-watcher (it polls file size via statSync).
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  const logFd = fs.openSync(logFile, 'w');

  function writeToLog(chunk: Buffer) {
    try { fs.writeSync(logFd, chunk); } catch { /* fd closed — ignore late writes */ }
  }

  // eslint-disable-next-line max-lines-per-function -- HT-1 reviewed: legacy spawn-wait callback retained behavior-preserving for global bin acceptance; refactor deferred.
  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();
    let didTimeout = false;
    let stallReason: IterationOutcome['stallReason'];
    let lastDataAt = start;
    let timeoutResolveTimer: NodeJS.Timeout | null = null;
    let timeoutDrainTimer: NodeJS.Timeout | null = null;
    let timeoutResolutionFinished = false;
    let timeoutAwaitingDrain = false;
    let timeoutChildClosed = false;
    let timeoutStdoutClosed = false;
    let timeoutStderrClosed = false;
    let timeoutEarliestFinishAt = 0;

    const proc = spawn(invocation.cmd, invocation.args, {
      cwd: state.working_dir || process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    currentChildProc = proc;
    const spawnedPid = proc.pid;
    if (spawnedPid != null) {
      try { writeActivePidFile(sessionDir, spawnedPid); } catch { /* best effort */ }
    }
    timeoutStdoutClosed = proc.stdout === null;
    timeoutStderrClosed = proc.stderr === null;

    const hangGuardMs = (runtimeOverrides.maxIterationSeconds ?? Defaults.MAX_ITERATION_SECONDS) * 1000;
    const outputStallGuardMs = (runtimeOverrides.outputStallSeconds ?? Defaults.OUTPUT_STALL_SECONDS) * 1000;
    let outputStallGuard: NodeJS.Timeout | null = null;

    function clearIterationGuards() {
      clearTimeout(hangGuard);
      if (outputStallGuard) {
        clearTimeout(outputStallGuard);
        outputStallGuard = null;
      }
    }

    function maybeFinishTimeoutResolution() {
      if (!timeoutAwaitingDrain || timeoutResolutionFinished) return;
      if (!timeoutChildClosed || !timeoutStdoutClosed || !timeoutStderrClosed) return;
      finishTimeoutResolution();
    }

    function scheduleTimeoutResolutionFinish(force = false) {
      if (!timeoutAwaitingDrain || timeoutResolutionFinished) return;
      if (timeoutDrainTimer) {
        clearTimeout(timeoutDrainTimer);
        timeoutDrainTimer = null;
      }
      const remainingMs = timeoutEarliestFinishAt - Date.now();
      if (remainingMs > 0) {
        timeoutDrainTimer = setTimeout(() => {
          timeoutDrainTimer = null;
          scheduleTimeoutResolutionFinish(force);
        }, remainingMs);
        timeoutDrainTimer.unref();
        return;
      }
      if (force) {
        finishTimeoutResolution();
        return;
      }
      maybeFinishTimeoutResolution();
    }

    function finishTimeoutResolution() {
      if (timeoutResolutionFinished) return;
      timeoutResolutionFinished = true;
      timeoutAwaitingDrain = false;
      if (timeoutDrainTimer) {
        clearTimeout(timeoutDrainTimer);
        timeoutDrainTimer = null;
      }
      if (timeoutResolveTimer) {
        clearTimeout(timeoutResolveTimer);
        timeoutResolveTimer = null;
      }
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      const label = stallReason === 'output_stall' ? 'output stall detected' : 'hang detected';
      console.error(`${Style.RED}❌ Iteration ${iterationNum} ${label} — forcing failure${Style.RESET}`);
      resolve({
        completion: 'error',
        timedOut: true,
        exitCode: null,
        wallSeconds: (Date.now() - start) / 1000,
        stallReason,
      });
    }

    function resolveTimeout(reason: NonNullable<IterationOutcome['stallReason']>) {
      if (settled) return;
      settled = true;
      didTimeout = true;
      stallReason = reason;
      timeoutResolutionFinished = false;
      timeoutAwaitingDrain = true;
      timeoutChildClosed = false;
      timeoutStdoutClosed = proc.stdout === null;
      timeoutStderrClosed = proc.stderr === null;
      // R-APMW-6: even if the child closes promptly after SIGTERM, keep the
      // timeout path open briefly so delayed shutdown output can still arrive
      // on the pipe and hit the iteration log before we close the fd.
      timeoutEarliestFinishAt = Date.now() + 150;
      clearIterationGuards();
      currentChildProc = null;
      proc.once('close', () => {
        timeoutChildClosed = true;
        scheduleTimeoutResolutionFinish();
      });
      // R-APMW-6: bounded fallback wait for delayed SIGTERM cleanup. The
      // child has up to TIMEOUT_RESOLVE_FALLBACK_MS to flush shutdown output
      // and exit cleanly before we force the resolve path. 500ms was too
      // tight under load (data flows stdout→pipe→Node→fd write); 1500ms
      // gives realistic slack while still bounding the resolve.
      timeoutResolveTimer = setTimeout(() => {
        scheduleTimeoutResolutionFinish(true);
      }, 1500);
      timeoutResolveTimer.unref();
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }

    function armOutputStallGuard() {
      if (settled) return;
      if (outputStallGuard) clearTimeout(outputStallGuard);
      const remainingMs = Math.max(1, (lastDataAt + outputStallGuardMs) - Date.now());
      outputStallGuard = setTimeout(() => {
        if (settled) return;
        if ((Date.now() - lastDataAt) < outputStallGuardMs) {
          armOutputStallGuard();
          return;
        }
        resolveTimeout('output_stall');
      }, remainingMs);
      outputStallGuard.unref();
    }

    const hangGuard = setTimeout(() => {
      resolveTimeout('wall_clock');
    }, hangGuardMs);
    hangGuard.unref();
    armOutputStallGuard();

    // Direct data handlers: write each chunk to both the log file (sync,
    // no buffering) and the terminal (for the tmux-runner pane).
    proc.stdout?.on('data', (chunk: Buffer) => {
      lastDataAt = Date.now();
      armOutputStallGuard();
      writeToLog(chunk);
      process.stderr.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      lastDataAt = Date.now();
      armOutputStallGuard();
      writeToLog(chunk);
      process.stderr.write(chunk);
    });
    proc.stdout?.once('close', () => {
      timeoutStdoutClosed = true;
      scheduleTimeoutResolutionFinish();
    });
    proc.stderr?.once('close', () => {
      timeoutStderrClosed = true;
      scheduleTimeoutResolutionFinish();
    });

    // eslint-disable-next-line complexity -- R-OMS-1 clearActivePidFile adds one branch; pre-existing callback retained behavior-preserving for global bin acceptance
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      currentChildProc = null;
      try { clearActivePidFile(sessionDir); } catch { /* best effort */ }
      clearIterationGuards();
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      const exitCodeFile = logFile.replace('.log', '.exitcode');
      try { fs.writeFileSync(exitCodeFile, String(code ?? -1)); } catch { /* best effort */ }
      let output = '';
      try { output = fs.readFileSync(logFile, 'utf-8'); } catch { /* missing/unreadable log */ }
      if (backend === 'codex' && detectOutputFormat(output) === 'plain-text') {
        process.stderr.write(`[classifier] codex delimiter drift: no recognizable codex/user blocks in iteration ${iterationNum} output\n`);
      }
      // R-CCPM-2: observe codex stream for setup.js self-bootstrap attempts (LOG-ONLY)
      if (state.backend === 'codex') {
        const bootstrapObs = checkIterationLogForCodexSelfBootstrap(output, state.backend, state.current_ticket, iterationNum);
        for (const obs of bootstrapObs) {
          logActivity({
            event: 'codex_manager_self_bootstrap_attempted',
            ts: new Date().toISOString(),
            source: 'pickle',
            session: path.basename(sessionDir),
            ticket: obs.ticket,
            attempted_argv: obs.attempted_argv,
            iteration: obs.iteration,
            action_taken: 'logged',
          });
        }
      }
      const completion = classifyCompletion(output);
      const normalizedOutcome = {
        completion,
        timedOut: didTimeout,
        exitCode: code ?? null,
        wallSeconds: (Date.now() - start) / 1000,
        stallReason,
      } as IterationOutcome;
      const isMaxTurnsExit = backend === 'claude'
        && detectManagerMaxTurnsExit(normalizedOutcome, logFile, maxTurns);
      if (isMaxTurnsExit) emitMaxTurnsClassifiedEvent(sessionDir, iterationNum, logFile, maxTurns, normalizedOutcome.wallSeconds);
      resolve({
        ...normalizedOutcome,
        completion: isMaxTurnsExit ? 'error' : completion,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      currentChildProc = null;
      clearIterationGuards();
      const msg = safeErrorMessage(err);
      console.error(`${Style.RED}Failed to spawn ${invocation.cmd}: ${msg}${Style.RESET}`);
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ completion: 'error', timedOut: false, exitCode: null, wallSeconds: (Date.now() - start) / 1000 });
    });
  });
}

/**
 * Atomically writes handoff.txt via a tmp file + rename.
 * On rename failure, falls back to a direct (non-atomic) write.
 * On both failures, logs an error but does NOT throw — handoff is non-critical.
 * Warns (does not throw) when tmp cleanup unlinkSync hits EACCES/ENOENT.
 *
 * @param sessionDir  - session directory path
 * @param content     - handoff content to write
 * @param pid         - process id used to make tmp filename unique
 * @param log         - logging function (e.g. the runner's log() closure)
 * @param fsOps       - injectable fs subset (default: real fs — override in tests)
 */
export function writeHandoffAtomic(
  sessionDir: string,
  content: string,
  pid: number,
  log: (msg: string) => void,
  fsOps: { writeFileSync: typeof fs.writeFileSync; renameSync: typeof fs.renameSync; unlinkSync: typeof fs.unlinkSync } = fs
): void {
  const handoffTmp = path.join(sessionDir, `handoff.txt.tmp.${pid}`);
  const handoffPath = path.join(sessionDir, 'handoff.txt');

  // Step 1: write to tmp
  try {
    fsOps.writeFileSync(handoffTmp, content);
  } catch (err) {
    const msg = safeErrorMessage(err);
    log(`ERROR: handoff.txt tmp write failed (non-critical): ${msg}`);
    return;
  }

  // Step 2: atomic rename
  try {
    fsOps.renameSync(handoffTmp, handoffPath);
    return; // success
  } catch {
    log('WARNING: handoff.txt rename failed — falling back to direct write');
  }

  // Step 3: non-atomic fallback
  try {
    fsOps.writeFileSync(handoffPath, content);
  } catch (writeErr) {
    const msg = safeErrorMessage(writeErr);
    log(`ERROR: handoff.txt write failed (non-critical): ${msg}`);
  }

  // Step 4: clean up leftover tmp
  try {
    fsOps.unlinkSync(handoffTmp);
  } catch (unlinkErr) {
    const code = (unlinkErr as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT') {
      log(`WARNING: Cannot remove tmp handoff file (${code})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Commit-pending health probe (codex-only) — RCA: codex-backend "commit-skip"
// failure mode. Codex sometimes produces edits but never `git add` + `git
// commit`, leaving valid work orphaned in the working tree when the breaker
// trips. Pre-spawn we detect uncommitted edits + iteration stagnation and
// nudge the next worker turn to commit and signal Done with a DEFERRED note.
// ---------------------------------------------------------------------------

export interface CommitPendingProbeInput {
  sessionDir: string;
  workingDir: string;
  backend: Backend;
  iteration: number;
  lastProgressIteration: number;
  threshold: number;
  pid: number;
  log: (msg: string) => void;
}

export type CommitPendingProbeResult =
  | 'skipped:not-codex'
  | 'skipped:no-stagnation'
  | 'skipped:no-uncommitted'
  | 'skipped:existing-handoff'
  | 'fired';

export const COMMIT_PENDING_HANDOFF_TEXT = `## CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING

You have uncommitted edits in the working tree but the iteration counter has not advanced for N iterations. This commonly means you are looping on a contradiction or over-exploring instead of shipping.

REQUIRED THIS TURN:
1. Run \`git add <files>\` and \`git commit -m "<msg>"\` to lock in current edits.
2. If an acceptance criterion is blocked (e.g. fixture mismatch, missing dependency), append a \`# DEFERRED: <reason>\` line to the ticket file and signal Done.
3. Do NOT continue exploring — your unblocked subset is already valuable and must not be orphaned.

After committing, emit \`<promise>${PromiseTokens.WORKER_DONE}</promise>\` as usual.
`;

/**
 * Pre-spawn health probe. Detects the codex "commit-skip" failure mode:
 * uncommitted edits in the working tree combined with iteration counter
 * stagnation. When triggered, writes handoff.txt with a direct nudge so the
 * next worker turn commits + signals Done before the circuit breaker trips.
 *
 * Triggers ONLY when ALL are true:
 *   - backend === 'codex' (claude lacks this failure mode per RCA)
 *   - iteration - lastProgressIteration >= threshold (default 2)
 *   - `git diff --stat` OR `git diff --stat --cached` is non-empty
 *
 * Idempotent: if handoff.txt already exists at probe time (e.g. user-written
 * or rate-limit handoff), the probe defers and skips. Never throws — best
 * effort. Returns a string status for tests/logs.
 */
export function commitPendingProbe(input: CommitPendingProbeInput): CommitPendingProbeResult {
  const { sessionDir, workingDir, backend, iteration, lastProgressIteration, threshold, pid, log } = input;

  if (backend !== 'codex') return 'skipped:not-codex';

  const stagnation = iteration - lastProgressIteration;
  if (stagnation < threshold) return 'skipped:no-stagnation';

  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (fs.existsSync(handoffPath)) {
    log(`commit-pending probe deferred: existing handoff.txt at ${handoffPath}`);
    return 'skipped:existing-handoff';
  }

  // Detect uncommitted edits using the same git-diff pattern as
  // classifyTicketCompletion (lines ~381-384). Both unstaged and staged
  // diffs count as "pending commit" — codex has been observed leaving
  // either flavor.
  let hasUncommitted = false;
  try {
    const unstaged = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (unstaged.length > 0) hasUncommitted = true;
    if (!hasUncommitted) {
      const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
      if (staged.length > 0) hasUncommitted = true;
    }
  } catch (err) {
    log(`commit-pending probe: git probe failed (${safeErrorMessage(err)}) — skipping`);
    return 'skipped:no-uncommitted';
  }

  if (!hasUncommitted) return 'skipped:no-uncommitted';

  const content = COMMIT_PENDING_HANDOFF_TEXT.replace('N iterations', `${stagnation} iterations`);
  writeHandoffAtomic(sessionDir, content, pid, log);
  log(`commit-pending probe FIRED: stagnation=${stagnation} (>= threshold ${threshold}), uncommitted edits present — handoff.txt written`);
  return 'fired';
}

export interface MuxReadinessGateInput {
  sessionDir: string;
  repoRoot: string;
  extensionRoot: string;
  log: (msg: string) => void;
  /**
   * BMAD residual P0.6: when set, mux-runner forwards `--skip-readiness <reason>`
   * to check-readiness, bypassing validation and emitting a `readiness_skipped`
   * activity event for audit. Wired from `state.flags.skip_readiness_reason`.
   */
  skipReason?: string;
}

const QUALITY_GATE_SUBPROCESS_TIMEOUT_MS = 60_000;

export function runMuxReadinessGate(input: MuxReadinessGateInput): number {
  const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'check-readiness.js');
  const installedBinPath = path.join(input.extensionRoot, 'bin', 'check-readiness.js');
  const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
  if (!fs.existsSync(binPath)) {
    input.log(`readiness gate skipped: ${binPath} not found`);
    return 0;
  }
  const args = [
    binPath,
    '--session-dir', input.sessionDir,
    '--repo-root', input.repoRoot,
  ];
  if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
    args.push('--skip-readiness', input.skipReason);
    input.log(`readiness gate skipped via state.flags.skip_readiness_reason: ${input.skipReason}`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: input.repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: QUALITY_GATE_SUBPROCESS_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// R-TAQ-3 — ticket audit gate (post-readiness slot)
// ---------------------------------------------------------------------------

export interface TicketAuditGateInput {
  sessionDir: string;
  extensionRoot: string;
  log: (msg: string) => void;
  skipReason?: string;
}

export type TicketAuditGateResult =
  | { status: 'bypassed'; reason: string }
  | { status: 'ok' }
  | { status: 'failed'; exitCode: number };

type QualityGateSkipCallsite = 'readiness_gate' | 'ticket_audit_gate';

interface QualityGateSkipResolution {
  reason?: string;
  legacyField?: 'skip_readiness_reason' | 'skip_ticket_audit_reason';
}

export function resolveQualityGateSkipReason(
  state: State,
  log: (msg: string) => void,
  sessionName: string,
  callsite: QualityGateSkipCallsite,
): QualityGateSkipResolution {
  const flags = state.flags;
  const unifiedRaw = flags?.skip_quality_gates_reason;
  const unifiedReason = typeof unifiedRaw === 'string' ? unifiedRaw.trim() : '';
  if (unifiedReason.length > 0) {
    return { reason: unifiedReason };
  }

  // R-QGSK-2 followup: scope the legacy fallback to the callsite's OWN legacy
  // field. Previous implementation took the first set legacy flag regardless of
  // callsite, which silently bypassed ticket_audit_gate whenever
  // skip_readiness_reason was set (broke mux-runner.audit-bundle-halt test).
  const legacyField: 'skip_readiness_reason' | 'skip_ticket_audit_reason' =
    callsite === 'readiness_gate' ? 'skip_readiness_reason' : 'skip_ticket_audit_reason';
  const legacyValueRaw = flags?.[legacyField];
  if (typeof legacyValueRaw !== 'string' || legacyValueRaw.trim().length === 0) {
    return {};
  }
  const legacyValue = (legacyValueRaw as string).trim();
  const suppressDeprecation =
    state.flags?.skip_quality_gates_deprecation_warning === true;

  if (!suppressDeprecation) {
    if (!qualityGateLegacyWarningLogged) {
      qualityGateLegacyWarningLogged = true;
      log(
        `DEPRECATION: state.flags.${legacyField} is legacy; prefer state.flags.skip_quality_gates_reason for unified quality-gate bypasses.`,
      );
    }
    logActivity({
      event: 'skip_flag_legacy_used',
      source: 'pickle',
      session: sessionName,
      gate_payload: {
        legacy_field: legacyField,
        value: legacyValue,
        callsite,
      },
    });
  }

  return { reason: legacyValue, legacyField };
}

/** Test-only: resets the once-per-process deprecation flag. Non-prod. */
export function _resetQualityGateSkipDeprecation(): void {
  qualityGateLegacyWarningLogged = false;
}

/**
 * Invokes audit-ticket-bundle.js on the session's ticket files immediately
 * after runMuxReadinessGate exits 0 and BEFORE iteration-0 spawn.
 * Non-zero exit → caller halts with exit_reason='ticket_audit_failed'.
 * skipReason (from state.flags.skip_ticket_audit_reason) → bypassed.
 */
export function runTicketAuditGate(input: TicketAuditGateInput): TicketAuditGateResult {
  if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
    input.log(`ticket audit gate bypassed via state.flags.skip_ticket_audit_reason: ${input.skipReason}`);
    return { status: 'bypassed', reason: input.skipReason };
  }
  const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'audit-ticket-bundle.js');
  const installedBinPath = path.join(input.extensionRoot, 'bin', 'audit-ticket-bundle.js');
  const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
  if (!fs.existsSync(binPath)) {
    input.log(`ticket audit gate skipped: ${binPath} not found`);
    return { status: 'ok' };
  }
  const result = spawnSync(process.execPath, [binPath, input.sessionDir], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: QUALITY_GATE_SUBPROCESS_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    return { status: 'failed', exitCode };
  }
  return { status: 'ok' };
}

/**
 * Best-effort append of a one-line marker to `pipeline-runner.log` in the
 * session directory. The pipeline-runner owns that file when it spawns
 * mux-runner; in standalone mux-runner runs the file may not exist (we never
 * create it). Failure is silent — the same marker also lands in mux-runner's
 * own log via the caller's `log()`. This exists so a human reading the
 * pipeline log alone sees the recovery event.
 */
export function appendPipelineRunnerMarker(sessionDir: string, message: string): void {
  const target = path.join(sessionDir, 'pipeline-runner.log');
  if (!fs.existsSync(target)) return; // standalone mux-runner — nothing to annotate
  try {
    fs.appendFileSync(target, `[${new Date().toISOString()}] [mux-runner] ${message}\n`);
  } catch { /* non-critical — the marker is also in mux-runner.log */ }
}

export type ExitReason = 'success' | 'cancelled' | 'error' | 'limit' | 'iteration_cap_exhausted' | 'stall' | 'circuit_open' | 'rate_limit_exhausted' | 'timeout_repeat' | 'manager_persistent_hallucination' | 'codex_unhealthy_consecutive_failures' | 'ticket_audit_failed' | 'working_tree_modified_externally' | 'state_schema_version_ahead' | 'closer_handoff_terminal' | 'manager_handoff_pending' | 'done_without_commit_evidence';

const isHaltExit = (r: ExitReason): boolean => r === 'cancelled' || r === 'limit' || r === 'timeout_repeat' || r === 'closer_handoff_terminal' || r === 'manager_handoff_pending' || r === 'done_without_commit_evidence';
const isFailureExit = (r: ExitReason): boolean => r === 'error' || r === 'stall' || r === 'circuit_open' || r === 'rate_limit_exhausted' || r === 'timeout_repeat' || r === 'manager_persistent_hallucination' || r === 'iteration_cap_exhausted' || r === 'codex_unhealthy_consecutive_failures' || r === 'ticket_audit_failed' || r === 'working_tree_modified_externally' || r === 'state_schema_version_ahead' || r === 'done_without_commit_evidence';

interface CloserHandoffTracker {
  ticket_id: string;
  head_sha: string;
  consecutive_failed_iterations: number;
}

type MuxRunnerStateWithCloserTracker = State & {
  closer_handoff_tracker?: CloserHandoffTracker | null;
};

interface TicketConformanceSnapshot {
  file: string | null;
  hasManagerHandoff: boolean;
}

type CloserTerminalDecision =
  | { action: 'continue'; tracker: CloserHandoffTracker | null }
  | { action: 'exit'; reason: Extract<ExitReason, 'closer_handoff_terminal' | 'manager_handoff_pending'>; tracker: CloserHandoffTracker | null; detail: string };

/**
 * Returns true only when the conformance has a `## Manager Handoff` section AND
 * its body is substantive (not "None", "N/A", "Nothing", empty, etc.).
 * Workers commonly write the section header with body "None" as the standard
 * no-handoff-needed boilerplate; treating that as a halt trigger produced a
 * recurring false-positive `manager_handoff_pending` exit on clean tickets
 * (e.g., session 2026-05-17-6ff53ea2/f00097e8).
 */
/**
 * Guards the worker Done-flip transition. Returns true when the ticket's
 * `completion_commit` evidence is `'explicit'` (i.e., worker shipped a real
 * git commit attributable to the ticket). Returns false otherwise — caller
 * should halt mux-runner with `done_without_commit_evidence` exit_reason.
 *
 * Bypass: `state.flags.allow_inferred_completion_commit === true` accepts
 * inferred/absent evidence (operator-only edit; surfaces in audit trail).
 *
 * Rationale: workers in B-CCPM-1b (2/3 tickets) and B-SJET (1/3 ticket
 * f00097e8) shipped ticket status=Done with prose-only verdict and no
 * attributable commit. mux-runner trusted the prose; the bundle bookkeeping
 * shipped while the actual fix never landed. This is the surgical guard.
 */
/**
 * R-CCGR: a process-blocking sleep, used only for the guard's single backoff
 * re-read. `Atomics.wait` blocks without spawning a child process.
 */
function sleepSyncMs(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SharedArrayBuffer disabled — skip the backoff */ }
}

/** R-CCGR backoff before the guard's single re-read; env-overridable, clamped. */
function guardRereadBackoffMs(): number {
  const raw = Number(process.env.PICKLE_GUARD_REREAD_BACKOFF_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 5000);
  return 500;
}

/**
 * R-PEDC: clear a stale `done_without_commit_evidence` exit_reason when a
 * later guard pass eventually classifies `ok: true`. The prior iteration's
 * fatal stamp survives a successful auto-promote in the same loop, and
 * `finalizePipeline` would otherwise read the stale value and label a fully
 * Done bundle as `failed`. Mirrors pipeline-runner's R-CCR-3 stale-handoff
 * clearance pattern: only clear when the prior failure reason is precisely
 * the one we just recovered from; leave unrelated exit_reasons untouched.
 *
 * Best-effort: a transient state read/write failure must not block the
 * happy-path Done flip. The next finalize/exit will retry as needed.
 */
export function clearStaleDoneWithoutCommitEvidence(statePath: string): void {
  try {
    const snapshot = readRecoverableJsonObject(statePath) as { exit_reason?: unknown } | null;
    if (snapshot?.exit_reason === 'done_without_commit_evidence') {
      clearExitReason(statePath);
    }
  } catch { /* best-effort — finalize path will resolve terminal state */ }
}

export function guardCompletionCommitBeforeDone(args: {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  flags?: Record<string, unknown> | null;
  /** R-CCGR: backoff (ms) before the single re-read; pass 0 in test fixtures. */
  rereadBackoffMs?: number;
}): { ok: true; sha: string } | { ok: false; reason: string; source: 'explicit' | 'inferred' | 'absent' } {
  // R-WSRC-4 parity: PICKLE_TEST_MODE=1 bypasses for sandboxed test fixtures
  // whose workingDir is a synthetic temp dir without a real git repo.
  // Production sessions never set this env var; production guard is intact.
  if (process.env.PICKLE_TEST_MODE === '1') {
    return { ok: true, sha: 'pickle-test-mode-bypass' };
  }
  const allowInferred = (args.flags ?? {})['allow_inferred_completion_commit'] === true;
  const probe = {
    sessionDir: args.sessionDir,
    ticketId: args.ticketId,
    workingDir: args.workingDir,
  };
  const guardPasses = (e: { source: string; sha: string | null }): boolean =>
    (e.source === 'explicit' && !!e.sha) || (allowInferred && !!e.sha);
  let evidence = hasCompletionCommit(probe);
  if (!guardPasses(evidence)) {
    // R-CCGR: the worker commits + stamps `completion_commit`, then emits its
    // done-promise; mux-runner can read this guard before that frontmatter
    // write is durably visible. Re-read once after a short backoff so a
    // genuinely-complete ticket is not FATAL'd on a flush race.
    sleepSyncMs(args.rereadBackoffMs ?? guardRereadBackoffMs());
    evidence = hasCompletionCommit(probe);
  }
  // R-WUWC SOFT-variant: the worker `git commit`-ed with the ticket-id in the
  // message, flipped frontmatter status=Done, but did NOT add `completion_commit:`.
  // `hasCompletionCommit` returns `source: 'inferred'` (matched by git log scan).
  // Auto-promote to 'explicit' by writing the SHA into the ticket frontmatter,
  // then re-probe. This is the runtime equivalent of the documented operator
  // workaround `edit ticket frontmatter to include completion_commit: <sha>`.
  if (evidence.source === 'inferred' && evidence.sha) {
    try {
      const filled = autoFillCompletionCommit({
        sessionDir: args.sessionDir,
        workingDir: args.workingDir,
        ticketId: args.ticketId,
        statePath: null,
      });
      if (filled.some(r => r.action === 'filled' && r.ticketId === args.ticketId)) {
        evidence = hasCompletionCommit(probe);
      }
    } catch { /* best-effort — fall through to existing classification */ }
  }
  if (evidence.source === 'explicit' && evidence.sha) {
    return { ok: true, sha: evidence.sha };
  }
  if (allowInferred && evidence.sha) {
    // Operator bypass — proceed but record the source for audit.
    return { ok: true, sha: evidence.sha };
  }
  return {
    ok: false,
    source: evidence.source,
    reason: `ticket ${args.ticketId} cannot flip Done: hasCompletionCommit().source === '${evidence.source}' (expected 'explicit'); ` +
      `worker did not produce an attributable git commit. Set state.flags.allow_inferred_completion_commit=true to bypass, ` +
      `or edit ticket frontmatter to include completion_commit: <sha>.`,
  };
}

export function hasSubstantiveManagerHandoff(content: string): boolean {
  const match = /^##\s+Manager Handoff\b[ \t]*\n?([\s\S]*?)(?=^##\s+|$(?![\s\S]))/m.exec(content);
  if (!match) return false;
  const body = match[1].trim();
  if (!body) return false;
  const firstNonEmptyLine = body
    .split(/\n/)
    .map(l => l.replace(/^[-*+]\s+/, '').trim())
    .find(l => l.length > 0) ?? '';
  // First non-empty line starting with "none", "n/a", "na", "nothing" → no handoff,
  // regardless of any explanatory text on subsequent lines or on the same line.
  if (/^(none|n\/a|na|nothing)\b/i.test(firstNonEmptyLine)) return false;
  return true;
}

function readLatestTicketConformanceSnapshot(ticketDir: string): TicketConformanceSnapshot {
  let entries: string[];
  try {
    entries = fs.readdirSync(ticketDir);
  } catch {
    return { file: null, hasManagerHandoff: false };
  }
  const latest = entries
    .filter(file => /^conformance_.*\.md$/.test(file))
    .sort()
    .at(-1);
  if (!latest) return { file: null, hasManagerHandoff: false };
  try {
    const content = fs.readFileSync(path.join(ticketDir, latest), 'utf-8');
    return {
      file: latest,
      hasManagerHandoff: hasSubstantiveManagerHandoff(content),
    };
  } catch {
    return { file: latest, hasManagerHandoff: false };
  }
}

function readCloserHandoffBudget(extensionRoot: string): number {
  const settings = loadSettingsBag(extensionRoot, 'mux-runner:closer-handoff-budget:settings');
  return positiveIntegerOrNull(settings.closer_handoff_iteration_budget) ?? 2;
}

export function evaluateCloserTerminalState(args: {
  state: State;
  sessionDir: string;
  workingDir: string;
  headSha: string | null;
  failedBudget: number;
}): CloserTerminalDecision {
  const ticketId = args.state.current_ticket;
  if (!ticketId) return { action: 'continue', tracker: null };
  let status: string;
  try {
    status = normalizeTicketStatus(getTicketStatus(args.sessionDir, ticketId));
  } catch {
    return { action: 'continue', tracker: null };
  }
  const ticketDir = path.join(args.sessionDir, ticketId);
  const conformance = readLatestTicketConformanceSnapshot(ticketDir);
  if (status === 'done' && conformance.hasManagerHandoff) {
    return {
      action: 'exit',
      reason: 'manager_handoff_pending',
      tracker: null,
      detail: `ticket ${ticketId} is Done and ${conformance.file ?? 'latest conformance artifact'} contains a Manager Handoff section`,
    };
  }
  if (status !== 'failed') return { action: 'continue', tracker: null };

  const headSha = args.headSha ?? observeCurrentHead(args.workingDir)?.sha ?? null;
  if (!headSha) {
    return { action: 'continue', tracker: null };
  }
  const prior = (args.state as MuxRunnerStateWithCloserTracker).closer_handoff_tracker;
  const consecutive = prior && prior.ticket_id === ticketId && prior.head_sha === headSha
    ? prior.consecutive_failed_iterations + 1
    : 1;
  const tracker: CloserHandoffTracker = {
    ticket_id: ticketId,
    head_sha: headSha,
    consecutive_failed_iterations: consecutive,
  };
  if (consecutive >= args.failedBudget) {
    return {
      action: 'exit',
      reason: 'closer_handoff_terminal',
      tracker,
      detail: `ticket ${ticketId} remained Failed on HEAD ${headSha} for ${consecutive}/${args.failedBudget} consecutive iterations`,
    };
  }
  return { action: 'continue', tracker };
}

function persistCloserHandoffTracker(statePath: string, tracker: CloserHandoffTracker | null): void {
  sm.update(statePath, rawState => {
    const state = rawState as MuxRunnerStateWithCloserTracker;
    if (tracker) state.closer_handoff_tracker = tracker;
    else delete state.closer_handoff_tracker;
  });
}

function exitForCloserTerminalState(
  statePath: string,
  sessionDir: string,
  iteration: number,
  decision: Extract<CloserTerminalDecision, { action: 'exit' }>,
  log: (msg: string) => void,
): ExitReason {
  recordExitReason(statePath, decision.reason);
  safeDeactivate(statePath);
  const activityEntry = {
    event: 'session_end',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration,
    ticket: decision.tracker?.ticket_id,
    reason: decision.detail,
    terminal_exit_reason: decision.reason,
  } as const;
  writeActivityEntry(statePath, activityEntry);
  logActivity(activityEntry);
  log(`${decision.reason}: ${decision.detail}. Exiting at iteration ${iteration}.`);
  return decision.reason;
}

// ---------------------------------------------------------------------------
// R-CNAR-6 — Spark codex smoke-run gate
// ---------------------------------------------------------------------------

/** Codex CLI surfaces transport, auth, and rate-limit failures with these markers. */
const CODEX_CLI_ERROR_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/,
  /\bHTTP\s*(?:429|5\d\d)\b/,
  /\b429\s+Too\s+Many\s+Requests\b/i,
  /\b5\d\d\s+(?:Bad\s+Gateway|Internal\s+Server\s+Error|Service\s+Unavailable)\b/i,
  /\bcodex(?:\s+CLI)?[:\s]+(?:error|exited|failed|crashed)\b/i,
  /\bstream\s+(?:error|disconnected)\b/i,
  /\brate[_\s-]?limit(?:\s+exceeded|_exceeded)\b/i,
  /\b401\s+Unauthorized\b/i,
];

// R-BUNDLE-1: session-hash allowlist for bundle_bootstrap_mode auto-skip.
// Extend this table when a new bundle needs both gates bypassed at launch.
const BUNDLE_BOOTSTRAP_ALLOWLIST: Record<string, Set<string>> = {
  '2026-05-07-deferred-slots': new Set(['2026-05-07-488e6e1f']),
  '2026-05-08-mega': new Set(['2026-05-09-7ff82595']),
};

export type SparkSmokeGateAction = 'allow' | 'bypass' | 'halt';
export type SparkSmokeGateRule =
  | 'gate_inactive'
  | 'bypassed'
  | 'first_two_failed'
  | 'three_consecutive_failed'
  | 'allow';

export interface SparkSmokeGateDecision {
  action: SparkSmokeGateAction;
  reason: string;
  rule: SparkSmokeGateRule;
}

const SPARK_MODEL_PATTERN = /^gpt-5\.3-codex-spark/;

function ticketHasCodexCliError(ticketDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(ticketDir);
  } catch {
    return false;
  }
  for (const file of entries) {
    if (!/^worker_session_\d+\.log$/.test(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(ticketDir, file), 'utf-8');
    } catch {
      continue;
    }
    if (CODEX_CLI_ERROR_PATTERNS.some(re => re.test(content))) return true;
  }
  return false;
}

function isSparkGateActive(state: State): boolean {
  if (state.backend !== 'codex') return false;
  const codexModel = typeof state.codex_model === 'string' ? state.codex_model : '';
  return SPARK_MODEL_PATTERN.test(codexModel);
}

function isFailedWithCodexError(sessionDir: string, ticket: TicketInfo): boolean {
  if (!ticket.id) return false;
  const status = (ticket.status ?? '').trim().toLowerCase();
  if (status !== 'failed') return false;
  return ticketHasCodexCliError(path.join(sessionDir, ticket.id));
}

/**
 * Pure decision helper for the R-CNAR-6 spark codex smoke-run gate.
 *
 * Active iff `state.backend === 'codex'` AND `state.codex_model` matches
 * `^gpt-5\.3-codex-spark`. When inactive, returns `allow / gate_inactive`.
 *
 * Halt criteria:
 *   (i) tickets[0] or tickets[1] has `status: Failed` AND a codex-CLI-error
 *       breadcrumb in any `worker_session_<pid>.log` under that ticket dir.
 *  (ii) any 3 consecutive tickets in canonical (collectTickets) order are
 *       Failed-with-codex-CLI-error breadcrumb.
 *
 * Bypass: `state.flags.skip_smoke_gate_reason='<reason>'` short-circuits to
 * `bypass`. Caller is responsible for emitting the `smoke_gate_bypassed`
 * activity event exactly once per session.
 */
export function evaluateSparkSmokeGate(state: State, sessionDir: string): SparkSmokeGateDecision {
  if (!isSparkGateActive(state)) {
    return { action: 'allow', reason: 'gate_inactive', rule: 'gate_inactive' };
  }

  const skipReasonRaw = state.flags?.skip_smoke_gate_reason;
  const skipReason = typeof skipReasonRaw === 'string' ? skipReasonRaw.trim() : '';
  if (skipReason.length > 0) {
    return { action: 'bypass', reason: skipReason, rule: 'bypassed' };
  }

  const tickets = collectTickets(sessionDir);
  let consecutive = 0;
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    const failedWithErr = isFailedWithCodexError(sessionDir, ticket);

    if (i < 2 && failedWithErr) {
      return {
        action: 'halt',
        reason: `first 2 tickets must complete: ticket[${i}]=${ticket.id} failed with codex-CLI error`,
        rule: 'first_two_failed',
      };
    }

    consecutive = failedWithErr ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      return {
        action: 'halt',
        reason: `3 consecutive ticket failures with codex-CLI errors (last: ${ticket.id})`,
        rule: 'three_consecutive_failed',
      };
    }
  }

  return { action: 'allow', reason: 'ok', rule: 'allow' };
}

const CIRCUIT_BREAKER_TIER_BUDGETS = {
  trivial: 3,
  small: 4,
  medium: 5,
  large: 12,
} as const;

type CircuitBreakerTier = keyof typeof CIRCUIT_BREAKER_TIER_BUDGETS;

export interface CircuitBreakerBudget {
  tier: string;
  budget: number;
}

function isCircuitBreakerTier(value: string): value is CircuitBreakerTier {
  return Object.prototype.hasOwnProperty.call(CIRCUIT_BREAKER_TIER_BUDGETS, value);
}

function defaultCircuitBreakerBudget(): CircuitBreakerBudget {
  return { tier: 'medium', budget: CIRCUIT_BREAKER_TIER_BUDGETS.medium };
}

function parseTicketComplexityTier(content: string): CircuitBreakerTier | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') return null;
    const match = /^complexity_tier:\s*["']?([A-Za-z_-]+)["']?\s*$/.exec(line);
    if (!match) continue;
    const tier = match[1].toLowerCase();
    return isCircuitBreakerTier(tier) ? tier : null;
  }
  return null;
}

export function getCircuitBreakerBudget(state: State, sessionDir: string): CircuitBreakerBudget {
  const cachedTier = typeof state.current_ticket_tier === 'string'
    ? state.current_ticket_tier.toLowerCase()
    : '';
  const rawCachedBudget = Number(state.current_ticket_budget);
  const cachedBudget = Number.isFinite(rawCachedBudget) ? rawCachedBudget : 0;
  if (isCircuitBreakerTier(cachedTier) && cachedBudget === CIRCUIT_BREAKER_TIER_BUDGETS[cachedTier]) {
    return { tier: cachedTier, budget: cachedBudget };
  }

  const ticket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  if (!ticket) {
    const fallback = defaultCircuitBreakerBudget();
    state.current_ticket_tier = fallback.tier;
    state.current_ticket_budget = fallback.budget;
    return fallback;
  }

  const ticketPath = path.join(sessionDir, ticket, `linear_ticket_${ticket}.md`);
  let budget = defaultCircuitBreakerBudget();
  try {
    const tier = parseTicketComplexityTier(fs.readFileSync(ticketPath, 'utf-8'));
    if (tier) budget = { tier, budget: CIRCUIT_BREAKER_TIER_BUDGETS[tier] };
  } catch {
    budget = defaultCircuitBreakerBudget();
  }

  state.current_ticket_tier = budget.tier;
  state.current_ticket_budget = budget.budget;
  return budget;
}

function settingsWithCircuitBreakerBudget(settings: CircuitBreakerConfig, budget: number): CircuitBreakerConfig {
  return {
    ...settings,
    noProgressThreshold: budget,
    halfOpenAfter: Math.min(settings.halfOpenAfter, Math.max(1, budget - 1)),
  };
}

function formatCircuitBreakerTripReason(reason: string, budget: CircuitBreakerBudget): string {
  const match = /^No progress in (\d+) iterations(?:\..*)?$/.exec(reason);
  if (!match) return reason;
  return `No progress in ${match[1]} iterations (tier: ${budget.tier}, budget: ${budget.budget})`;
}

function clearCircuitBreakerBudgetCacheOnTicketChange(state: State, previousTicket: string | null): void {
  if (previousTicket !== null && previousTicket !== state.current_ticket) {
    delete state.current_ticket_tier;
    delete state.current_ticket_budget;
  }
}

// ---------------------------------------------------------------------------
// Per-ticket timeout counter (FR-B3/B4/B12/B14) — non-persisted loop state
// ---------------------------------------------------------------------------

export interface TimeoutCounterState {
  count: number;
  ticket: string | null;
}

export interface TimeoutCounterInput {
  prev: TimeoutCounterState;
  ticketNow: string | null;
  timedOut: boolean;
  completedClean: boolean;
}

/**
 * Pure counter update: increment on same-ticket timeout, reset to 1 on
 * different-ticket timeout, zero on clean completion, pass-through otherwise.
 * `halt: true` when count reaches 2 on the same ticket.
 */
export function applyTimeoutCounter(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  const { prev, ticketNow, timedOut, completedClean } = input;
  if (timedOut) {
    if (ticketNow !== null && ticketNow === prev.ticket) {
      const count = prev.count + 1;
      return { count, ticket: ticketNow, halt: count >= 2 };
    }
    return { count: 1, ticket: ticketNow, halt: false };
  }
  if (completedClean) {
    return { count: 0, ticket: null, halt: false };
  }
  return { count: prev.count, ticket: prev.ticket, halt: false };
}

export interface TimeoutHaltContext {
  statePath: string;
  sessionDir: string;
  ticketNow: string | null;
  timeoutCount: number;
}

/**
 * Halt side-effects for FR-B12/B14: reset CB (prevent orphan streak),
 * write state.json.activity entry, emit structured stderr JSON with
 * remediation_code=RAISE_TIMEOUT, safeDeactivate. Caller sets exitReason
 * and breaks the loop.
 */
export function executeTimeoutHalt(ctx: TimeoutHaltContext): void {
  const { statePath, sessionDir, ticketNow, timeoutCount } = ctx;
  resetCircuitBreaker(sessionDir, 'timeout_repeat halt');
  writeActivityEntry(statePath, {
    event: 'halt',
    halt_reason: 'timeout_repeat',
    halted_ticket: ticketNow,
    halted_at: new Date().toISOString(),
    timeout_count: timeoutCount,
    remediation: `Re-run via /pickle-pipeline --worker-timeout <N> for fresh session, or edit worker_timeout_seconds in ${statePath} and run /pickle-retry for this session.`,
  });
  console.error(JSON.stringify({
    exit_reason: 'timeout_repeat',
    remediation_code: 'RAISE_TIMEOUT',
    ticket_id: ticketNow,
    timeout_count: timeoutCount,
    message: 'Ticket timed out on 2 consecutive attempts.',
    state_path: statePath,
  }));
  recordExitReason(statePath, 'timeout_repeat');
  safeDeactivate(statePath);
}

export type LoopAction =
  | ({ kind: 'continue' } & LoopActionEffects)
  | ({ kind: 'break'; reason: ExitReason } & LoopActionEffects)
  | ({ kind: 'noop' } & LoopActionEffects)
  | ({ kind: 'relaunch'; relaunchCount: number; pendingTickets: number } & LoopActionEffects);

interface LoopActionEffects {
  consecutiveRateLimits?: number;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  cbState?: CircuitBreakerState | null;
  resetStall?: boolean;
}

export interface LoopContext {
  sessionDir: string;
  statePath: string;
  extensionRoot: string;
  iteration: number;
  log: (msg: string) => void;
  exitResult?: IterationExitResult;
  outcome?: IterationOutcome;
  iterLogFile?: string;
  consecutiveRateLimits?: number;
  maxRateLimitRetries?: number;
  rateLimitWaitMinutes?: number;
  cbEnabled?: boolean;
  cbState?: CircuitBreakerState | null;
  cbSettings?: CircuitBreakerConfig;
  cbPath?: string;
  maxTurns?: number | null;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  lastStateIteration?: number;
  stallCount?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readState?: (statePath: string) => State;
  deactivate?: (statePath: string) => void;
  writeState?: (targetPath: string, value: unknown) => void;
  unlink?: (targetPath: string) => void;
  writeHandoff?: (sessionDir: string, content: string, pid: number, log: (msg: string) => void) => void;
  writeTimeout?: typeof writeTimeoutStub;
  updateState?: (mutator: (state: State) => void) => void;
  transitionToMeeseeks?: (state: State) => State;
}

function ctxNow(ctx: LoopContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

function ctxReadState(ctx: LoopContext): State {
  return (ctx.readState || readRunnerState)(ctx.statePath);
}

function ctxDeactivate(ctx: LoopContext): void {
  (ctx.deactivate || safeDeactivate)(ctx.statePath);
}

function ctxFinalize(ctx: LoopContext, exitReason: string): void {
  if (ctx.deactivate) {
    // Test seam: caller injected a deactivate hook — preserve old contract.
    ctx.deactivate(ctx.statePath);
    return;
  }
  finalizeTerminalState(ctx.statePath, {
    step: 'completed',
    runnerIteration: ctx.iteration,
    exitReason,
  });
}

function writeLoopState(ctx: LoopContext, targetPath: string, value: unknown): void {
  (ctx.writeState || writeStateFile)(targetPath, value as object);
}

function applyTimeoutCounterForLoop(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  return applyTimeoutCounter({ ...input });
}

function unlinkLoopPath(ctx: LoopContext, targetPath: string): void {
  if (ctx.unlink) {
    ctx.unlink(targetPath);
    return;
  }
  try { fs.unlinkSync(targetPath); } catch { /* ok */ }
}

/**
 * R-WTZ: a zeroed `worker_timeout_seconds` (microverse's own sentinel value, or
 * a resume-path bug landing 0) bricks every pickle-phase mux-runner launch with
 * exit 2 in milliseconds — masquerading as a "Session inactive" fast-exit.
 * Repair it in place at load instead of fatally exiting: recover the explicit
 * operator override from `state.flags.tier_cap_override.medium` (R-ICP-3),
 * otherwise fall back to the default worker budget. Only the exact value `0` is
 * repaired — negative / NaN / missing remain genuine corruption and stay fatal.
 */
export function repairZeroWorkerTimeout(state: State): { repaired: boolean; value: number } {
  const raw = (state as unknown as Record<string, unknown>).worker_timeout_seconds;
  if (raw !== 0) {
    const rawNum = Number(raw);
    const value = Number.isFinite(rawNum) && rawNum > 0
      ? rawNum
      : Defaults.WORKER_TIMEOUT_SECONDS;
    return { repaired: false, value };
  }
  const override = state.flags?.tier_cap_override as
    | { medium?: { worker_timeout_seconds?: unknown } }
    | undefined;
  const mediumOverride = Number(override?.medium?.worker_timeout_seconds);
  const recovered = Number.isInteger(mediumOverride) && mediumOverride > 0
    ? mediumOverride
    : Defaults.WORKER_TIMEOUT_SECONDS;
  state.worker_timeout_seconds = recovered;
  return { repaired: true, value: recovered };
}

export function validateStartupState(state: State, statePath: string): void {
  const repair = repairZeroWorkerTimeout(state);
  if (repair.repaired) {
    sm.update(statePath, s => { s.worker_timeout_seconds = repair.value; });
  }
  const rawObj = state as unknown as Record<string, unknown>;
  const issues: string[] = [];
  const maxIterField = rawObj.max_iterations;
  const rawMaxIter = Number(maxIterField);
  if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
    issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
  }
  const rawTimeout = Number(rawObj.worker_timeout_seconds);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
  else if (rawTimeout > 86400) issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
  const iterField = rawObj.iteration;
  const rawIter = Number(iterField);
  if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) issues.push(`iteration must be >= 0 (got ${iterField})`);
  if (issues.length > 0) throw new Error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
}

export function setupSignalHandlers(statePath: string, log: (msg: string) => void): void {
  const handleShutdownSignal = (signal: string) => {
    const backend = readBackendForActivity(statePath);
    const signalEvent = buildSignalReceivedEvent(statePath, path.dirname(statePath), signal);
    writeActivityEntry(statePath, signalEvent);
    try {
      logActivity(signalEvent);
    } catch { /* telemetry best effort */ }
    log(`Received ${signal} — deactivating session`);
    log(`signal_received ${JSON.stringify(signalEvent)}`);
    recordExitReason(statePath, 'signal');
    safeDeactivate(statePath);
    removeRunnerSessionMapEntry(statePath, log);
    if (currentChildProc && !currentChildProc.killed) currentChildProc.kill('SIGTERM');
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(statePath)), mode: 'tmux', backend });
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}

function readBackendForActivity(statePath: string): Backend {
  try {
    return resolveBackend(readRunnerState(statePath));
  } catch {
    return resolveBackend(null);
  }
}

function getProcessGroupId(pid: number): number | null {
  const pgidFn = (process as NodeJS.Process & { getpgid?: (targetPid: number) => number }).getpgid;
  if (typeof pgidFn !== 'function') return null;
  try {
    return pgidFn(pid);
  } catch {
    return null;
  }
}

function getHandlerStackFrames(): string[] {
  return new Error('signal received').stack
    ?.split('\n')
    .slice(1, 6)
    .map((line) => line.trim()) ?? [];
}

function lookupCommandForPid(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    const command = out.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function resolveSignalSenderAttribution(): { signal_sender_pid: number | null; signal_sender_cmd: string | null } {
  if (!Number.isInteger(process.ppid) || process.ppid <= 1) {
    return { signal_sender_pid: null, signal_sender_cmd: null };
  }
  return {
    signal_sender_pid: process.ppid,
    signal_sender_cmd: lookupCommandForPid(process.ppid),
  };
}

function buildSignalReceivedEvent(statePath: string, sessionDir: string, signal: string) {
  const sender = resolveSignalSenderAttribution();
  const receivedAt = new Date().toISOString();
  let currentPhase: string | null = null;
  try {
    const state = readRunnerState(statePath);
    currentPhase = typeof state.step === 'string' ? state.step : null;
  } catch {
  }
  return {
    event: 'signal_received' as const,
    ts: receivedAt,
    source: 'pickle' as const,
    session: path.basename(sessionDir),
    signal,
    pid: process.pid,
    ppid: process.ppid,
    is_tty: Boolean(process.stdin.isTTY || process.stdout.isTTY),
    pgid: getProcessGroupId(process.pid),
    active_child_pid: currentChildProc?.pid ?? null,
    active_child_cmd: currentChildProc?.spawnargs?.join(' ') ?? null,
    current_phase: currentPhase,
    received_at_iso: receivedAt,
    handler_stack: getHandlerStackFrames(),
    gate_payload: sender,
  };
}

/**
 * AC-LPB-04: classify a `StateManager.read()` failure on the per-iteration
 * cap-check read.
 *
 * `SCHEMA_MISMATCH` is a recoverable concurrent-writer race — a fresh read
 * on the next outer-loop turn will see the migrated state. Emit an
 * escalation activity event so the user can act if it persists, surface the
 * failure to `mux-runner.log` for visibility, then signal `'continue'` so
 * the caller retries instead of exiting (which would strand pending work).
 *
 * Every other StateError code (MISSING, CORRUPT, LOCK_FAILED, …) is
 * terminal — return `'exit_error'` so the legacy code path runs.
 */
export type CapCheckReadDecision = 'continue' | 'exit_error';
export function classifyCapCheckReadError(
  err: unknown,
  sessionDir: string,
  log: (msg: string) => void,
): CapCheckReadDecision {
  const msg = safeErrorMessage(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === 'SCHEMA_MISMATCH') {
    log(`WARN: state.json schema mismatch on cap-check read: ${msg}. Retrying next iteration.`);
    logActivity({
      event: 'cap_check_failed_schema_mismatch',
      source: 'pickle',
      session: path.basename(sessionDir),
      error: msg,
    });
    return 'continue';
  }
  log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
  return 'exit_error';
}

export function shouldExitMainLoop(state: State, ctx: LoopContext): { exit: true; reason: ExitReason } | { exit: false } {
  if (state.active !== true) {
    ctx.log('Session inactive. Exiting.');
    return { exit: true, reason: 'cancelled' };
  }
  const curIter = Number.isFinite(Number(state.iteration)) ? Number(state.iteration) : 0;
  const limitAction = shouldExitForLimits(state, ctx, curIter);
  if (limitAction.exit) return limitAction;
  if (ctx.cbEnabled && ctx.cbState && !canExecute(ctx.cbState)) {
    ctx.log(`Circuit breaker OPEN: ${ctx.cbState.reason}. Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'circuit_open' };
  }
  if (!ctx.cbEnabled && curIter === ctx.lastStateIteration && (ctx.stallCount || 0) >= 1) {
    ctx.log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'stall' };
  }
  return { exit: false };
}

function shouldExitForLimits(state: State, ctx: LoopContext, curIter: number): { exit: true; reason: ExitReason } | { exit: false } {
  const maxIter = Number.isFinite(Number(state.max_iterations)) ? Number(state.max_iterations) : 0;
  if (maxIter > 0 && curIter >= maxIter) {
    ctx.log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'limit' };
  }
  const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
  const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
  const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(ctxNow(ctx) / 1000) - startEpoch) : 0;
  if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
    ctx.log(`Time limit reached (${elapsed}s). Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'limit' };
  }
  return { exit: false };
}

export async function processRateLimitCycle(state: State, ctx: LoopContext): Promise<LoopAction> {
  const exitResult = ctx.exitResult;
  if (exitResult?.type !== 'api_limit') return { kind: 'noop' };
  const consecutiveRateLimits = (ctx.consecutiveRateLimits || 0) + 1;
  const maxRetries = ctx.maxRateLimitRetries || 3;
  const waitMinutes = ctx.rateLimitWaitMinutes || 5;
  ctx.log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRetries})`);
  const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRetries, waitMinutes);
  if (rlAction.action === 'bail') {
    logActivity({ event: 'rate_limit_exhausted', source: 'pickle', session: path.basename(ctx.sessionDir), error: `max retries (${maxRetries}) exceeded, no resetsAt available` });
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'rate_limit_exhausted', consecutiveRateLimits };
  }
  return processRateLimitWait(state, ctx, exitResult, rlAction, consecutiveRateLimits);
}

async function processRateLimitWait(
  state: State,
  ctx: LoopContext,
  exitResult: Extract<IterationExitResult, { type: 'api_limit' }>,
  rlAction: RateLimitAction,
  consecutiveRateLimits: number,
): Promise<LoopAction> {
  const waitSource = rlAction.waitSource;
  const waitPath = path.join(ctx.sessionDir, 'rate_limit_wait.json');
  const waitUntil = new Date(ctxNow(ctx) + rlAction.waitMs).toISOString();
  logActivity({ event: 'rate_limit_wait', source: 'pickle', session: path.basename(ctx.sessionDir), duration_min: Math.ceil(rlAction.waitMs / 60_000) });
  writeLoopState(ctx, waitPath, {
    waiting: true, reason: 'API rate limit', started_at: new Date(ctxNow(ctx)).toISOString(), wait_until: waitUntil,
    consecutive_waits: consecutiveRateLimits, rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
    resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null, wait_source: waitSource,
  });
  const limitedWait = await waitThroughRateLimit(state, ctx, rlAction.waitMs);
  if (limitedWait.exit) return { kind: 'break', reason: limitedWait.reason, consecutiveRateLimits };
  unlinkLoopPath(ctx, waitPath);
  const nextConsecutive = rlAction.resetCounter ? 0 : consecutiveRateLimits;
  logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(ctx.sessionDir) });
  const handoffContent = [
    buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1), '',
    `NOTE: Resumed after ${Math.ceil(rlAction.waitMs / 60_000)}-minute API rate limit wait (source: ${waitSource}).`,
    'Resume from current phase — do not repeat the rate-limited iteration.',
  ].join('\n');
  (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffContent, process.pid, ctx.log);
  return { kind: 'continue', consecutiveRateLimits: nextConsecutive };
}

async function waitThroughRateLimit(state: State, ctx: LoopContext, computedWaitMs: number): Promise<{ exit: false } | { exit: true; reason: ExitReason }> {
  const epoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
  const maxMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
  let actualWaitMs = computedWaitMs;
  if (maxMins > 0 && epoch > 0) {
    const remaining = (maxMins * 60) - (Math.floor(ctxNow(ctx) / 1000) - epoch);
    if (remaining <= 0) {
      ctxDeactivate(ctx);
      return { exit: true, reason: 'limit' };
    }
    actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
  }
  const waitEnd = ctxNow(ctx) + actualWaitMs;
  while (ctxNow(ctx) < waitEnd) {
    await (ctx.sleep || sleep)(Defaults.RATE_LIMIT_POLL_MS);
    try {
      if (ctxReadState(ctx).active !== true) return { exit: true, reason: 'cancelled' };
    } catch { /* proceed */ }
    if (maxMins > 0 && epoch > 0 && Math.floor(ctxNow(ctx) / 1000) - epoch >= maxMins * 60) return { exit: true, reason: 'limit' };
  }
  return { exit: false };
}

export async function processIterationOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): Promise<LoopAction> {
  const result = outcome.completion;
  const timeoutAction = processTimeoutOutcome(state, outcome, ctx);
  if (timeoutAction.kind === 'break') return timeoutAction;
  const cbAction = recordCircuitBreakerOutcome(state, result, ctx);
  if (cbAction.kind === 'break') return { ...timeoutAction, ...cbAction };
  const branchAction = await processCompletionBranch(state, result, ctx);
  return { ...timeoutAction, ...branchAction, cbState: cbAction.cbState };
}

function processTimeoutOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): LoopAction {
  let ticketForTimeout: string | null = state.current_ticket || null;
  try { ticketForTimeout = ctxReadState(ctx).current_ticket || null; } catch { /* keep pre-iteration ticket */ }
  const counterNext = applyTimeoutCounterForLoop({
    prev: { count: ctx.timeoutCount || 0, ticket: ctx.lastTimeoutTicket || null },
    ticketNow: ticketForTimeout,
    timedOut: outcome.timedOut === true,
    completedClean: outcome.completion === 'task_completed',
  });
  if (outcome.timedOut) {
    (ctx.writeTimeout || writeTimeoutStub)(ctx.sessionDir, {
      ticketId: ticketForTimeout, iteration: ctx.iteration, wallSeconds: outcome.wallSeconds,
      workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0, timeoutCount: counterNext.count,
      logFile: ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
    });
  }
  if (!counterNext.halt) return { kind: 'noop', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
  ctx.log(`Timeout halt: ticket ${ticketForTimeout} timed out ${counterNext.count} consecutive iterations`);
  executeTimeoutHalt({ statePath: ctx.statePath, sessionDir: ctx.sessionDir, ticketNow: ticketForTimeout, timeoutCount: counterNext.count });
  // Preserves the legacy source-order invariant: exitReason = 'timeout_repeat' before break.
  return { kind: 'break', reason: 'timeout_repeat', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
}

function recordCircuitBreakerOutcome(state: State, result: IterationOutcome['completion'], ctx: LoopContext): LoopAction {
  if (!ctx.cbEnabled || !ctx.cbState || !ctx.cbSettings || result === 'error' || result === 'inactive') return { kind: 'noop', cbState: ctx.cbState };
  const errorSig = readCircuitBreakerErrorSignature(ctx);
  const postIterState = readPostIterationState(state, ctx);
  clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, ctx.cbState.last_known_ticket);
  const progress = detectProgress(
    postIterState.working_dir || process.cwd(), ctx.cbState.last_known_head, ctx.cbState.last_known_step,
    postIterState.step, ctx.cbState.last_known_ticket, postIterState.current_ticket,
  );
  const budget = getCircuitBreakerBudget(postIterState, ctx.sessionDir);
  const cbSettings = settingsWithCircuitBreakerBudget(ctx.cbSettings, budget.budget);
  const prevCBState = ctx.cbState.state;
  const cbState = recordIterationResult(ctx.cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, ctx.iteration, cbSettings);
  cbState.last_known_head = progress.currentHead;
  cbState.last_known_step = postIterState.step;
  cbState.last_known_ticket = postIterState.current_ticket;
  if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
    cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
  }
  if (ctx.cbPath) writeLoopState(ctx, ctx.cbPath, cbState);
  if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
    logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(ctx.sessionDir), error: cbState.reason });
    ctx.log(`Circuit breaker tripped: ${cbState.reason}`);
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'circuit_open', cbState };
  }
  if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
    logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(ctx.sessionDir) });
    ctx.log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
  }
  return { kind: 'noop', cbState };
}

function readCircuitBreakerErrorSignature(ctx: LoopContext): string | null {
  try {
    const logContent = fs.readFileSync(ctx.iterLogFile || '', 'utf-8');
    return logContent ? extractErrorSignature(logContent) : null;
  } catch {
    return null;
  }
}

function readPostIterationState(state: State, ctx: LoopContext): State {
  try {
    return ctxReadState(ctx);
  } catch {
    return state;
  }
}

// eslint-disable-next-line complexity -- HT-1 reviewed: legacy completion branch retained behavior-preserving; pre-existing violation, refactor deferred to a focused PR.
export async function processCompletionBranch(state: State, result: IterationOutcome['completion'], ctx: LoopContext): Promise<LoopAction> {
  if (result === 'task_completed') return processTaskCompleted(state, ctx);
  if (result === 'review_clean') return processReviewClean(ctx);
  if (result === 'inactive') {
    ctx.log('Session deactivated. Exiting loop.');
    return { kind: 'break', reason: 'cancelled' };
  }
  if (result === 'error') {
    // Codex tmux_mode runs one long-lived manager across many tickets.
    // A 4h hang-guard SIGTERM (or other subprocess error) does not mean
    // the work is doomed — relaunch the manager and let it pick up the
    // remaining ticket queue. Bounded by CODEX_MANAGER_RELAUNCH_CAP and
    // gated on circuit-breaker state.
    let postState: State = state;
    try { postState = ctxReadState(ctx); } catch { /* fall back to pre-iteration state */ }
    const exitKind = classifyManagerRelaunchExit(
      postState,
      ctx.outcome,
      ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
      ctx.maxTurns ?? null,
    );
    const decision = evaluateManagerRelaunch(
      postState,
      collectTickets(ctx.sessionDir),
      ctx.cbState ?? null,
      exitKind,
    );
    if (decision.reason === 'time_limit') {
      ctx.log('Time limit reached. Exiting.');
      finalizeTerminalState(ctx.statePath, { step: 'completed', runnerIteration: ctx.iteration, exitReason: 'limit' });
      return { kind: 'break', reason: 'limit' };
    }
    // Genuine subprocess crash or spawn failure tears down rather than
    // relaunches: the worker process crashed for a deterministic reason and
    // relaunching would burn the cap on the same crash. We only relaunch when
    // the exitKind is a recognized recoverable signal (codex_4h_hang_guard,
    // claude_max_turns) OR there is no outcome at all (generic error, no
    // diagnostic info — likely the manager-level error path that should retry).
    const isGenuineCrashOrSpawnFailure =
      decision.exitKind === 'other_error' &&
      ctx.outcome !== undefined &&
      ctx.outcome.timedOut !== true &&
      (
        // Non-zero exit code: explicit crash.
        (typeof ctx.outcome.exitCode === 'number' && ctx.outcome.exitCode !== 0) ||
        // Null exit code without timeout: spawn failure or proc.on('error').
        ctx.outcome.exitCode === null
      );
    if (decision.shouldRelaunch && !isGenuineCrashOrSpawnFailure) {
      const relaunchBackend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
      const detail = decision.exitKind === 'other_error'
        ? 'errored'
        : `exited via ${decision.exitKind}`;
      ctx.log(
        `${relaunchBackend} manager subprocess ${detail} with ${decision.pendingCount} ticket(s) still pending — ` +
        `relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`,
      );
      recordManagerRelaunch(ctx.statePath, ctx.sessionDir, decision, ctx.iteration, ctx.log);
      // Relaunch IS progress — reset stall counter. Do NOT deactivate.
      // Do NOT reset the circuit breaker: a 4h hang-guard timeout is
      // exactly the kind of repeated event the CB should observe.
      return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: decision.pendingCount, resetStall: true };
    }
    ctx.log('Subprocess error. Exiting loop.');
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'error' };
  }
  await (ctx.sleep || sleep)(1000);
  return { kind: 'noop' };
}

// eslint-disable-next-line complexity -- HT-1 reviewed: F3 R-DWC completion_commit guard adds branches to an already-large completion handler; surrounding-flow refactor out of scope for the surgical sweep.
function processTaskCompleted(state: State, ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after task_completed: ${safeErrorMessage(err)}. Exiting.`);
    return { kind: 'break', reason: 'success' };
  }
  const decision = evaluateEpicCompletion({
    tickets: withFreshTicketStatuses(ctx.sessionDir, collectTickets(ctx.sessionDir)), currentTicket: curState.current_ticket || null,
    priorFalseCount: Number(curState.false_epic_completed_count) || 0,
    priorFalseTicket: curState.false_epic_completed_ticket ?? null,
  });
  if (decision.kind === 'persistent_hallucination') {
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'manager_persistent_hallucination' };
  }
  if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
    const handoffSummary = buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1);
    (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffSummary, process.pid, ctx.log);
    return { kind: 'continue', resetStall: true };
  }
  const closerDecision = evaluateCloserTerminalState({
    state: curState,
    sessionDir: ctx.sessionDir,
    workingDir: curState.working_dir || state.working_dir || process.cwd(),
    headSha: observeCurrentHead(curState.working_dir || state.working_dir || process.cwd())?.sha ?? null,
    failedBudget: readCloserHandoffBudget(ctx.extensionRoot),
  });
  if (closerDecision.action === 'exit' && closerDecision.reason === 'manager_handoff_pending') {
    exitForCloserTerminalState(ctx.statePath, ctx.sessionDir, ctx.iteration, closerDecision, ctx.log);
    return { kind: 'break', reason: closerDecision.reason };
  }
  if (curState.current_ticket) {
    const guard = guardCompletionCommitBeforeDone({
      sessionDir: ctx.sessionDir,
      ticketId: curState.current_ticket,
      workingDir: curState.working_dir || state.working_dir || process.cwd(),
      flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
    });
    if (!guard.ok) {
      const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
      ctx.log(msg);
      process.stderr.write(`${msg}\n`);
      recordExitReason(ctx.statePath, 'done_without_commit_evidence');
      safeDeactivate(ctx.statePath);
      return { kind: 'break', reason: 'done_without_commit_evidence' };
    }
    // R-PEDC: guard recovered — clear any stale `done_without_commit_evidence`
    // exit_reason stamped by a prior iteration so finalize doesn't mislabel a
    // fully-shipped bundle as failed.
    clearStaleDoneWithoutCommitEvidence(ctx.statePath);
    markTicketDone(ctx.sessionDir, curState.current_ticket);
    try {
      runBetweenTicketFastGate({
        statePath: ctx.statePath,
        workingDir: curState.working_dir || state.working_dir || process.cwd(),
        completedTicketId: curState.current_ticket,
        nextTicketId: null,
        landedStatus: 'done',
        log: ctx.log,
        now: ctx.now,
      });
    } catch (err) {
      ctx.log(`between-ticket fast gate failed after final completion (ignored): ${safeErrorMessage(err)}`);
    }
  }
  if (curState.chain_meeseeks === true) {
    if (ctx.updateState) ctx.updateState(s => Object.assign(s, ctx.transitionToMeeseeks ? ctx.transitionToMeeseeks(s) : transitionToMeeseeks(s, ctx.extensionRoot)));
    return { kind: 'continue', resetStall: true };
  }
  ctx.log('Task completed. Exiting loop.');
  ctxFinalize(ctx, 'success');
  return { kind: 'break', reason: 'success' };
}

function processReviewClean(ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after review_clean: ${safeErrorMessage(err)}. Treating as completed.`);
    ctxFinalize(ctx, 'success');
    return { kind: 'break', reason: 'success' };
  }
  const minIter = Number.isFinite(Number(curState.min_iterations)) ? Number(curState.min_iterations) : 0;
  const curIterNow = Number.isFinite(Number(curState.iteration)) ? Number(curState.iteration) : 0;
  if (minIter > 0 && curIterNow < minIter) {
    ctx.log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
    return { kind: 'noop' };
  }
  ctx.log('Review clean. Exiting loop.');
  ctxFinalize(ctx, 'success');
  return { kind: 'break', reason: 'success' };
}

/** Observe current HEAD: returns { branch, sha } or null on git failure. */
function observeCurrentHead(workingDir: string): { branch: string | null; sha: string } | null {
  const r = spawnSync('git', ['-C', workingDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 5000 });
  if (r.status !== 0) return null;
  const sha = ((r.stdout as string) || '').trim();
  return sha ? { branch: getHeadBranch(workingDir), sha } : null;
}

/** Returns true if the HEAD has drifted externally relative to the pinned state. */
function hasHeadDrifted(
  pinnedBranch: string | null,
  pinnedSha: string,
  observed: { branch: string | null; sha: string },
  workingDir: string,
): boolean {
  if (pinnedBranch !== null) return observed.branch !== pinnedBranch;
  if (observed.sha === pinnedSha) return false;
  const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', pinnedSha, observed.sha], { encoding: 'utf-8', timeout: 5000 });
  return r.status !== 0;
}

/**
 * R-PIWG-1: Before each ticket selection, verify HEAD hasn't been switched externally.
 * Returns true if a mismatch was detected (caller should break the loop).
 */
export function checkHeadPinMismatch(
  state: State,
  workingDir: string,
  sessionDir: string,
  statePath: string,
  log: (msg: string) => void,
): boolean {
  if (state.pinned_sha === undefined) return false;
  const pinnedBranch = state.pinned_branch ?? null;
  const pinnedSha = state.pinned_sha;
  try {
    const observed = observeCurrentHead(workingDir);
    if (!observed) return false;
    if (!hasHeadDrifted(pinnedBranch, pinnedSha, observed, workingDir)) return false;

    const detectedAtPhase = state.step || 'unknown';
    log(`HEAD mismatch detected: pinned_branch=${pinnedBranch ?? 'null'} observed_branch=${observed.branch ?? 'null'} pinned_sha=${pinnedSha} observed_sha=${observed.sha}`);

    try {
      writeActivityEntry(statePath, {
        event: 'head_mismatch_detected',
        source: 'pickle',
        ts: new Date().toISOString(),
        session: path.basename(sessionDir),
        gate_payload: {
          pinned_branch: pinnedBranch,
          observed_branch: observed.branch,
          pinned_sha: pinnedSha,
          observed_sha: observed.sha,
          detected_at_phase: detectedAtPhase,
        },
      });
    } catch (err) {
      log(`head_mismatch_detected activity write failed: ${safeErrorMessage(err)}`);
    }

    try {
      sm.update(statePath, s => {
        s.head_pin_mismatch_detail = {
          pinned_branch: pinnedBranch,
          observed_branch: observed.branch,
          pinned_sha: pinnedSha,
          observed_sha: observed.sha,
        };
      });
    } catch (err) {
      log(`head_pin_mismatch_detail write failed: ${safeErrorMessage(err)}`);
    }

    recordExitReason(statePath, 'working_tree_modified_externally');
    safeDeactivate(statePath);
    return true;
  } catch (err) {
    log(`checkHeadPinMismatch: threw (ignored): ${safeErrorMessage(err)}`);
    return false;
  }
}

/**
 * R-WSE-2: Emit worker_partial_lifecycle_exit when research-review is APPROVED
 * but downstream lifecycle artifacts are missing from the ticket dir.
 */
export function checkPartialLifecycleExit(sessionDir: string, statePath: string, ticketId: string): void {
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return; }

  if (!files.includes('research_review.md')) return;
  let reviewContent: string;
  try { reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8'); } catch { return; }
  if (!reviewContent.trimEnd().endsWith('APPROVED')) return;

  const downstreamPrefixes = ['plan', 'conformance', 'code_review'];
  const artifactsMissing: string[] = downstreamPrefixes.filter(
    prefix => !files.some(f => f === `${prefix}.md` || f.startsWith(`${prefix}_`)),
  );
  if (artifactsMissing.length === 0) return;

  let sessionLogSize = 0;
  for (const file of files) {
    if (/^worker_session_\d+\.log$/.test(file)) {
      try { sessionLogSize += fs.statSync(path.join(ticketDir, file)).size; } catch { /* ignore */ }
    }
  }

  writeActivityEntry(statePath, {
    event: 'worker_partial_lifecycle_exit',
    ts: new Date().toISOString(),
    source: 'pickle',
    ticket: ticketId,
    gate_payload: { artifacts_missing: artifactsMissing, session_log_size: sessionLogSize },
  });
}

/**
 * R-WSE-3: Emit a stderr breadcrumb when a ticket has status Failed
 * but its research_review.md ends in APPROVED.
 */
export function checkFailedAfterResearchApproved(sessionDir: string, ticketId: string): void {
  let status: string | null;
  try { status = getTicketStatus(sessionDir, ticketId); } catch { return; }
  if (normalizeTicketStatus(status) !== 'failed') return;

  const ticketDir = path.join(sessionDir, ticketId);
  let reviewContent: string;
  try { reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8'); } catch { return; }
  if (!reviewContent.trimEnd().endsWith('APPROVED')) return;

  process.stderr.write(
    `[warn] [${new Date().toISOString()}] ⚠ ticket ${ticketId} failed AFTER research APPROVED — see ${sessionDir}/${ticketId}/\n`,
  );
}

export function detectPkgJsonVersionDrift(
  srcPath: string,
  depPath: string,
  statePath: string,
): void {
  const ts = new Date().toISOString();
  let srcPkg: Record<string, unknown>;
  let depPkg: Record<string, unknown>;

  try {
    srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
    return;
  }
  try {
    depPkg = JSON.parse(fs.readFileSync(depPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
    return;
  }

  const srcVersion = String(srcPkg.version ?? '');
  const depVersion = String(depPkg.version ?? '');

  if (srcVersion === depVersion) return;

  const srcOther = Object.fromEntries(Object.entries(srcPkg).filter(([k]) => k !== 'version'));
  const depOther = Object.fromEntries(Object.entries(depPkg).filter(([k]) => k !== 'version'));
  const onlyVersionDiffers = JSON.stringify(srcOther) === JSON.stringify(depOther);

  const eventKind = onlyVersionDiffers ? 'pkgjson_only_revert_detected' : 'pkgjson_full_drift_detected';

  if (onlyVersionDiffers) {
    process.stderr.write(`[pickle-rick] pkgjson revert detected: src=${srcVersion} dep=${depVersion}\n`);
  }

  writeActivityEntry(statePath, {
    event: eventKind,
    src_version: srcVersion,
    dep_version: depVersion,
    src_path: srcPath,
    dep_path: depPath,
    ts,
  });
}

async function main() {
  try {
    assertSchemaVersionDeployParity();
  } catch (err) {
    if (err instanceof SchemaVersionDeployDriftError) {
      process.stderr.write(`${safeErrorMessage(err)}\n`);
      process.exit(1);
    }
    throw err;
  }
  await runMuxRunnerMain();
}

// eslint-disable-next-line -- legacy mux runner loop retained behavior-preserving for global bin acceptance
async function runMuxRunnerMain() {
  const sessionDir = process.argv[2];
  const statePath = sessionDir ? path.join(sessionDir, 'state.json') : '';
  if (
    !sessionDir
    || sessionDir.startsWith('--')
    || readRecoverableJsonObject(statePath) === null
  ) {
    console.error('Usage: node mux-runner.js <session-dir>');
    process.exit(1);
  }

  const extensionRoot = getExtensionRoot();
  const runnerLog = path.join(sessionDir, 'mux-runner.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(runnerLog, line);
    process.stderr.write(line);
  };

  log('mux-runner started');

  // Take ownership: setup.js writes active: false in tmux mode so the main
  // Claude window's stop hook is released immediately. We set active: true here
  // before monitor recovery and before entering the loop so workers and state
  // readers see a live session.
  let ownerState: State;
  try {
    ownerState = readRunnerState(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Cannot read initial state.json: ${msg}`);
  }
  // Startup validation — mux-runner only. microverse-runner owns its own sentinels
  // (worker_timeout_seconds=0 disables per-iteration timeout there; max_iterations=0
  // means unlimited iterations there). These rules must NOT be shared.
  {
    // R-WTZ: repair a zeroed worker_timeout_seconds before validation so a
    // poisoned sentinel value does not brick the phase with exit 2.
    const timeoutRepair = repairZeroWorkerTimeout(ownerState);
    if (timeoutRepair.repaired) {
      sm.update(statePath, s => { s.worker_timeout_seconds = timeoutRepair.value; });
      log(`[mux-runner] R-WTZ: repaired worker_timeout_seconds 0 → ${timeoutRepair.value}s at load`);
    }
    // Use raw object to detect null (JSON-serialized NaN) vs absent vs zero
    const rawObj = ownerState as unknown as Record<string, unknown>;
    const issues: string[] = [];

    const maxIterField = rawObj.max_iterations;
    const rawMaxIter = Number(maxIterField);
    if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
      issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
    }

    const rawTimeout = Number(rawObj.worker_timeout_seconds);
    if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
    } else if (rawTimeout > 86400) {
      issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
    }

    // iteration=0 is valid (fresh session); null/undefined are not — check explicitly
    // before numeric coercion since Number(null)=0 would otherwise pass.
    const iterField = rawObj.iteration;
    const rawIter = Number(iterField);
    if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) {
      issues.push(`iteration must be >= 0 (got ${iterField})`);
    }

    if (issues.length > 0) {
      console.error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
      process.exit(2);
    }
  }

  try {
    const extensionDir = path.join(extensionRoot, 'extension');
    reapOrphanedFastTestRunnersOnStartup(statePath, extensionDir, log);
  } catch (err) {
    log(`startup orphan fast-test reaper failed (ignored): ${safeErrorMessage(err)}`);
  }

  if (
    ownerState.tmux_mode === true &&
    (ownerState.active !== true || ownerState.pid !== process.pid)
  ) {
    sm.update(statePath, s => {
      s.active = true;
      s.pid = process.pid;
    });
    clearExitReason(statePath);
    log(
      ownerState.active === true
        ? 'Session ownership refreshed (pid updated)'
        : 'Session ownership taken (active: false → true)',
    );
  }

  // Auto-spawn the 4-pane monitor window. Previously each pickle skill prompt
  // (pickle-tmux, pickle-pipeline, pickle-refine-prd, …) ended with a manual
  // `bash tmux-monitor.sh …` step that the agent sometimes dropped silently.
  // Owning it here makes it unskippable. No-op when not inside tmux.
  try {
    const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
    log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  } catch (err) {
    log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
  }

  // R-PJV-2: one-shot package.json version drift detector.
  try {
    const srcPkgPath = path.join(ownerState.working_dir ?? '', 'extension', 'package.json');
    const depPkgPath = path.join(extensionRoot, 'extension', 'package.json');
    detectPkgJsonVersionDrift(srcPkgPath, depPkgPath, statePath);
  } catch (err) {
    log(`detectPkgJsonVersionDrift: threw (ignored): ${safeErrorMessage(err)}`);
  }

  // R-ICP-5: phantom-Done filesystem watcher. Catches Todo→Done flips that
  // happen mid-iteration (between the iteration-boundary backstop in
  // correctPhantomDoneTickets). One fs.watch per linear_ticket_*.md file.
  // Closed on SIGTERM/SIGINT/SIGHUP/exit so we don't leak file descriptors.
  const phantomDoneWatchers: fs.FSWatcher[] = [];
  let phantomDoneWatchersClosed = false;
  // Per-ticket debounce timers, last-known prior status (the value before a
  // possible Done flip), and re-check counters. Re-checks are capped at 2 per
  // ticket per minute to bound the cost of pathological re-flip loops.
  const phantomDoneDebounceMs = 150;
  const phantomDoneRecheckMs = 300;
  const phantomDoneRecheckWindowMs = 60_000;
  const phantomDoneRecheckCap = 2;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const priorStatusMap = new Map<string, string>();
  const recheckTimestamps = new Map<string, number[]>();
  const closePhantomDoneWatchers = (): void => {
    if (phantomDoneWatchersClosed) return;
    phantomDoneWatchersClosed = true;
    for (const watcher of phantomDoneWatchers) {
      try { watcher.close(); } catch { /* best-effort */ }
    }
    phantomDoneWatchers.length = 0;
    for (const timer of debounceTimers.values()) {
      try { clearTimeout(timer); } catch { /* best-effort */ }
    }
    debounceTimers.clear();
  };

  const refreshPriorStatusAfterInspect = (
    ticketId: string,
    ticketFile: string,
    result: PhantomDoneInspectResult,
  ): void => {
    if (result.reason === 'reverted' && result.priorStatus) {
      priorStatusMap.set(ticketId, result.priorStatus);
      return;
    }
    if (result.reason !== 'not_done' && result.reason !== 'has_completion_commit') return;
    try {
      const live = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
      if (live) priorStatusMap.set(ticketId, live);
    } catch { /* best-effort */ }
  };

  const emitBackfillEvent = (ticketId: string, commit: string, ts: string): void => {
    const shortSha = commit.slice(0, 7);
    process.stderr.write(
      `phantom-Done inferred completion commit for ticket ${ticketId} with commit ${shortSha} (work was done, explicit field was missing)\n`,
    );
    try {
      writeActivityEntry(statePath, {
        event: 'phantom_done_backfilled',
        source: 'pickle',
        session: path.basename(sessionDir),
        ticket: ticketId,
        commit_hash: commit,
        ts,
      });
      writeActivityEntry(statePath, {
        event: 'completion_commit_inferred_from_git',
        source: 'pickle',
        session: path.basename(sessionDir),
        ticket_id: ticketId,
        sha: commit,
        ts,
      });
    } catch (err) {
      log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
    }
  };

  const emitRevertEvent = (
    ticketId: string,
    result: PhantomDoneInspectResult,
    ts: string,
  ): void => {
    const priorMsg = result.priorStatus ?? 'Todo';
    if (result.gitFailureReason) {
      process.stderr.write(
        `phantom-Done detected for ticket ${ticketId} — reverted (git lookup failed: ${result.gitFailureReason})\n`,
      );
    } else {
      process.stderr.write(
        `phantom-Done detected for ticket ${ticketId} — reverted to ${priorMsg} (no completion_commit field, no matching commit in HEAD~10)\n`,
      );
    }
    try {
      writeActivityEntry(statePath, {
        event: 'phantom_done_detected',
        source: 'pickle',
        session: path.basename(sessionDir),
        ticket: ticketId,
        completion_commit_present: false,
        ts,
      });
    } catch (err) {
      log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
    }
  };

  const scheduleRecheckIfBudget = (
    ticketId: string,
    ticketFile: string,
    workingDir: string,
  ): void => {
    const now = Date.now();
    const stamps = (recheckTimestamps.get(ticketId) ?? []).filter(
      (t) => now - t < phantomDoneRecheckWindowMs,
    );
    if (stamps.length >= phantomDoneRecheckCap) {
      recheckTimestamps.set(ticketId, stamps);
      log(`phantom-Done watcher: re-check cap reached for ${ticketId} — skipping further re-checks this minute`);
      return;
    }
    stamps.push(now);
    recheckTimestamps.set(ticketId, stamps);
    setTimeout(() => {
      if (phantomDoneWatchersClosed) return;
      handlePhantomDoneEvent(ticketId, ticketFile, workingDir, true);
    }, phantomDoneRecheckMs);
  };

  const handlePhantomDoneEvent = (
    ticketId: string,
    ticketFile: string,
    workingDir: string,
    isRecheck: boolean,
  ): void => {
    const prior = priorStatusMap.get(ticketId) ?? 'Todo';
    let result: PhantomDoneInspectResult;
    try {
      result = inspectPhantomDoneTicketFile(ticketFile, sessionDir, workingDir, prior);
    } catch (err) {
      log(`phantom-Done watcher: inspect threw for ${ticketId} (ignored): ${safeErrorMessage(err)}`);
      return;
    }

    refreshPriorStatusAfterInspect(ticketId, ticketFile, result);
    if (!result.changed) return;

    const ts = new Date().toISOString();
    if (result.reason === 'backfilled' && result.commit) {
      emitBackfillEvent(ticketId, result.commit, ts);
      return;
    }
    if (result.reason !== 'reverted') return;

    emitRevertEvent(ticketId, result, ts);
    if (!isRecheck) scheduleRecheckIfBudget(ticketId, ticketFile, workingDir);
  };

  const installPhantomDoneWatchers = (): void => {
    let installed = 0;
    let skipped = 0;
    for (const ticket of collectTickets(sessionDir)) {
      if (!ticket.id) { skipped++; continue; }
      const ticketFile = path.join(sessionDir, ticket.id, `linear_ticket_${ticket.id}.md`);
      if (!fs.existsSync(ticketFile)) { skipped++; continue; }
      const ticketId = ticket.id;
      const ticketWorkingDir = ticket.working_dir || ownerState.working_dir || process.cwd();
      // Seed prior status from disk so the first revert restores the right
      // value (Todo vs. In Progress) instead of defaulting to Todo.
      try {
        const seed = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
        if (seed && seed.toLowerCase() !== 'done') {
          priorStatusMap.set(ticketId, seed);
        }
      } catch { /* best-effort */ }
      try {
        const watcher = fs.watch(ticketFile, { persistent: false }, (event) => {
          if (event !== 'change') return;
          // Debounce: coalesce rapid-fire change events into a single read.
          const existing = debounceTimers.get(ticketId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            debounceTimers.delete(ticketId);
            if (phantomDoneWatchersClosed) return;
            handlePhantomDoneEvent(ticketId, ticketFile, ticketWorkingDir, false);
          }, phantomDoneDebounceMs);
          debounceTimers.set(ticketId, timer);
        });
        phantomDoneWatchers.push(watcher);
        installed++;
      } catch (err) {
        log(`phantom-Done watcher: fs.watch threw for ${ticket.id} (ignored): ${safeErrorMessage(err)}`);
        skipped++;
      }
    }
    log(`phantom-Done watcher: installed=${installed} skipped=${skipped}`);
  };
  installPhantomDoneWatchers();
  process.on('exit', closePhantomDoneWatchers);

  // Graceful shutdown: deactivate session on SIGTERM/SIGINT so it doesn't
  // remain orphaned with active: true when the tmux pane is closed.
  const handleShutdownSignal = (signal: string) => {
    const backend = readBackendForActivity(statePath);
    const signalEvent = buildSignalReceivedEvent(statePath, sessionDir, signal);
    writeActivityEntry(statePath, signalEvent);
    try {
      logActivity(signalEvent);
    } catch { /* telemetry best effort */ }
    log(`Received ${signal} — deactivating session`);
    log(`signal_received ${JSON.stringify(signalEvent)}`);
    recordExitReason(statePath, 'signal');
    safeDeactivate(statePath);
    removeRunnerSessionMapEntry(statePath, log);
    if (currentChildProc && !currentChildProc.killed) {
      currentChildProc.kill('SIGTERM');
    }
    closePhantomDoneWatchers();
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux', backend });
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));

  // Clean up stale rate_limit_wait.json from a previous crashed session
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }

  const cbSettings = loadSettings(extensionRoot);
  const cbEnabled = cbSettings.enabled;
  let cbState: CircuitBreakerState | null = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');
  const runnerSettingsBag = loadSettingsBag(extensionRoot, 'mux-runner:main:maxTurns');
  const runnerMaxTurns: number = positiveIntegerOrNull(runnerSettingsBag.default_tmux_max_turns)
    ?? positiveIntegerOrNull(runnerSettingsBag.default_manager_max_turns)
    ?? Defaults.MANAGER_MAX_TURNS;

  const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);

  const startTime = Date.now();
  let iteration = 0;
  let meeseeksPassCount = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let consecutiveRateLimits = 0;
  let previousTicket: string | null = null;
  let previousTicketStartCommit: string | null = null;
  let exitReason: ExitReason = 'error';
  // Non-persisted per-ticket timeout counter (FR-B3/B4) — resets on runner restart.
  let timeoutCount = 0;
  let lastTimeoutTicket: string | null = null;
  // Commit-pending probe: track the last outer-loop iteration where state.iteration
  // advanced. Used to detect stagnation independently of the circuit breaker (the
  // probe runs whether CB is enabled or not).
  let lastProgressOuterIteration = 0;
  let lastObservedStateIteration = -1;
  // Settings bag for the commit-pending probe threshold (default 2). Read once
  // at startup; the loop is short-lived enough that hot-reloading isn't worth
  // the disk traffic.
  const probeSettings = loadSettingsBag(extensionRoot, 'mux-runner:commit-pending-probe:settings');
  const rawProbeThreshold = Number(probeSettings.commit_pending_probe_threshold);
  const commitPendingProbeThreshold =
    Number.isFinite(rawProbeThreshold) && rawProbeThreshold > 0 ? rawProbeThreshold : 2;
  let readinessGateChecked = false;
  let ticketAuditGateChecked = false;
  let smokeGateBypassEmitted = false;
  let bundleBootstrapApplied = false;
  while (true) {
    let state: State;
    try {
      state = readRunnerState(statePath);
    } catch (err) {
      const decision = classifyCapCheckReadError(err, sessionDir, log);
      if (decision === 'continue') {
        await sleep(1000);
        continue;
      }
      exitReason = 'error';
      break;
    }

    if (state.active !== true) {
      log('Session inactive. Exiting.');
      exitReason = 'cancelled';
      break;
    }

    state = clearStalePerTicketCacheAtIterationStart(statePath, state, log);

    const rawGlobalMaxIter = Number(state.max_iterations);
    const globalMaxIter = Number.isFinite(rawGlobalMaxIter) ? rawGlobalMaxIter : 0;
    const ticketCacheValid = isValidPerTicketCapCache(state);
    const ticketMaxIter = ticketCacheValid
      ? Number(state.current_ticket_max_iterations)
      : 0;
    const rawCurIter = Number(state.iteration);
    const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
    iteration = curIter;
    const budgetIter = ticketBudgetIterationCount(state, curIter);

    // R-ICP-1 + R-CNAR-1 part 2: two independent cap exits.
    //   (a) PER-TICKET budget exhaustion — current ticket isn't progressing
    //       within its tier ceiling (current_ticket_max_iterations).
    //   (b) GLOBAL manager-loop cap exhaustion — total iterations across all
    //       tickets reached operator-set state.max_iterations.
    // Both exit_reason='iteration_cap_exhausted' so pipeline-runner halts
    // (exit code 3, R-ICP-1 contract). Forensic-style deactivation preserves
    // step/current_ticket so postmortem can show the unfinished queue. The
    // `Max iterations reached ...` log line is retained as a stable marker
    // for grep-based forensics.
    //
    // R-CNAR-7 stale-cache guard: when state.current_ticket is null/undefined
    // but state.current_ticket_max_iterations carries a stale value from the
    // previously-completed ticket, the per-ticket cap-check would fire with
    // no ticket to attribute the exit to. This is the run-#6 attempt-1 trip:
    // a clean-success exit via finalizeTerminalState left max_iterations
    // populated; --resume re-entered the loop and the very first cap-check
    // tripped before any ticket started. Self-heal: emit
    // cap_check_skipped_stale_cache + clear the stale fields, continue.
    if (shouldEmitStalePerTicketCapSkip(state)) {
      log(stalePerTicketCacheDiagnostic(state));
      logActivity({
        event: 'cap_check_skipped_stale_cache',
        source: 'pickle',
        session: path.basename(sessionDir),
        iteration: curIter,
        gate_payload: {
          current_ticket: state.current_ticket,
          current_ticket_max_iterations: state.current_ticket_max_iterations,
          current_ticket_budget_start_iteration: state.current_ticket_budget_start_iteration,
          current_ticket_tier: state.current_ticket_tier,
        },
      });
    } else if (ticketMaxIter > 0 && budgetIter >= ticketMaxIter) {
      const tier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : 'unknown';
      const ticketId = state.current_ticket ?? 'unknown';
      log(`mux-runner exiting with code 3: per-ticket budget (${budgetIter}/${ticketMaxIter}, tier=${tier}) exhausted on ticket ${ticketId} without ${PromiseTokens.EPIC_COMPLETED} promise`);
      log(`Max iterations reached (${budgetIter}/${ticketMaxIter}). Exiting.`);
      recordExitReason(statePath, 'iteration_cap_exhausted');
      safeDeactivate(statePath);
      exitReason = 'iteration_cap_exhausted';
      break;
    }
    if (globalMaxIter > 0 && curIter >= globalMaxIter) {
      log(`mux-runner exiting with code 3: global iteration cap (${curIter}/${globalMaxIter}) exhausted without ${PromiseTokens.EPIC_COMPLETED} promise`);
      log(`Max iterations reached (${curIter}/${globalMaxIter}). Exiting.`);
      recordExitReason(statePath, 'iteration_cap_exhausted');
      safeDeactivate(statePath);
      exitReason = 'iteration_cap_exhausted';
      break;
    }

    const rawStartEpoch = Number(state.start_time_epoch);
    const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
    const rawMaxTimeMins = Number(state.max_time_minutes);
    const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
      log(`Time limit reached (${elapsed}s). Exiting.`);
      finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
      exitReason = 'limit';
      break;
    }

    // Circuit breaker gate: if CB is OPEN, exit immediately
    if (cbEnabled && cbState && !canExecute(cbState)) {
      log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
      recordExitReason(statePath, 'circuit_open');
      safeDeactivate(statePath);
      exitReason = 'circuit_open';
      break;
    }

    // Stall detection fallback (only when CB is disabled)
    if (!cbEnabled) {
      if (curIter === lastStateIteration) {
        stallCount++;
        if (stallCount >= 2) { // Stall threshold only consulted when !cbEnabled; CB-enabled sessions use CB's own progress threshold
          log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
          recordExitReason(statePath, 'stall');
          safeDeactivate(statePath);
          exitReason = 'stall';
          break;
        }
      } else {
        stallCount = 0;
      }
      lastStateIteration = curIter;
    }

    iteration = curIter + 1;
    {
      const checkState = readRunnerState(statePath);
      const checkDir = checkState.working_dir || process.cwd();
      if (checkHeadPinMismatch(checkState, checkDir, sessionDir, statePath, log)) {
        exitReason = 'working_tree_modified_externally';
        break;
      }
    }
    const templateName = state.command_template || 'pickle.md';
    if (templateName !== 'meeseeks.md') {
      correctPhantomDoneTickets({
        sessionDir,
        workingDir: state.working_dir || process.cwd(),
        startCommit: state.start_commit || null,
        iteration,
        flags: state.flags,
        log,
      });
    }
    const preTicket = templateName === 'meeseeks.md'
      ? null
      : (state.current_ticket || findNextPendingTicketId(sessionDir));
    const preStep = templateName === 'meeseeks.md'
      ? 'review'
      : inferTicketLifecycleStep(sessionDir, preTicket, state.step);
    if (preTicket && templateName !== 'meeseeks.md') {
      // R-RMBS-3: emit per-iteration runnability decision for observability.
      // Frontmatter status is the authoritative source — runnable means status is
      // Todo or In Progress (per isPendingMuxTicket).
      try {
        const frontmatterStatus = getTicketStatus(sessionDir, preTicket);
        const normalized = normalizeTicketStatus(frontmatterStatus);
        const runnable = normalized !== 'done' && normalized !== 'skipped';
        const reasonSource = state.current_ticket === preTicket ? 'state_current_ticket' : 'frontmatter_pending';
        logActivity({
          event: 'ticket_runnability_resolved',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket_id: preTicket,
          gate_payload: {
            frontmatter_status: frontmatterStatus ?? null,
            runnable,
            reason: reasonSource,
          },
        });
      } catch { /* best-effort */ }
    }
    state = updateMuxLifecycleState(statePath, { iteration, currentTicket: preTicket, step: preStep });
    state = reconcileTicketStateDesync(statePath, sessionDir, state.current_ticket || null, iteration, log);
    if (templateName !== 'meeseeks.md') {
      state = sm.update(statePath, s => {
        applyTicketTierBudget(s, sessionDir);
      });
    }
    if (templateName !== 'meeseeks.md') {
      const closerDecision = evaluateCloserTerminalState({
        state,
        sessionDir,
        workingDir: state.working_dir || process.cwd(),
        headSha: observeCurrentHead(state.working_dir || process.cwd())?.sha ?? null,
        failedBudget: readCloserHandoffBudget(extensionRoot),
      });
      if (closerDecision.action === 'exit') {
        exitReason = exitForCloserTerminalState(statePath, sessionDir, iteration, closerDecision, log);
        break;
      }
      persistCloserHandoffTracker(statePath, closerDecision.tracker);
      state = readRunnerState(statePath);
    }
    if (previousTicket === null) {
      previousTicket = state.current_ticket || null;
      if (previousTicket) {
        const ticketInfo = collectTickets(sessionDir).find(t => t.id === previousTicket);
        previousTicketStartCommit = readHeadCommit(ticketInfo?.working_dir || state.working_dir || process.cwd());
      }
    }
    // R-CCPM-3: orphan-session detection at iteration boundary
    try {
      const dataRoot = getDataRoot();
      const orphans = detectOrphanSessions(state, dataRoot, sessionDir);
      if (orphans.length > 0) {
        state = sm.update(statePath, s => {
          if (!Array.isArray(s.orphans_detected)) s.orphans_detected = [];
          for (const orphan of orphans) {
            const basename = path.basename(orphan.orphan_session_path);
            if (!s.orphans_detected.includes(basename)) {
              s.orphans_detected.push(basename);
            }
          }
        });
        for (const orphan of orphans) {
          logActivity({
            event: 'orphan_session_detected',
            source: 'pickle',
            session: path.basename(sessionDir),
            orphan_session_path: orphan.orphan_session_path,
            orphan_started_at: orphan.orphan_started_at,
            parent_session_hash: orphan.parent_session_hash,
            orphan_pid: orphan.orphan_pid,
          });
        }
      }
    } catch (err) {
      log(`orphan detection error (ignored): ${safeErrorMessage(err)}`);
    }

    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);
    logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackend(state) });

    try {
      reapOrphanedManagersAtIterationStart(statePath, sessionDir, log);
    } catch (err) {
      log(`orphan manager reaper failed (ignored): ${safeErrorMessage(err)}`);
    }

    if (templateName !== 'meeseeks.md' && applyAllTicketsDoneCompletion(statePath, sessionDir, iteration, log)) {
      exitReason = 'success';
      break;
    }

    // R-BUNDLE-1: bundle bootstrap mode — auto-apply both skip reasons for allowlisted sessions.
    // Updates local state.flags so the two gate checks below read the derived skip reasons.
    if (!bundleBootstrapApplied && curIter === 0) {
      bundleBootstrapApplied = true;
      const bootstrapMode = typeof state.flags?.bundle_bootstrap_mode === 'string'
        ? (state.flags.bundle_bootstrap_mode as string)
        : null;
      if (bootstrapMode !== null && BUNDLE_BOOTSTRAP_ALLOWLIST[bootstrapMode]?.has(path.basename(sessionDir))) {
        const derivedReason = `bundle_bootstrap_mode=${bootstrapMode}`;
        const existingFlags = state.flags ?? {};
        const skipReadinessReason = typeof existingFlags.skip_readiness_reason === 'string' && existingFlags.skip_readiness_reason.length > 0
          ? existingFlags.skip_readiness_reason
          : derivedReason;
        const skipTicketAuditReason = typeof existingFlags.skip_ticket_audit_reason === 'string' && existingFlags.skip_ticket_audit_reason.length > 0
          ? existingFlags.skip_ticket_audit_reason
          : derivedReason;
        state = { ...state, flags: { ...existingFlags, skip_readiness_reason: skipReadinessReason, skip_ticket_audit_reason: skipTicketAuditReason } };
        logActivity({
          event: 'bundle_bootstrap_exemption_applied',
          source: 'pickle',
          session: path.basename(sessionDir),
          gate_payload: {
            bundle_id: bootstrapMode,
            skip_readiness_reason: skipReadinessReason,
            skip_ticket_audit_reason: skipTicketAuditReason,
          },
        });
        log(`bundle bootstrap mode applied: ${bootstrapMode} — both gates auto-skipped for session ${path.basename(sessionDir)}`);
      }
    }

    if (!readinessGateChecked && curIter === 0) {
      readinessGateChecked = true;
      const skipReason = resolveQualityGateSkipReason(
        state,
        log,
        path.basename(sessionDir),
        'readiness_gate',
      ).reason;
      const readinessStatus = runMuxReadinessGate({
        sessionDir,
        repoRoot: state.working_dir || process.cwd(),
        extensionRoot,
        log,
        skipReason,
      });
      if (readinessStatus !== 0) {
        log(`READINESS HALT: check-readiness exited ${readinessStatus}; no manager spawn attempted`);
        process.stderr.write(`[mux-runner] readiness failed (exit ${readinessStatus}): fix the readiness findings or, to bypass with audit trail, set state.flags.skip_readiness_reason in state.json before relaunching\n`);
        recordExitReason(statePath, 'readiness_halt');
        safeDeactivate(statePath);
        exitReason = 'error';
        break;
      }
    }

    // R-TAQ-3: ticket audit gate (slot: readiness → ticket-audit → spawn).
    // Runs once on iteration-0 after readiness gate exits 0.
    if (!ticketAuditGateChecked && curIter === 0) {
      ticketAuditGateChecked = true;
      const skipAuditReason = resolveQualityGateSkipReason(
        state,
        log,
        path.basename(sessionDir),
        'ticket_audit_gate',
      ).reason;
      const auditResult = runTicketAuditGate({
        sessionDir,
        extensionRoot,
        log,
        skipReason: skipAuditReason,
      });
      if (auditResult.status === 'bypassed') {
        logActivity({
          event: 'ticket_audit_bypassed',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: auditResult.reason,
        });
      } else if (auditResult.status === 'failed') {
        log(`TICKET AUDIT HALT: audit-ticket-bundle exited ${auditResult.exitCode}; defects found — no manager spawn attempted`);
        process.stderr.write(`[mux-runner] ticket audit failed (exit ${auditResult.exitCode}): defects must be resolved before the pipeline can proceed or, to bypass with audit trail, set state.flags.skip_ticket_audit_reason in state.json before relaunching\n`);
        logActivity({
          event: 'ticket_audit_failed',
          source: 'pickle',
          session: path.basename(sessionDir),
        });
        recordExitReason(statePath, 'ticket_audit_failed');
        safeDeactivate(statePath);
        exitReason = 'ticket_audit_failed';
        break;
      }
    }

    // Multi-repo advisory check (once, on first iteration)
    if (iteration === 1) {
      const multiRepoDirs = detectMultiRepo(sessionDir, state.working_dir || process.cwd());
      if (multiRepoDirs) {
        log(`⚠️  MULTI-REPO DETECTED: Tickets span [${multiRepoDirs.join(', ')}]. Pickle Rick works best with single-repo sessions.`);
        logActivity({ event: 'multi_repo_warning', source: 'pickle', session: path.basename(sessionDir) });
      }
    }

    // Resolve meeseeks model per-pass based on tier mapping
    if (templateName === 'meeseeks.md') meeseeksPassCount++;
    const meeseeksModel = loadMeeseeksModel(extensionRoot, meeseeksPassCount);
    if (templateName === 'meeseeks.md') {
      log(`Meeseeks pass ${meeseeksPassCount} → model: ${meeseeksModel}`);
      logActivity({ event: 'meeseeks_model_select', source: 'pickle', session: path.basename(sessionDir), iteration, model: meeseeksModel, pass: meeseeksPassCount });
    }

    // Update outer-loop progress tracker for the commit-pending probe.
    // First observation seeds both fields so a fresh session never trips
    // the probe at iteration 1 from the default zero-init.
    if (lastObservedStateIteration < 0) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    } else if (curIter > lastObservedStateIteration) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    }

    // Pre-spawn commit-pending health probe (codex-only). RCA: codex
    // sometimes produces edits but never `git add` + `git commit`; if
    // stagnation persists past the threshold, nudge the next worker turn
    // to commit + signal Done so the breaker doesn't strand orphan work.
    try {
      const probeBackend = resolveBackend(state);
      const probeWorkingDir = state.working_dir || process.cwd();
      const probeResult = commitPendingProbe({
        sessionDir,
        workingDir: probeWorkingDir,
        backend: probeBackend,
        iteration,
        lastProgressIteration: lastProgressOuterIteration,
        threshold: commitPendingProbeThreshold,
        pid: process.pid,
        log,
      });
      if (probeResult === 'fired') {
        logActivity({
          event: 'commit_pending_probe_fired',
          source: 'pickle',
          session: path.basename(sessionDir),
          iteration,
        });
      }
    } catch (err) {
      // Probe is best-effort — never block the iteration on probe failure.
      log(`commit-pending probe threw (ignored): ${safeErrorMessage(err)}`);
    }

    // R-CNAR-6: spark codex smoke-run gate. Active only when state.backend='codex'
    // AND state.codex_model matches /^gpt-5\.3-codex-spark/. Halt exits with
    // exit_reason='codex_unhealthy_consecutive_failures'; auto-resume.sh STOPS per
    // R-CNAR-4(c) (any non-pipeline_phase_incomplete exit halts the resume loop).
    {
      const smokeDecision = evaluateSparkSmokeGate(state, sessionDir);
      if (smokeDecision.action === 'bypass' && !smokeGateBypassEmitted) {
        smokeGateBypassEmitted = true;
        log(`spark smoke gate bypassed: ${smokeDecision.reason}`);
        logActivity({
          event: 'smoke_gate_bypassed',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: smokeDecision.reason,
        });
      }
      if (smokeDecision.action === 'halt') {
        log(`SMOKE GATE HALT: ${smokeDecision.reason} (rule=${smokeDecision.rule})`);
        logActivity({
          event: 'codex_unhealthy_consecutive_failures',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: smokeDecision.reason,
        });
        recordExitReason(statePath, 'codex_unhealthy_consecutive_failures');
        safeDeactivate(statePath);
        exitReason = 'codex_unhealthy_consecutive_failures';
        break;
      }
    }

    // R-AISLOW: pre-spawn already-terminal check. If state.current_ticket is
    // already Done/Skipped (can happen when a prior iteration or manager turn
    // completed the ticket but state.current_ticket wasn't cleared yet), skip
    // the manager spawn and advance current_ticket to the next pending ticket.
    // This avoids wasted 1h+ manager turns that just log "already Done, skipping".
    if (templateName !== 'meeseeks.md') {
      const preskipTicket = state.current_ticket;
      if (preskipTicket) {
        let preskipStatus: string | null = null;
        try {
          preskipStatus = normalizeTicketStatus(getTicketStatus(sessionDir, preskipTicket));
        } catch { /* unreadable frontmatter — fall through to normal spawn path */ }
        if (preskipStatus === 'done' || preskipStatus === 'skipped') {
          const nextPending = findNextPendingTicketId(sessionDir);
          log(`[preskip] ${preskipTicket} already ${preskipStatus} — advancing to ${nextPending ?? 'none'} without manager spawn`);
          logActivity({
            event: 'ticket_preskipped_already_terminal',
            source: 'pickle',
            session: path.basename(sessionDir),
            iteration,
            ticket_id: preskipTicket,
            gate_payload: {
              frontmatter_status: preskipStatus,
              next_ticket_id: nextPending ?? null,
            },
          });
          // Advance via sanctioned state-write path; state re-read at top of next loop iteration
          updateMuxLifecycleState(statePath, { currentTicket: nextPending ?? null });
          continue; // skip runIteration — no manager spawn
        }
      }
    }

    const iterWorkingDir = state.working_dir || process.cwd();
    const preIterSha = readHeadCommit(iterWorkingDir);
    const outcome = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel);
    const result = outcome.completion;

    // R-WSE-2: detect partial lifecycle exit (research-review APPROVED, downstream artifacts missing)
    // R-WSE-3: emit stderr breadcrumb when ticket Failed after research APPROVED
    try {
      const iterTicket = state.current_ticket;
      if (iterTicket) checkPartialLifecycleExit(sessionDir, statePath, iterTicket);
      if (iterTicket) checkFailedAfterResearchApproved(sessionDir, iterTicket);
    } catch { /* best-effort — never block iteration on partial-lifecycle check failure */ }

    // Move iterLogFile computation BEFORE transition block (needed by classifyTicketCompletion)
    const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);

    // Detect ticket transitions: validate completion before marking Done
    try {
      const postState = readRunnerState(statePath);
      const postTicket = postState.current_ticket || null;
      let completedBoundary: { ticketId: string; landedStatus: string | null; workingDir: string; nextTicketId: string | null } | null = null;
      if (previousTicket && postTicket !== previousTicket) {
        // Check if the model already marked it Done via prompt-driven validation
        const tickets = collectTickets(sessionDir);
        const prevTicketInfo = tickets.find(t => t.id === previousTicket);
        if (prevTicketInfo?.id && normalizedStatus(getTicketStatus(sessionDir, prevTicketInfo.id)) === 'done') {
          // F3 / R-DWC: worker-self-attested Done must have explicit completion_commit.
          // Recurring failure class — Finding #2 (codex Done-without-commit).
          const guard = guardCompletionCommitBeforeDone({
            sessionDir,
            ticketId: prevTicketInfo.id,
            workingDir: prevTicketInfo.working_dir || state.working_dir || process.cwd(),
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          });
          if (!guard.ok) {
            const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
            log(msg);
            process.stderr.write(`${msg}\n`);
            recordExitReason(statePath, 'done_without_commit_evidence');
            safeDeactivate(statePath);
            return;
          }
          // R-PEDC: clear stale prior-iteration stamp on recovery.
          clearStaleDoneWithoutCommitEvidence(statePath);
          log(`Ticket ${previousTicket} already marked Done by model — skipping validation (completion_commit: ${guard.sha})`);
        } else {
          // Drift scenario: model changed current_ticket without following protocol
          const ticketWorkingDir = prevTicketInfo?.working_dir || state.working_dir || process.cwd();
          applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId: previousTicket,
            workingDir: ticketWorkingDir,
            startCommit: previousTicketStartCommit,
            iteration,
            log,
            statePath,
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          });
        }
        completedBoundary = {
          ticketId: previousTicket,
          landedStatus: prevTicketInfo?.id ? getTicketStatus(sessionDir, prevTicketInfo.id) : null,
          workingDir: prevTicketInfo?.working_dir || postState.working_dir || state.working_dir || process.cwd(),
          nextTicketId: postTicket,
        };
      }
      const postStep = inferTicketLifecycleStep(sessionDir, postTicket, postState.step);
      const lifecycleState = updateMuxLifecycleState(statePath, { currentTicket: postTicket, step: postStep });
      const nextTicket = lifecycleState.current_ticket || null;
      if (completedBoundary) {
        completedBoundary.nextTicketId = nextTicket;
        try {
          runBetweenTicketFastGate({
            statePath,
            workingDir: completedBoundary.workingDir,
            completedTicketId: completedBoundary.ticketId,
            nextTicketId: completedBoundary.nextTicketId,
            landedStatus: completedBoundary.landedStatus,
            log,
          });
        } catch (err) {
          log(`between-ticket fast gate failed at ticket boundary (ignored): ${safeErrorMessage(err)}`);
        }
      }
      if (nextTicket !== previousTicket) {
        const nextTicketInfo = nextTicket ? collectTickets(sessionDir).find(t => t.id === nextTicket) : null;
        previousTicketStartCommit = nextTicket
          ? readHeadCommit(nextTicketInfo?.working_dir || lifecycleState.working_dir || process.cwd())
          : null;
      }
      previousTicket = nextTicket;
    } catch { /* state read failed — skip transition check */ }

    // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
    const exitResult = classifyIterationExit(outcome.completion, iterLogFile, {
      didTimeout: outcome.timedOut,
      exitCode: outcome.exitCode,
      wallSeconds: outcome.wallSeconds,
    });
    const exitType = exitResult.type;
    logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitType, backend: resolveBackend(state) });
    emitMuxWastedIter({
      sessionDir,
      iteration,
      action: result,
      preIterSha,
      postIterSha: readHeadCommit(iterWorkingDir),
    });

    if (exitType === 'api_limit') {
      consecutiveRateLimits++;
      log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
      if (exitResult.rateLimitInfo?.resetsAt) {
        log(`API reports reset at ${new Date(exitResult.rateLimitInfo.resetsAt * 1000).toISOString()} (type: ${exitResult.rateLimitInfo.rateLimitType || 'unknown'})`);
      }

      const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes);

      if (rlAction.action === 'bail') {
        exitReason = 'rate_limit_exhausted';
        logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
          session: path.basename(sessionDir), error: `max retries (${maxRateLimitRetries}) exceeded, no resetsAt available` });
        recordExitReason(statePath, 'rate_limit_exhausted');
        safeDeactivate(statePath);
        break;
      }

      const { waitMs: computedWaitMs, waitSource } = rlAction;
      if (waitSource === 'api') {
        log(`Using API-provided reset time: ${Math.ceil(computedWaitMs / 60_000)}min wait (vs ${rateLimitWaitMinutes}min config default)`);
      }

      const waitUntil = new Date(Date.now() + computedWaitMs).toISOString();
      logActivity({ event: 'rate_limit_wait', source: 'pickle',
        session: path.basename(sessionDir), duration_min: Math.ceil(computedWaitMs / 60_000) });
      writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
        waiting: true, reason: 'API rate limit',
        started_at: new Date().toISOString(),
        wait_until: waitUntil,
        consecutive_waits: consecutiveRateLimits,
        rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
        resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null,
        wait_source: waitSource,
      });

      // Pre-wait time check
      const rawEpoch = Number(state.start_time_epoch);
      const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
      const rawMax = Number(state.max_time_minutes);
      const maxMins = Number.isFinite(rawMax) ? rawMax : 0;
      let actualWaitMs = computedWaitMs;
      if (maxMins > 0 && epoch > 0) {
        const elapsed = Math.floor(Date.now() / 1000) - epoch;
        const remaining = (maxMins * 60) - elapsed;
        if (remaining <= 0) {
          exitReason = 'limit';
          finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
          break;
        }
        actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
      }

      // Cancellable + time-limit-aware sleep loop
      const waitEnd = Date.now() + actualWaitMs;
      while (Date.now() < waitEnd) {
        await sleep(Defaults.RATE_LIMIT_POLL_MS);
        try {
          const ws = readRunnerState(statePath);
          if (ws.active !== true) { exitReason = 'cancelled'; break; }
        } catch { /* proceed */ }
        if (maxMins > 0 && epoch > 0) {
          const elapsed = Math.floor(Date.now() / 1000) - epoch;
          if (elapsed >= maxMins * 60) { exitReason = 'limit'; break; }
        }
      }
      if (isHaltExit(exitReason)) {
        // 'limit' is a clean-success terminal exit (budget consumed) and gets
        // finalizeTerminalState. Other halt reasons (currently only 'cancelled'
        // is reachable here from the sleep loop; 'timeout_repeat' is also
        // included in the union for parity with failure-bucket sites elsewhere
        // in this file, even though it actually exits earlier via
        // executeTimeoutHalt) preserve step/current_ticket for postmortem.
        const halt = exitReason as ExitReason;
        if (halt === 'limit') {
          finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
        } else if (halt === 'cancelled' || halt === 'timeout_repeat') {
          recordExitReason(statePath, halt);
          safeDeactivate(statePath);
        }
        break;
      }

      // Wake: cleanup + handoff
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* ok */ }
      if (rlAction.resetCounter) consecutiveRateLimits = 0;
      logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) });
      const waitedMinutes = Math.ceil(computedWaitMs / 60_000);
      const handoffContent = [
        buildIterationHandoffSummary(state, sessionDir, iteration + 1), '',
        `NOTE: Resumed after ${waitedMinutes}-minute API rate limit wait (source: ${waitSource}).`,
        'Resume from current phase — do not repeat the rate-limited iteration.',
      ].join('\n');
      writeHandoffAtomic(sessionDir, handoffContent, process.pid, log);
      continue;  // Skip CB recording + result branching entirely
    }
    if (exitType === 'success') consecutiveRateLimits = 0;

    // --- Per-ticket timeout halt (FR-B3/B4/B12/B14) — MUST run BEFORE CB recording ---
    let ticketForTimeout: string | null = state.current_ticket || null;
    try {
      const postState = readRunnerState(statePath);
      ticketForTimeout = postState.current_ticket || null;
    } catch { /* keep pre-iteration ticket as fallback */ }

    const counterNext = applyTimeoutCounterForLoop({
      prev: { count: timeoutCount, ticket: lastTimeoutTicket },
      ticketNow: ticketForTimeout,
      timedOut: outcome.timedOut === true,
      completedClean: result === 'task_completed',
    });
    timeoutCount = counterNext.count;
    lastTimeoutTicket = counterNext.ticket;

    if (outcome.timedOut) {
      writeTimeoutStub(sessionDir, {
        ticketId: ticketForTimeout,
        iteration,
        wallSeconds: outcome.wallSeconds,
        workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0,
        timeoutCount,
        logFile: iterLogFile,
      });
    }

    if (counterNext.halt) {
      log(`Timeout halt: ticket ${ticketForTimeout} timed out ${timeoutCount} consecutive iterations`);
      executeTimeoutHalt({ statePath, sessionDir, ticketNow: ticketForTimeout, timeoutCount });
      exitReason = 'timeout_repeat';
      break;
    }

    // === Existing CB recording — only reached for non-rate-limit ===

    // Circuit breaker: record iteration outcome (skip for subprocess failures)
    if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
      let errorSig: string | null = null;
      try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const logContent = fs.readFileSync(iterLogFile, 'utf-8');
        errorSig = extractErrorSignature(logContent);
      } catch { /* log may not exist */ }

      let prevCBState = cbState.state;
      // Write CB state inside sm.update to keep circuit_breaker.json in sync with state.json iteration
      try {
        sm.update(statePath, s => {
          clearCircuitBreakerBudgetCacheOnTicketChange(s, cbState!.last_known_ticket);
          const progress = detectProgress(
            s.working_dir || process.cwd(),
            cbState!.last_known_head,
            cbState!.last_known_step,
            s.step,
            cbState!.last_known_ticket,
            s.current_ticket
          );
          const budget = getCircuitBreakerBudget(s, sessionDir);
          const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
          prevCBState = cbState!.state;
          cbState = recordIterationResult(
            cbState!,
            { hasProgress: progress.hasProgress, errorSignature: errorSig },
            iteration,
            dynamicCbSettings
          );
          cbState.last_known_head = progress.currentHead;
          cbState.last_known_step = s.step;
          cbState.last_known_ticket = s.current_ticket;
          if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
            cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
          }
          writeStateFile(cbPath, cbState);
        });
      } catch {
        // sm.update failed — fall back to direct reads/writes (iteration desync possible but non-fatal)
        let postIterState: State = state;
        try {
          postIterState = readRunnerState(statePath);
        } catch { /* use last known state */ }
        clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, cbState.last_known_ticket);
        const progress = detectProgress(
          postIterState.working_dir || process.cwd(),
          cbState.last_known_head, cbState.last_known_step, postIterState.step,
          cbState.last_known_ticket, postIterState.current_ticket
        );
        const budget = getCircuitBreakerBudget(postIterState, sessionDir);
        const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
        prevCBState = cbState.state;
        cbState = recordIterationResult(
          cbState,
          { hasProgress: progress.hasProgress, errorSignature: errorSig },
          iteration,
          dynamicCbSettings
        );
        cbState.last_known_head = progress.currentHead;
        cbState.last_known_step = postIterState.step;
        cbState.last_known_ticket = postIterState.current_ticket;
        if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
          cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
        }
        writeStateFile(cbPath, cbState);
      }

      if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
        log(`Circuit breaker tripped: ${cbState.reason}`);
        recordExitReason(statePath, 'circuit_open');
        safeDeactivate(statePath);
        exitReason = 'circuit_open';
        break;
      }

      if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
        logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(sessionDir) });
        log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
      }
    }

    if (result === 'task_completed') {
      // EPIC_COMPLETED / TASK_COMPLETED — check for meeseeks chain before exiting
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
        exitReason = 'success';
        break;
      }
      // Verify EPIC_COMPLETED against ticket frontmatter. The pure helper
      // below is the only place that decides genuine vs. recoverable vs.
      // pathological — a single false EPIC_COMPLETED no longer kills the
      // pipeline. See `evaluateEpicCompletion` for the full state machine.
      const allTickets = withFreshTicketStatuses(sessionDir, collectTickets(sessionDir));
      const decision = evaluateEpicCompletion({
        tickets: allTickets,
        currentTicket: curState.current_ticket || null,
        priorFalseCount: Number(curState.false_epic_completed_count) || 0,
        priorFalseTicket: curState.false_epic_completed_ticket ?? null,
      });

      if (decision.kind === 'persistent_hallucination') {
        log(`MANAGER_PERSISTENT_HALLUCINATION: ticket ${decision.ticket} emitted ${PromiseTokens.EPIC_COMPLETED} ${decision.nextCount} times without finishing (threshold ${FALSE_EPIC_THRESHOLD}). Done=${decision.doneCount}/${decision.totalCount}. Bailing for human review.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_PERSISTENT_HALLUCINATION ticket=${decision.ticket} count=${decision.nextCount} done=${decision.doneCount}/${decision.totalCount}`);
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = decision.ticket;
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }
        logActivity({
          event: 'manager_persistent_hallucination',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: decision.ticket,
          error: `${PromiseTokens.EPIC_COMPLETED} hallucinated ${decision.nextCount}× on ticket ${decision.ticket} (done ${decision.doneCount}/${decision.totalCount})`,
        });
        recordExitReason(statePath, 'manager_persistent_hallucination');
        safeDeactivate(statePath);
        exitReason = 'manager_persistent_hallucination';
        break;
      }

      if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
        const tag = decision.kind === 'recover_advance' ? 'advancing' : 'retrying same ticket';
        const currentId = curState.current_ticket || '(none)';
        log(`MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED}: ${PromiseTokens.EPIC_COMPLETED} claimed but ${decision.doneCount} of ${decision.totalCount} tickets Done (pending: ${decision.pendingIds.join(', ') || '(none)'}). Treating as ${PromiseTokens.TASK_COMPLETED} — ${tag}. count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD}.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED} ticket=${currentId} mode=${tag} count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD} done=${decision.doneCount}/${decision.totalCount} pending=${decision.pendingIds.join(',')}`);
        logActivity({
          event: 'manager_false_epic_completed',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: curState.current_ticket || undefined,
          error: `${PromiseTokens.EPIC_COMPLETED} with ${decision.totalCount - decision.doneCount} pending — ${tag}`,
        });

        let recoveredCurrentTicket = curState.current_ticket || null;
        if (decision.kind === 'recover_advance' && curState.current_ticket) {
          // current_ticket is already Done — close it out so the next
          // iteration picks the next non-Done ticket. Counter persists at the
          // CURRENT ticket so a subsequent false epic on the SAME current
          // ticket doesn't get a fresh budget.
          const guard = guardCompletionCommitBeforeDone({
            sessionDir,
            ticketId: curState.current_ticket,
            workingDir: curState.working_dir || process.cwd(),
            flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
          });
          if (!guard.ok) {
            const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
            log(msg);
            process.stderr.write(`${msg}\n`);
            recordExitReason(statePath, 'done_without_commit_evidence');
            safeDeactivate(statePath);
            return;
          }
          // R-PEDC: clear stale prior-iteration stamp on recovery.
          clearStaleDoneWithoutCommitEvidence(statePath);
          if (markTicketDone(sessionDir, curState.current_ticket)) {
            log(`Marked ticket ${curState.current_ticket} as Done (recover_advance)`);
          }
          recoveredCurrentTicket = findNextPendingTicketId(sessionDir);
        }

        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = curState.current_ticket || null;
            const priorTicket = s.current_ticket;
            if (s.current_ticket !== recoveredCurrentTicket) {
              s.current_ticket = recoveredCurrentTicket;
              delete s.current_ticket_tier;
              delete s.current_ticket_budget;
              delete s.current_ticket_max_iterations;
              delete s.current_ticket_worker_timeout_seconds;
              delete s.current_ticket_budget_start_iteration;
            }
            const recoveredStep = inferTicketLifecycleStep(sessionDir, recoveredCurrentTicket, s.step);
            s.step = priorTicket !== recoveredCurrentTicket ? recoveredStep : maxLifecycleStep(s.step, recoveredStep);
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }

        // Stricter retry brief — handed to the next iteration via handoff.txt.
        const retryBrief = [
          `=== MANAGER FALSE EPIC RECOVERY (count ${decision.nextCount}/${FALSE_EPIC_THRESHOLD}) ===`,
          `You emitted <promise>${PromiseTokens.EPIC_COMPLETED}</promise> but only ${decision.doneCount} of ${decision.totalCount} tickets are status: Done.`,
          decision.pendingIds.length > 0 ? `Pending tickets: ${decision.pendingIds.join(', ')}.` : '',
          decision.kind === 'recover_advance'
            ? `Continue with the next non-Done ticket. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`
            : `Resume work on current_ticket=${curState.current_ticket}. It is NOT yet Done. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`,
          `Use ${PromiseTokens.TASK_COMPLETED} for single-ticket completions; reserve ${PromiseTokens.EPIC_COMPLETED} for the moment all tickets are Done.`,
        ].filter(Boolean).join('\n');
        const handoffSummary = buildIterationHandoffSummary(state, sessionDir, iteration + 1);
        writeHandoffAtomic(sessionDir, `${handoffSummary}\n\n${retryBrief}`, process.pid, log);

        // Reset stall counter so the recovery iteration isn't immediately
        // killed by the no-progress detector — the manager IS making progress
        // (we just disagree about whether it's done).
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }

      // Genuine epic completion — clear any lingering false-epic counter and
      // proceed as before.
      if (Number(curState.false_epic_completed_count) > 0) {
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = 0;
            s.false_epic_completed_ticket = null;
          });
        } catch (err) { log(`WARN: failed to clear false_epic counter: ${safeErrorMessage(err)}`); }
      }

      // Mark final ticket as Done before exiting or chaining
      if (curState.current_ticket) {
        const guard = guardCompletionCommitBeforeDone({
          sessionDir,
          ticketId: curState.current_ticket,
          workingDir: curState.working_dir || state.working_dir || process.cwd(),
          flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
        });
        if (!guard.ok) {
          const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
          log(msg);
          process.stderr.write(`${msg}\n`);
          recordExitReason(statePath, 'done_without_commit_evidence');
          safeDeactivate(statePath);
          return;
        }
        // R-PEDC: clear stale prior-iteration stamp on recovery so a
        // fully-shipped bundle finalizes as 'completed', not 'failed'.
        clearStaleDoneWithoutCommitEvidence(statePath);
        if (markTicketDone(sessionDir, curState.current_ticket)) {
          log(`Marked final ticket ${curState.current_ticket} as Done`);
        }
      }
      const closerDecision = evaluateCloserTerminalState({
        state: curState,
        sessionDir,
        workingDir: curState.working_dir || state.working_dir || process.cwd(),
        headSha: observeCurrentHead(curState.working_dir || state.working_dir || process.cwd())?.sha ?? null,
        failedBudget: readCloserHandoffBudget(extensionRoot),
      });
      if (closerDecision.action === 'exit' && closerDecision.reason === 'manager_handoff_pending') {
        exitReason = exitForCloserTerminalState(statePath, sessionDir, iteration, closerDecision, log);
        break;
      }
      if (curState.chain_meeseeks === true) {
        sm.update(statePath, s => { Object.assign(s, transitionToMeeseeks(s, extensionRoot)); });
        lastStateIteration = -1;
        stallCount = 0;
        if (cbEnabled) {
          // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
          try { fs.unlinkSync(cbPath); } catch { /* may not exist */ }
          cbState = initCircuitBreaker(sessionDir, cbSettings);
        }
        log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing loop.');
        continue;
      }
      log('Task completed. Exiting loop.');
      finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
      exitReason = 'success';
      break;
    } else if (result === 'review_clean') {
      // review_clean (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES) — apply min_iterations gate
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after review_clean: ${msg}. Treating as completed.`);
        finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
        exitReason = 'success';
        break;
      }
      const rawMinIter = Number(curState.min_iterations);
      const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
      const rawCurIter2 = Number(curState.iteration);
      const curIterNow = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
      if (minIter > 0 && curIterNow < minIter) {
        log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
      } else {
        log('Review clean. Exiting loop.');
        finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'success' });
        exitReason = 'success';
        break;
      }
    } else if (result === 'inactive') { log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break; }
    else if (result === 'error') {
      // Codex tmux_mode runs ONE long-lived manager subprocess that loops
      // across many tickets internally. The 4h hang-guard SIGTERMs it with
      // `{ completion: 'error', timedOut: true }`. Treating that as terminal
      // strands every Todo ticket the manager hadn't picked up yet. Bounded
      // relaunch path keeps the queue draining; CB-OPEN and the cap still
      // fall through to the legacy exit-on-error.
      let postState: State = state;
      try { postState = readRunnerState(statePath); } catch { /* fall back */ }
      const exitKind = classifyManagerRelaunchExit(postState, outcome, iterLogFile, runnerMaxTurns);
      const relaunchDecision = evaluateManagerRelaunch(
        postState,
        collectTickets(sessionDir),
        cbState,
        exitKind,
      );
      if (relaunchDecision.reason === 'time_limit') {
        log('Time limit reached. Exiting.');
        finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
        exitReason = 'limit';
        break;
      }
      const isGenuineCrashOrSpawnFailure =
        relaunchDecision.exitKind === 'other_error' &&
        outcome !== undefined &&
        outcome.timedOut !== true &&
        (
          (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) ||
          outcome.exitCode === null
        );
      if (relaunchDecision.shouldRelaunch && !isGenuineCrashOrSpawnFailure) {
        const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
        const detail = relaunchDecision.exitKind === 'other_error'
          ? 'errored'
          : `exited via ${relaunchDecision.exitKind}`;
        log(
          `${relaunchBackend} manager subprocess ${detail} with ${relaunchDecision.pendingCount} ticket(s) still pending — ` +
          `relaunching (count ${relaunchDecision.nextRelaunchCount}/${relaunchDecision.cap}).`,
        );
        recordManagerRelaunch(statePath, sessionDir, relaunchDecision, iteration, log);
        // Relaunch IS progress for outer-loop stall detection — reset stall.
        // Do NOT clear the circuit breaker: a 4h hang-guard timeout is the
        // exact event the CB should observe across relaunches.
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }
      log('Subprocess error. Exiting loop.');
      recordExitReason(statePath, 'error');
      safeDeactivate(statePath);
      removeRunnerSessionMapEntry(statePath, log);
      exitReason = 'error';
      break;
    }

    await sleep(1000);
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  const isFailedExit = isFailureExit(exitReason);
  logActivity({
    event: 'session_end',
    source: 'pickle',
    session: path.basename(sessionDir),
    duration_min: Math.round(totalElapsed / 60),
    mode: 'tmux',
    backend: readBackendForActivity(statePath),
    ...(isFailedExit ? { error: exitReason } : {}),
  });
  let finalStep = 'unknown';
  let finalActive = 'unknown';
  let finalMinIter = 0;
  try {
    const finalState = readRunnerState(statePath);
    const rawStep = finalState.step || 'unknown';
    finalStep = (VALID_STEPS as readonly string[]).includes(rawStep) ? rawStep : 'unknown';
    finalActive = String(finalState.active);
    const rawFinalMinIter = Number(finalState.min_iterations);
    finalMinIter = Number.isFinite(rawFinalMinIter) ? rawFinalMinIter : 0;
  } catch { /* use fallback values */ }

  printMinimalPanel('mux-runner Complete', {
    Iterations: iteration,
    Elapsed: formatTime(totalElapsed),
    FinalPhase: finalStep,
    Active: finalActive,
    ...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
  }, 'GREEN', '🥒');

  log(`mux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);

  const notif = buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed);
  displayMacNotification(notif.title, notif.body, notif.subtitle);

  // Explicit exit code so parent processes (pipeline-runner) can detect failure.
  // Matches microverse-runner.ts pattern.
  // R-ICP-1: 'iteration_cap_exhausted' is a distinct exit code (3) so
  // pipeline-runner can halt the pipeline instead of treating cap-without-
  // EPIC_COMPLETED as either silent success (0) or a generic failure (1).
  let exitCode: number;
  if (exitReason === 'iteration_cap_exhausted') exitCode = 3;
  else if (isFailedExit) exitCode = 1;
  else exitCode = 0;
  closePhantomDoneWatchers();
  process.exit(exitCode);
}

export function buildTmuxNotification(exitReason: ExitReason, finalStep: string, iteration: number, totalElapsed: number) {
  const isFailure = isFailureExit(exitReason);
  const title = isFailure
    ? '🥒 Pickle Run Failed'
    : '🥒 Pickle Run Complete';
  const subtitle = isFailure
    ? `Exit: ${exitReason} (phase: ${finalStep})`
    : exitReason === 'success'
      ? `Finished in ${formatTime(totalElapsed)}`
      : `Stopped: ${exitReason} (${formatTime(totalElapsed)})`;
  const body = `${iteration} iterations, ${formatTime(totalElapsed)}`;
  return { title, subtitle, body };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'mux-runner.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
