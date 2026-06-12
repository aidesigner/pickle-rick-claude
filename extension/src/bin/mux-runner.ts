#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, collectTickets, getTicketStatus, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification, parseTicketFrontmatter, getTicketTierBudgetWithOverrides, readFrontmatterField, upsertFrontmatterField, ticketFilePath, VALID_TICKET_COMPLEXITY_TIERS, TIER_LIFECYCLE, composeManagerPromptFromSkill, resolveWorkerTestGateTimeoutMs, resolveCommandTemplate, loadPickleSettingsBag, resolveHardeningSettings, resolveCodegraphSettings, type CompletionCommitEvidence, type TicketComplexityTier, type TicketInfo, type TicketStatus, type TicketTierBudget } from '../services/pickle-utils.js';
import { findMissingPrefixes, requiredTierArtifactPrefixes } from '../services/artifact-validation.js';
import { State, PromiseTokens, hasToken, VALID_STEPS, Defaults, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact, type ActivityLogEntry, type Backend, type RateLimitInfo, type IterationExitResult, type IterationOutcome, type RateLimitAction, type WorkerRole, type Step, type RecoveryAttempt, type HardeningSettings, type OrphanReattachPayload } from '../types/index.js';
import { StateManager, safeDeactivate, finalizeTerminalState, recordExitReason, clearExitReason, writeActivityEntry, writeTimeoutStub, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerState } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, resolveBackendFromStateFileWithSource, backendEnvOverrides } from '../services/backend-spawn.js';
import { resolveCodexModel } from './spawn-morty.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { extractAssistantContent, detectOutputFormat, observeCodexToolCallStream, CODEX_DELIMITER_RE } from '../services/classifier-utils.js';
import { updateTicketStatusInTransaction } from '../services/transaction-ticket-ops.js';
import { emitCrossTicketRegressionLinearComment } from '../lib/linear-comment.js';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
  type ManagerRelaunchExitKind,
} from '../services/manager-relaunch.js';
import { getHeadBranch, updateTicketFrontmatter, isWorkingTreeDirty, listWorkingTreeDirtyPaths, archiveBeforeDestructive, ArchiveAbortError, isCodegraphArtifact, type ArchiveContext, type ArchiveResult } from '../services/git-utils.js';
import { runRecoveryLadder, parsePlanPhases, executePhaseLoop, isConvergedPlanEligible, type PlanPhase, type RecoveryDeps, type RecoveryEvidence, type RecoveryOutcome } from '../services/recovery-controller.js';
import { detectArtifactProgress, resolveNoProgressWindowSeconds, type ArtifactProgressSnapshot } from '../services/artifact-progress-detector.js';
import { readEvidence, persistEvidence, gateForPhantomDoneRevert, type EvidenceCtx, type RevertDecision } from '../services/ticket-completion-evidence.js';
import { CodegraphService } from '../services/codegraph-service.js';
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

const MANAGER_TURN_HEARTBEAT_POLL_MS = 20_000;
const HEARTBEAT_ARTIFACT_PREFIXES = ['research_', 'plan_', 'conformance_'] as const;

// R-MWIS-1: bounded stdio-drain window after the child's 'exit' event. Node's
// 'close' event (the legacy completion signal) is gated on stdio-pipe closure,
// which can lag indefinitely on a silent 0-byte worker exit (render-lag or an
// inherited fd) and hang the mux loop at 0% CPU. 'exit' is the PRIMARY signal;
// after it fires we give the pipes this brief window to flush any imminent
// 'close' (avoids truncating buffered worker output) before finalizing.
const EXIT_DRAIN_FALLBACK_MS = 250;

export function maybeEmitManagerTurnProgress(opts: {
  sessionDir: string;
  statePath: string;
  ticketId: string | null | undefined;
  lastSeenMtimeMs: number;
}): number {
  const { sessionDir, statePath, ticketId, lastSeenMtimeMs } = opts;
  if (!ticketId) return lastSeenMtimeMs;
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try {
    files = fs.readdirSync(ticketDir);
  } catch {
    return lastSeenMtimeMs;
  }
  let maxMtimeMs = lastSeenMtimeMs;
  for (const f of files) {
    if (!HEARTBEAT_ARTIFACT_PREFIXES.some(p => f.startsWith(p)) || !f.endsWith('.md')) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(ticketDir, f));
      if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
    } catch { /* skip unreadable */ }
  }
  if (maxMtimeMs > lastSeenMtimeMs) {
    const now = new Date();
    // fs.utimesSync truncates the Date to integer-ms precision, but the OS may have
    // recorded the prior state.json write with sub-ms precision. Bumping "to now" can
    // therefore REGRESS the mtime when <1ms has elapsed since that write. The babysitter
    // freshness signal must be monotonic, so floor the current mtime and add 1ms to
    // guarantee a strict advance regardless of how fast the heartbeat fires.
    const currentMtimeMs = fs.statSync(statePath).mtimeMs;
    const bumpMtime = new Date(Math.max(now.getTime(), Math.floor(currentMtimeMs) + 1));
    fs.utimesSync(statePath, bumpMtime, bumpMtime);
    logActivity({
      event: 'manager_turn_progress',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket_id: ticketId,
      ts: now.toISOString(),
    });
    return maxMtimeMs;
  }
  return lastSeenMtimeMs;
}

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

/**
 * AC-R-WMNP-3: true iff the ticket's frontmatter is a TERMINAL no-progress flip
 * (status Failed + failed_reason 'oversized_no_progress'). Such a ticket is NOT
 * selectable for work — it must neither be respawned in-phase forever nor
 * re-engaged via a stale `state.current_ticket` after a relaunch. It stays Failed
 * and visible; the operator re-queues by setting `status: Todo`. Scoped to the
 * oversized_no_progress reason so a generic Failed ticket retains its retry
 * semantics — this is selection-layer filtering, NOT a change to the canonical
 * `isPendingMuxTicket` pendingness contract (R-RMBS-1).
 */
function isOversizedNoProgressFailed(sessionDir: string, ticketId: string | null | undefined): boolean {
  if (!ticketId) return false;
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    if (normalizeTicketStatus(readFrontmatterField(raw, 'status')) !== 'failed') return false;
    return (readFrontmatterField(raw, 'failed_reason') ?? '').trim() === 'oversized_no_progress';
  } catch (err) {
    // M4: a missing/unreadable/corrupt ticket file is no longer silently
    // swallowed. We still return false (conservative — an unreadable ticket is
    // NOT treated as a terminal no-progress flip, so selection behavior is
    // unchanged), but surface the read failure so corrupt/missing tickets are
    // observable instead of vanishing into a blanket catch.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[warn] [${new Date().toISOString()}] ⚠ isOversizedNoProgressFailed: could not read ticket ${ticketId} — ${msg}\n`,
    );
    return false;
  }
}

function findNextPendingTicketId(sessionDir: string): string | null {
  // 7eb9fa20: a ticket with an active failed-flip suppression hold is
  // non-runnable — never auto-reselected with stale evidence. Selection-layer
  // filtering only (same pattern as isOversizedNoProgressFailed).
  const held = readActiveFailedFlipHolds(sessionDir);
  return collectTickets(sessionDir).find(ticket =>
    isPendingMuxTicket(sessionDir, ticket)
    && !isOversizedNoProgressFailed(sessionDir, ticket.id)
    && !(ticket.id && held.has(ticket.id)),
  )?.id ?? null;
}

/**
 * AC-R-WMNP-3: resolve the ticket to work this iteration. Preserves the legacy
 * `state.current_ticket || findNextPendingTicketId(...)` behavior — a SET
 * current_ticket is honored (including a Done closer ticket, whose manager-handoff
 * work is still detected downstream) — with ONE new exclusion: a terminal
 * no-progress Failed flip (oversized_no_progress) is never re-engaged, breaking
 * the order-deadlock where the manager re-spawned the flipped ticket forever.
 * When current_ticket is the flipped ticket (or null), fall through to the next
 * selectable pending ticket.
 */
export function resolvePreTicket(sessionDir: string, currentTicket: string | null | undefined): string | null {
  if (
    currentTicket
    && !isOversizedNoProgressFailed(sessionDir, currentTicket)
    // 7eb9fa20: a held (failed-flip-suppressed) current_ticket is never
    // re-engaged — fall through to the next selectable pending ticket.
    && !readActiveFailedFlipHolds(sessionDir).has(currentTicket)
  ) {
    return currentTicket;
  }
  return findNextPendingTicketId(sessionDir);
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

/**
 * L5: true when the session HAS tickets but NONE are SELECTABLE for work — i.e.
 * `findNextPendingTicketId` (the same selection predicate `resolvePreTicket` uses:
 * `isPendingMuxTicket && !isOversizedNoProgressFailed`) finds nothing. This is the
 * all-terminal case the model can reach when every pending ticket flipped
 * `oversized_no_progress` Failed. Distinct from `applyAllTicketsDoneCompletion`
 * (which fires only when ALL are Done): this catches the all-terminal-Failed case
 * where the loop would otherwise enter `runIteration` with a null ticket. Returns
 * false for an empty session (no tickets) so a not-yet-populated session is never
 * misclassified as terminal.
 */
export function noRunnableTicketsRemain(sessionDir: string): boolean {
  const tickets = collectTickets(sessionDir);
  if (tickets.length === 0) return false;
  return findNextPendingTicketId(sessionDir) === null;
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

/**
 * R-AFCC-DEEP-3B/3C: classify a Done ticket for the batch phantom-Done loop and
 * apply side-effects (persist inferred SHA). Extracted to keep the loop under
 * the ESLint complexity ceiling.
 *
 * Decision matrix (R-AFCC-DEEP-3C four-state):
 *   explicit-reachable → keep Done (reachability-verified or bypass flag set)
 *   inferred           → persist completion_commit_inferred + keep Done
 *   absent             → revert (no evidence found)
 *   unreachable        → revert (explicit SHA stamped but not reachable from HEAD)
 *
 * R-RIC-EXPLICIT-4: only `inferred` (already git-verified) short-circuits
 * to keep+persist; all others fall through to phantomDoneShouldKeepDone.
 * R-CCR-1 fallback-dir is passed into hasCompletionCommit via fallbackDir.
 */
function batchLoopPhantomDoneKind(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  workingDir: string,
): PhantomDoneKind {
  // R-AFCC-DEEP-4A: migrated from hasCompletionCommit to gateForPhantomDoneRevert.
  const ctx: EvidenceCtx = { sessionDir: input.sessionDir, ticketId, workingDir, fallbackDir: input.workingDir };
  const decision: RevertDecision = gateForPhantomDoneRevert(ctx, { flags: input.flags });

  if (decision.action === 'persist-inferred') {
    // R-PDWR: persist SHA so the batch loop stamps the field (inferred-fresh path).
    const fp = ticketFilePath(input.sessionDir, ticketId);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      if (!readFrontmatterField(raw, 'completion_commit') && decision.sha) {
        const upd = upsertFrontmatterField(raw, 'completion_commit_inferred', decision.sha);
        if (upd) fs.writeFileSync(fp, upd);
      }
    } catch { /* best-effort: persist failure must not block keep-Done */ }
    return 'inferred';
  }
  if (decision.action === 'keep') {
    logPhantomDoneKept(input, ticketId, workingDir, decision.fallbackFired ?? false);
    return 'explicit-reachable';
  }
  // decision.action === 'revert'
  return 'absent';
}

/**
 * R-PDUP auto-close: detect twin tickets for a split original.
 *
 * A ticket whose title is e.g. "R-FOO-1" may have been split into
 * "R-FOO-1-i" and "R-FOO-1-ii". We identify twins by looking for any
 * ticket in the session whose title starts with `<originalTitle>-` followed
 * by one or more lowercase roman-numeral characters (i, ii, iii, iv, v).
 *
 * Returns the set of twin ticket IDs (may be empty if none found).
 */
function findSplitTwins(
  originalTitle: string | null,
  allTickets: TicketInfo[],
  selfId: string,
): TicketInfo[] {
  if (!originalTitle) return [];
  // Match titles like "R-FOO-1-i", "R-FOO-1-ii", "R-FOO-1-iii" etc.
  // The original title must not itself end in a roman-numeral suffix.
  const TWIN_SUFFIX_RE = /^[ivx]+$/i;
  const stemWithDash = originalTitle + '-';
  return allTickets.filter((t) => {
    if (!t.id || t.id === selfId || !t.title) return false;
    if (!t.title.startsWith(stemWithDash)) return false;
    const suffix = t.title.slice(stemWithDash.length);
    return TWIN_SUFFIX_RE.test(suffix);
  });
}

/**
 * R-PDUP: collect Done-twin evidence records. Returns null if any twin is
 * not Done or lacks a usable delivery SHA (caller should hold the original).
 *
 * Uses readEvidence as the oracle (per R-RIC-EXPLICIT-4 contract) to classify
 * the twin's evidence kind. Accepts explicit, inferred-fresh, AND inferred-stale
 * kinds — per R-AFCC-STAGE, an inferred-stale SHA is a stored but currently
 * unverifiable SHA, still valid evidence (e.g. non-repo workingDir is legitimate).
 * Only 'absent' blocks the auto-close.
 */
function collectTwinEvidence(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  twins: TicketInfo[],
  fallbackWorkingDir: string,
): Array<{ twinId: string; sha: string }> | null {
  const evidence: Array<{ twinId: string; sha: string }> = [];
  for (const twin of twins) {
    if (!twin.id) return null; // defensive
    let twinStatus: string;
    try {
      twinStatus = normalizedStatus(getTicketStatus(input.sessionDir, twin.id));
    } catch {
      return null;
    }
    // Any twin not Done → hold the original until all twins complete.
    if (twinStatus !== 'done') {
      input.log?.(
        `R-PDUP: holding split original ${ticketId} — twin ${twin.id} not yet Done (${twinStatus})`,
      );
      return null;
    }
    const twinCtx: EvidenceCtx = {
      sessionDir: input.sessionDir,
      ticketId: twin.id,
      workingDir: twin.working_dir || fallbackWorkingDir,
      fallbackDir: input.workingDir,
    };
    // Use the oracle (readEvidence) to classify the twin's completion evidence.
    // R-AFCC-STAGE: inferred-stale is still valid evidence — a stored SHA in a
    // non-repo workingDir (or when the commit was dropped from the graph) is
    // legitimate; we accept it rather than blocking the auto-close.
    const twinEvidence = readEvidence(twinCtx);
    if (twinEvidence.kind === 'absent' || !twinEvidence.sha) {
      input.log?.(
        `R-PDUP: holding split original ${ticketId} — twin ${twin.id} Done but no usable delivery SHA`,
      );
      return null;
    }
    evidence.push({ twinId: twin.id, sha: twinEvidence.sha });
  }
  return evidence;
}

/**
 * R-PDUP roster-scanner auto-close branch, called from correctPhantomDoneTickets.
 *
 * For a Todo/Failed ticket that is a split original:
 *   - ALL twins Done + delivery SHA available → auto-close with twin's EXPLICIT SHA.
 *   - Only some twins Done → HOLD (not closed); original waits until every twin
 *     completes so the delivering commit is unambiguous.
 *   - No twins found → not a split original; skip (leave for normal roster run).
 *
 * We write an EXPLICIT completion_commit (NEVER _inferred) to prevent the
 * phantom-done-backfill infinite-loop (20MB-state incident in project memory).
 */
function maybeAutoCloseSplitOriginal(
  input: CorrectPhantomDoneTicketsInput,
  ticket: TicketInfo,
  allTickets: TicketInfo[],
): boolean {
  if (!ticket.id || !ticket.title) return false;

  const twins = findSplitTwins(ticket.title, allTickets, ticket.id);
  if (twins.length === 0) return false;

  const workingDir = ticket.working_dir || input.workingDir || process.cwd();
  const twinEvidence = collectTwinEvidence(input, ticket.id, twins, workingDir);
  if (!twinEvidence) return false; // hold: at least one twin not yet Done/provable

  // All twins Done with delivery SHAs — first twin's SHA is canonical.
  // (Any twin SHA proves the split work landed; first-found is stable across calls.)
  const canonicalSha = twinEvidence[0]!.sha;

  const origCtx: EvidenceCtx = {
    sessionDir: input.sessionDir,
    ticketId: ticket.id,
    workingDir,
    fallbackDir: input.workingDir,
  };

  // Write EXPLICIT completion_commit — twin evidence is authoritative.
  // The original was superseded before doing its own work, so readEvidence on
  // the original may return 'absent'; that is expected and must not block close.
  const persisted = persistEvidence(origCtx, canonicalSha, { stage: 'best-effort' });
  if (persisted.action === 'no_file' || persisted.action === 'unwritable') {
    input.log?.(
      `R-PDUP: could not write completion_commit for split original ${ticket.id} (persist failed: ${persisted.action})`,
    );
    return false;
  }

  if (!writeTicketStatus(input.sessionDir, ticket.id, 'Done')) return false;

  input.log?.(
    `R-PDUP: auto-closed split original ${ticket.id} — twins [${twinEvidence.map((e) => e.twinId).join(', ')}] Done, completion_commit=${canonicalSha}`,
  );
  logActivity({
    event: 'ticket_phantom_done_corrected',
    source: 'pickle',
    session: path.basename(input.sessionDir),
    ticket: ticket.id,
    iteration: input.iteration,
    reason: 'split_original_auto_closed_by_twin_evidence',
  });
  return true;
}

// eslint-disable-next-line -- R-PDUP adds the todo/failed auto-close branch; R-AFCC-DEEP-3B requires batchLoopPhantomDoneKind to stay in this function body (audit-phantom-done-call-sites.sh invariant)
export function correctPhantomDoneTickets(input: CorrectPhantomDoneTicketsInput): number {
  const allTickets = collectTickets(input.sessionDir);
  let corrected = 0;
  for (const ticket of allTickets) {
    let status: string;
    try {
      status = ticket.id ? normalizedStatus(getTicketStatus(input.sessionDir, ticket.id)) : '';
    } catch {
      continue;
    }
    if (!ticket.id) continue;

    // --- Existing branch: revert phantom-Done tickets with absent evidence ---
    if (status === 'done') {
      const workingDir = ticket.working_dir || input.workingDir || process.cwd();
      const conformance = readLatestTicketConformanceSnapshot(path.join(input.sessionDir, ticket.id));
      if (conformance.hasManagerHandoff) continue;
      // R-AFCC-DEEP-3B: decision matrix delegated to batchLoopPhantomDoneKind (complexity ceiling).
      const kind = batchLoopPhantomDoneKind(input, ticket.id, workingDir);
      if (kind === 'explicit-reachable' || kind === 'inferred') continue;
      // kind is 'absent' or 'unreachable' → revert
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
      continue;
    }

    // --- R-PDUP auto-close branch: auto-close Todo/Failed split originals ---
    // A split original is a ticket whose title has no roman-numeral suffix but
    // whose children (with -i/-ii suffix) have all been Done. We auto-close it
    // with the twin's delivery SHA so the roster scanner cannot re-run it.
    if (status === 'todo' || status === 'failed') {
      if (maybeAutoCloseSplitOriginal(input, ticket, allTickets)) corrected++;
    }
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
 * R-AFCC-DEEP-3B: explicit decision-matrix kinds for phantom-Done reconciliation.
 * - explicit-reachable: completion_commit present and HEAD-reachable (or watcher path sees field at all)
 * - inferred: git-log scan found a matching commit (SHA will be persisted as completion_commit_inferred)
 * - absent: no evidence found — ticket must revert
 * - unreachable: completion_commit present but SHA not reachable from HEAD — ticket must revert
 */
export type PhantomDoneKind = 'explicit-reachable' | 'inferred' | 'absent' | 'unreachable';

/**
 * R-AFCC-DEEP-3B: apply the phantom-Done decision for a single file after
 * pre-checks have already passed (status=Done, id present). Extracted to keep
 * inspectPhantomDoneTicketFile under the ESLint complexity ceiling.
 *
 * Watcher path: explicit field presence → 'explicit-reachable' (no git probe).
 * This preserves the path-7 characterization invariant: has_completion_commit
 * fires without git reachability probing.
 */
function applyInspectPhantomDoneDecision(
  content: string,
  filePath: string,
  sessionDir: string,
  ticketId: string,
  workingDir: string,
  priorStatus: string,
): PhantomDoneInspectResult {
  // Explicit completion_commit field: keep without any git probe (path-7 invariant).
  if (readFrontmatterField(content, 'completion_commit')) {
    return { changed: false, reason: 'has_completion_commit' };
  }

  // R-AFCC-DEEP-4A: delegate to gateForPhantomDoneRevert.
  const ctx: EvidenceCtx = { sessionDir, ticketId, ticketPath: filePath, workingDir };
  let decision: RevertDecision;
  try {
    decision = gateForPhantomDoneRevert(ctx);
  } catch (err) {
    return { changed: false, reason: 'unparseable', gitFailureReason: safeErrorMessage(err) };
  }

  switch (decision.action) {
    case 'keep':
      return { changed: false, reason: 'has_completion_commit' };
    case 'persist-inferred': {
      // completion_commit absent (checked above); upsert inferred field.
      const updated = upsertFrontmatterField(content, 'completion_commit_inferred', decision.sha ?? '');
      if (!updated) return { changed: false, reason: 'unparseable' };
      try { fs.writeFileSync(filePath, updated); } catch { return { changed: false, reason: 'unparseable' }; }
      return { changed: true, reason: 'backfilled', commit: decision.sha ?? undefined };
    }
    case 'revert': {
      const wrote = writeTicketStatus(sessionDir, ticketId, priorStatus);
      if (!wrote) return { changed: false, reason: 'unparseable' };
      return { changed: true, reason: 'reverted', priorStatus };
    }
  }
}

/**
 * R-ICP-5 / R-AFCC-DEEP-3B: Inspect a single linear_ticket_*.md file using the
 * explicit PhantomDoneKind decision matrix (via applyInspectPhantomDoneDecision).
 *
 * `priorStatus` defaults to 'Todo' but the watcher caller passes the last
 * known good status. Pure side-effect on the ticket file plus a structured result
 * — caller owns activity-event + stderr log writes.
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
  const ticketId = readFrontmatterField(content, 'id');
  if (!ticketId) {
    return { changed: false, reason: 'missing_id' };
  }
  return applyInspectPhantomDoneDecision(content, filePath, sessionDir, ticketId, workingDir, priorStatus);
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
  sessionDir: string,
): State {
  const hasTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0;
  if (!hasTicket) {
    // Clear-on-null: stale per-ticket cache left over from a completed ticket.
    if (!hasStalePerTicketCacheFields(state)) return state;
    log('clearing stale per-ticket cache fields (current_ticket=null)');
    return sm.update(statePath, s => {
      clearStaleTicketCacheFields(s);
    });
  }
  // AC-R-WMNP-2: a SET current_ticket whose per-ticket cap cache is missing or
  // invalid MUST be REPOPULATED from the ticket's complexity tier — not left
  // perpetually skipped. Without this, the per-ticket cap-check at runMuxLoop is
  // skipped every iteration and nothing bounds a wedged respawn loop (the
  // `cap-check skipped: stale cache (... max_iter=undefined ...)` incident).
  if (!isValidPerTicketCapCache(state)) {
    log(`repopulating per-ticket cap cache from ticket tier (current_ticket=${state.current_ticket})`);
    return sm.update(statePath, s => {
      clearStaleTicketCacheFields(s);
      applyTicketTierBudget(s, sessionDir);
    });
  }
  return state;
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

/** Returns true when headSha is the same as refSha or is an ancestor of refSha (HEAD regressed). */
function isHeadAtOrBelowCommit(headSha: string, refSha: string, workingDir: string): boolean {
  if (headSha === refSha) return true;
  const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', headSha, refSha], { encoding: 'utf-8', timeout: 5000 });
  return r.status === 0;
}

/**
 * Returns dangling commit SHAs from `git fsck --no-reflogs --lost-found`.
 * Only chain tips are reported dangling (interior commits stay reachable from
 * the descendant that points at them). `--no-reflogs` is REQUIRED — without it a
 * reset-orphaned commit stays reflog-reachable and is never reported dangling.
 */
function resolveFsckDanglingTips(workingDir: string): string[] {
  const out = silentDeathGit(['fsck', '--no-reflogs', '--lost-found'], workingDir);
  if (!out) return [];
  return out.split('\n')
    .filter((l) => l.startsWith('dangling commit '))
    .map((l) => l.slice('dangling commit '.length).trim())
    .filter(Boolean);
}

/**
 * Resolve the TIP of the orphaned chain that `candidate` belongs to:
 *   - candidate is its own tip when no fsck tip has it as an ancestor (single-commit orphan)
 *   - exactly one dangling tip with `candidate` as an ancestor → that tip
 *   - >1 such tips → 'ambiguous' (operator must resolve; runner holds)
 */
function resolveChainTip(candidate: string, tips: string[], workingDir: string): string | 'ambiguous' {
  const matching = tips.filter((tip) => {
    if (tip === candidate) return true;
    const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', candidate, tip], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0;
  });
  if (matching.length === 0) return candidate; // single-commit orphan: candidate IS the tip
  if (matching.length === 1) return matching[0];
  return 'ambiguous'; // >1 tips contain candidate as ancestor → operator territory
}

/**
 * SHA precedence for orphan tip resolution:
 *   1. Explicit completionCommitSha (authoritative, never window/scope-filtered)
 *   2. `git fsck --no-reflogs` discovery scoped to the iteration window + allowed_paths
 *
 * Returns `{ sha, discovered }` or null when nothing recoverable is found.
 */
function resolveOrphanSha(input: {
  completionCommitSha: string | null;
  workingDir: string;
  sessionDir: string;
  iterationStartMs: number | null | undefined;
  log: (msg: string) => void;
}): { sha: string; discovered: boolean } | null {
  const { completionCommitSha, workingDir, sessionDir, iterationStartMs, log } = input;
  const SKEW_MS = 30_000; // ±30s clock-skew tolerance for fsck discovery

  // Priority 1: explicit SHA — never window/scope-filtered.
  if (completionCommitSha) return { sha: completionCommitSha, discovered: false };

  // Priority 2: fsck discovery — only when no explicit SHA.
  const tips = resolveFsckDanglingTips(workingDir);
  if (tips.length === 0) return null;

  const allowed = readScopeAllowedPaths(sessionDir);
  const nowMs = Date.now();

  const filtered = tips.filter((tip) => {
    // Window filter: commit timestamp within [iterationStartMs - skew, now + skew].
    if (iterationStartMs !== null && iterationStartMs !== undefined) {
      const epochSec = gitCommitEpoch(workingDir, tip);
      if (epochSec !== null) {
        const commitMs = epochSec * 1000;
        if (commitMs < iterationStartMs - SKEW_MS || commitMs > nowMs + SKEW_MS) {
          log(`[head-regression] fsck tip ${tip.slice(0, 8)} outside iteration window — skipping`);
          return false;
        }
      }
    }
    // Scope filter: touched paths ⊆ allowed_paths (unscoped session → all pass).
    if (allowed && allowed.length > 0) {
      const diff = silentDeathGit(['diff', '--name-only', `HEAD..${tip}`], workingDir);
      if (diff === null) return false;
      const touched = diff.split('\n').map((s) => s.trim()).filter(Boolean);
      if (touched.some((f) => !isWithinAllowedPaths(f, allowed))) {
        log(`[head-regression] fsck tip ${tip.slice(0, 8)} touches out-of-scope paths — skipping`);
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) return null;
  if (filtered.length === 1) return { sha: filtered[0], discovered: true };

  // Multiple in-window tips: prefer the most recent commit time.
  const ranked = filtered
    .map((tip) => ({ tip, epoch: gitCommitEpoch(workingDir, tip) ?? 0 }))
    .sort((a, b) => b.epoch - a.epoch);
  log(`[head-regression] multiple fsck tips found, using most recent: ${ranked[0].tip.slice(0, 8)}`);
  return { sha: ranked[0].tip, discovered: true };
}

/**
 * e56ed23f: resolve an orphan SHA (explicit → fsck-discovered), walk to the
 * chain TIP, and `git merge --ff-only` HEAD up to it. Pure reattach — NEVER
 * resets or rewrites history; an ambiguous chain or a divergent HEAD (ff-only
 * refusal) returns `recovered: false` and the caller routes to the hold path.
 * `candidateSha` is the reattached tip on success, or the best-known unverified
 * candidate otherwise (drives the `orphan_commit_unreattachable` emit), `null`
 * when nothing was discoverable.
 */
function attemptOrphanChainReattach(input: {
  ticketId: string;
  workingDir: string;
  sessionDir: string;
  statePath: string;
  completionCommitSha: string | null;
  prevHead: string;
  iterationStartMs: number | null | undefined;
  log: (msg: string) => void;
}): { recovered: boolean; candidateSha: string | null } {
  const { ticketId, workingDir, sessionDir, statePath, completionCommitSha, prevHead, iterationStartMs, log } = input;
  const resolved = resolveOrphanSha({ completionCommitSha, workingDir, sessionDir, iterationStartMs, log });
  if (!resolved) return { recovered: false, candidateSha: null };

  const verifyR = spawnSync('git', ['-C', workingDir, 'cat-file', '-t', resolved.sha], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (verifyR.status !== 0 || ((verifyR.stdout as string) || '').trim() !== 'commit') {
    log(`[head-regression] resolved orphan SHA ${resolved.sha.slice(0, 8)} not accessible as commit — holding`);
    return { recovered: false, candidateSha: resolved.sha };
  }

  // The candidate may be an interior commit of a multi-commit orphan chain;
  // resolve the descendant-most tip so ff-only lands HEAD at the chain TIP.
  const tip = resolveChainTip(resolved.sha, resolveFsckDanglingTips(workingDir), workingDir);
  if (tip === 'ambiguous') {
    log(`[head-regression] ambiguous orphan chain (multiple dangling tips contain ${resolved.sha.slice(0, 8)}) — holding for operator`);
    return { recovered: false, candidateSha: resolved.sha };
  }

  // Archive a dirty tree BEFORE ff-only (self-no-ops on a clean tree). ff-only
  // refuses a dirty tree, so a still-dirty tree after archive falls to the hold.
  archiveDirtyTreeBeforeFlip({ workingDir, sessionDir, ticketId, log });
  const statusR = spawnSync('git', ['-C', workingDir, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (statusR.status === 0 && ((statusR.stdout as string) || '').trim().length > 0) {
    log(`[head-regression] working tree still dirty after archive — cannot ff-only to ${tip.slice(0, 8)}; holding`);
    return { recovered: false, candidateSha: tip };
  }

  const chainLenR = spawnSync('git', ['-C', workingDir, 'rev-list', '--count', `${prevHead}..${tip}`], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const chainLength = chainLenR.status === 0 ? (parseInt(((chainLenR.stdout as string) || '').trim(), 10) || 1) : 1;
  const mergeR = spawnSync('git', ['-C', workingDir, 'merge', '--ff-only', tip], { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (mergeR.status !== 0) {
    // ff-only refused → divergent HEAD. NEVER reset/rewrite — hold.
    log(`[head-regression] ff-only to ${tip.slice(0, 8)} failed (divergent HEAD): ${((mergeR.stderr as string) || '').trim()} — holding`);
    return { recovered: false, candidateSha: tip };
  }

  log(`[head-regression] ff-only reattach to chain tip ${tip.slice(0, 8)} succeeded (chain_length=${chainLength})`);
  try {
    const reattachPayload: OrphanReattachPayload = { ticket: ticketId, sha: tip, prev_head: prevHead, chain_length: chainLength, ts: new Date().toISOString() };
    writeActivityEntry(statePath, { event: 'orphan_commit_reattached', ...reattachPayload });
  } catch { /* best-effort telemetry */ }
  return { recovered: true, candidateSha: tip };
}

/**
 * R-CXOR-1 / e56ed23f: detect and recover from a worker HEAD regression.
 *
 * A codex worker may commit real work then `git reset --hard` to the pre-ticket
 * baseline on gate failure, leaving the ticket frontmatter Done but HEAD frozen.
 * This function detects that case and resolves the orphan chain TIP via:
 *   1. Ticket frontmatter completion_commit (authoritative, not window-filtered)
 *   2. `git fsck --no-reflogs` discovery scoped to the iteration window + allowed_paths
 * Then `git merge --ff-only` reattaches HEAD to the chain tip. On divergence or
 * ambiguity it emits `orphan_commit_unreattachable` and routes through the
 * 7eb9fa20 hold path (operator-hold) — it NEVER rewrites history (no `git reset`,
 * no `--force`). The hold path SUPPRESSES the Failed flip whenever there is
 * salvage evidence (fresh artifacts or a ticket-scoped commit) → `flip_suppressed`
 * / `suppression_cap_escalate`; only an evidence-absent, undiscoverable orphan
 * falls through to `marked_failed` (a non-destructive frontmatter write).
 * Success → `orphan_commit_reattached` with chain_length.
 * Divergent/ambiguous/undiscovered → `orphan_commit_unreattachable`, then hold.
 */
export function detectAndRecoverHeadRegression(input: {
  ticketId: string;
  workingDir: string;
  startCommit: string;
  completionCommitSha: string | null;
  sessionDir: string;
  statePath: string;
  iteration: number;
  /** 7eb9fa20: epoch ms when the iteration began — opens the artifact-evidence window for flip suppression. */
  iterationStartMs?: number | null;
  log: (msg: string) => void;
}): { detected: boolean; recovered: boolean; action: 'ff_reattached' | 'marked_failed' | 'flip_suppressed' | 'suppression_cap_escalate' | 'none' } {
  const { ticketId, workingDir, startCommit, completionCommitSha, sessionDir, statePath, iteration, log } = input;
  const currentHead = readHeadCommit(workingDir);
  if (!currentHead) return { detected: false, recovered: false, action: 'none' };
  if (!isHeadAtOrBelowCommit(currentHead, startCommit, workingDir)) {
    return { detected: false, recovered: false, action: 'none' };
  }

  log(`[head-regression] ticket ${ticketId} iter=${iteration}: HEAD=${currentHead} at/below start_commit=${startCommit}`);

  // The regressed HEAD before any recovery — base for chain_length and the
  // prev_head field of both orphan events.
  const prevHead = currentHead;

  let action: 'ff_reattached' | 'marked_failed' | 'flip_suppressed' | 'suppression_cap_escalate' = 'marked_failed';

  // --- e56ed23f: SHA precedence + chain-tip resolution + ff-only reattach ---
  const reattach = attemptOrphanChainReattach({ ticketId, workingDir, sessionDir, statePath, completionCommitSha, prevHead, iterationStartMs: input.iterationStartMs, log });
  const recovered = reattach.recovered;
  // Best-known SHA (reattached tip or unverifiable candidate) for telemetry.
  const candidateSha = reattach.candidateSha;
  if (recovered) action = 'ff_reattached';

  // Divergent / ambiguous / undiscovered non-reattach with a known candidate →
  // emit orphan_commit_unreattachable BEFORE routing to the hold path.
  if (!recovered && candidateSha) {
    try {
      writeActivityEntry(statePath, {
        event: 'orphan_commit_unreattachable',
        ts: new Date().toISOString(),
        ticket: ticketId,
        sha: candidateSha,
        prev_head: prevHead,
        reason: 'divergent_or_ambiguous',
      });
    } catch { /* best-effort telemetry */ }
  }

  if (!recovered) {
    // 7eb9fa20: evidence-backed flip-intents are suppressed (held) instead of
    // flipped — an unreattachable-but-real orphan commit is salvageable work,
    // not a failure. Evidence absent → archive a dirty tree, then flip.
    const decision = evaluateFailedFlipSuppression({
      sessionDir,
      statePath,
      ticketId,
      workingDir,
      iteration,
      callsite: 'head_regression',
      windowStartMs: input.iterationStartMs ?? null,
      windowEndMs: Date.now(),
      preSha: startCommit,
      log,
    });
    if (decision.action === 'suppress') {
      action = 'flip_suppressed';
      log(`[head-regression] ticket ${ticketId} Failed flip suppressed (${decision.evidence}) — status preserved, ticket held`);
    } else if (decision.action === 'escalate') {
      action = 'suppression_cap_escalate';
      log(`[head-regression] ticket ${ticketId} suppression cap ${decision.cap} reached — escalating to no-progress halt (no flip)`);
    } else {
      archiveDirtyTreeBeforeFlip({ workingDir, sessionDir, ticketId, log });
      try {
        updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
        log(`[head-regression] ticket ${ticketId} marked Failed — HEAD at baseline, orphan unrecoverable`);
      } catch (err) {
        log(`[head-regression] ticket Failed flip error: ${safeErrorMessage(err)}`);
      }
    }
  }

  try {
    writeActivityEntry(statePath, {
      event: 'worker_head_regression_detected',
      ts: new Date().toISOString(),
      ticket: ticketId,
      session: path.basename(sessionDir),
      gate_payload: {
        start_commit: startCommit,
        current_head_sha: currentHead,
        orphan_tip_sha: candidateSha ?? completionCommitSha,
        action,
      },
    });
  } catch { /* best-effort */ }

  return { detected: true, recovered, action };
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
  // R-AFCC-DEEP-4A: readEvidence replaces hasCompletionCommit. 'absent' covers
  // the legacy 'unreachable' case (explicit SHA present but not git-reachable).
  const evidence = readEvidence({
    sessionDir,
    ticketId,
    workingDir,
    startTimeEpoch: gitCommitEpoch(workingDir, startCommit),
  });
  if (evidence.kind === 'absent') {
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
    // Manager drift path: ticket starts 'In Progress', so the guard's inline
    // upsert (which requires status=Done) cannot run yet.
    // Allow inferred evidence here; the post-markTicketDone upsert runs below.
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
    // time so the inline upsert inside guardCompletionCommitBeforeDone couldn't
    // write completion_commit (requires status=Done).
    // Now that markTicketDone has flipped the status, persist the SHA.
    // Best-effort: failure must not block the Done flip.
    try {
      const _fp = ticketFilePath(input.sessionDir, input.ticketId);
      const _raw = fs.readFileSync(_fp, 'utf8');
      if (!readFrontmatterField(_raw, 'completion_commit') && guard.sha) {
        const _upd = upsertFrontmatterField(_raw, 'completion_commit', guard.sha);
        if (_upd) fs.writeFileSync(_fp, _upd);
      }
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

export function detectManagerInactiveExit(outcome: IterationOutcome | undefined): boolean {
  return (
    outcome !== undefined &&
    outcome.completion === 'inactive' &&
    outcome.timedOut === false &&
    outcome.exitCode === null
  );
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
  if (backend === 'codex' && detectManagerInactiveExit(outcome)) {
    return 'codex_session_inactive';
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

  const templateName = resolveCommandTemplate(state.command_template);
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
    ...(invocation.env ?? {}),
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
    let heartbeat: NodeJS.Timeout | null = null;

    function clearIterationGuards() {
      clearTimeout(hangGuard);
      if (outputStallGuard) {
        clearTimeout(outputStallGuard);
        outputStallGuard = null;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
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

    {
      let heartbeatLastSeenMtimeMs = 0;
      heartbeat = setInterval(() => {
        try {
          heartbeatLastSeenMtimeMs = maybeEmitManagerTurnProgress({
            sessionDir,
            statePath,
            ticketId: state.current_ticket,
            lastSeenMtimeMs: heartbeatLastSeenMtimeMs,
          });
        } catch { /* best effort — never crash the manager turn */ }
      }, MANAGER_TURN_HEARTBEAT_POLL_MS);
      heartbeat.unref();
    }

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

    // R-MWIS-1: shared finalize body, reachable from BOTH the legacy stdio
    // 'close' handler AND the PRIMARY 'exit' observer below. The `settled` guard
    // (single-resolution invariant) means whichever fires first wins; the other
    // short-circuits. Extracting this keeps the resolution logic single-sourced
    // so the exit-driven path cannot drift from the close-driven path.
    // eslint-disable-next-line complexity -- HT-1 reviewed: R-OMS-1 clearActivePidFile adds one branch to the resolution finalize (R-APMW-6 ordering preserved); behavior-preserving, surrounding-flow refactor deferred to a focused PR.
    function finalizeOnChildEnd(code: number | null) {
      if (settled) return;
      settled = true;
      currentChildProc = null;
      try { clearActivePidFile(sessionDir); } catch { /* best effort */ }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
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
    }

    proc.on('close', (code) => finalizeOnChildEnd(code));

    // R-MWIS-1: process exit is the PRIMARY worker-completion signal — observed
    // directly via 'exit', INDEPENDENT of stdio-pipe closure, log bytes, or any
    // promise/completion token. A silent 0-byte worker exit whose stdio 'close'
    // lags (render-lag / inherited fd) no longer hangs the loop at 0% CPU: the
    // 'exit' event fires on child termination and, after a bounded stdio-drain
    // window, finalizes the outcome. If 'close' fires first (the common case,
    // when the child flushed output), `settled` short-circuits this path so no
    // double-resolution and no log truncation occurs.
    proc.on('exit', (code) => {
      if (settled) return;
      const drainTimer = setTimeout(() => {
        if (settled) return;
        finalizeOnChildEnd(code ?? null);
      }, EXIT_DRAIN_FALLBACK_MS);
      drainTimer.unref();
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

/**
 * R-MWIS-2 main-loop idle-stall watchdog (the loop-level complement to T1's
 * worker-exit signal). Pure, clock-injectable decision: given the current
 * last-progress timestamp and the existing wait-state predicates, decide whether
 * the mux main loop is wedged with no in-flight progress while NOT in any
 * legitimate wait state. Callers gate the watchdog with the SAME predicates the
 * loop already computes (rate-limit wait, circuit breaker executable, `last_error`,
 * and accumulated subprocess errors via `last_subprocess_error`) so legitimate
 * waits never trip.
 */
export interface MuxIdleStallWatchdogInput {
  /** state.active — only an active session can be idle-stalled. */
  active: boolean;
  /** Current clock (ms). Injectable for tests; production passes Date.now(). */
  nowMs: number;
  /** Epoch (ms) of the last observed forward progress (iteration advance / worker spawn / state write). */
  lastProgressMs: number;
  /** Bounded idle threshold in seconds (PICKLE_MUX_IDLE_STALL_SECONDS override). */
  thresholdSeconds: number;
  /** True when a rate_limit_wait.json artifact is present (legitimate API wait). */
  rateLimitWaiting: boolean;
  /** canExecute(circuitBreaker) — false means the breaker is OPEN/recovering. */
  circuitBreakerExecutable: boolean;
  /** state.last_error snapshot — non-null means the last iteration errored. */
  lastError: unknown;
  /**
   * Accumulated worker subprocess errors — > 0 means worker errors are present and
   * the loop is legitimately in an error/recovery state, not idle. In the mux loop
   * this is derived from `state.last_subprocess_error` presence (1 when set).
   */
  consecutiveSubprocessErrors: number;
}

export type MuxIdleStallReason =
  | 'idle_no_progress'
  | 'inactive'
  | 'in_wait_state'
  | 'within_threshold';

export interface MuxIdleStallWatchdogDecision {
  stalled: boolean;
  idleSeconds: number;
  reason: MuxIdleStallReason;
}

export function evaluateMuxIdleStallWatchdog(input: MuxIdleStallWatchdogInput): MuxIdleStallWatchdogDecision {
  const idleSeconds = Math.max(0, Math.floor((input.nowMs - input.lastProgressMs) / 1000));
  if (!input.active) {
    return { stalled: false, idleSeconds, reason: 'inactive' };
  }
  // Reuse the existing wait-state predicates as the gate: a legitimate wait is
  // never an idle stall.
  if (
    input.rateLimitWaiting ||
    !input.circuitBreakerExecutable ||
    input.lastError != null ||
    input.consecutiveSubprocessErrors > 0
  ) {
    return { stalled: false, idleSeconds, reason: 'in_wait_state' };
  }
  if (idleSeconds >= input.thresholdSeconds) {
    return { stalled: true, idleSeconds, reason: 'idle_no_progress' };
  }
  return { stalled: false, idleSeconds, reason: 'within_threshold' };
}

/**
 * Resolve the idle-stall threshold (seconds). Honors PICKLE_MUX_IDLE_STALL_SECONDS
 * (strict positive integer); falls back to the default when unset/invalid. Mirrors
 * the commit-pending-probe threshold parse convention.
 */
export function resolveIdleStallThresholdSeconds(): number {
  const raw = Number(process.env.PICKLE_MUX_IDLE_STALL_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MUX_IDLE_STALL_SECONDS;
}

const DEFAULT_MUX_IDLE_STALL_SECONDS = 900;

/** L2 default consecutive idle-stall self-recovery cap before escalation. */
const DEFAULT_MUX_IDLE_STALL_RECOVERY_CAP = 3;

/**
 * L2: resolve the consecutive idle-stall recovery cap. Honors
 * PICKLE_MUX_IDLE_STALL_RECOVERY_CAP (strict positive integer); falls back to the
 * default when unset/invalid. Mirrors resolveIdleStallThresholdSeconds.
 */
export function resolveIdleStallRecoveryCap(): number {
  const raw = Number(process.env.PICKLE_MUX_IDLE_STALL_RECOVERY_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MUX_IDLE_STALL_RECOVERY_CAP;
}

/**
 * L2: decide whether a consecutive idle-stall recovery streak has EXCEEDED the cap
 * and must escalate (record idle_stall_unrecoverable + deactivate). The watchdog
 * self-recovery is bounded so a genuinely wedged loop that re-arms the stall every
 * pass cannot spin forever — `recoveryCount` is the count of recoveries attempted
 * THIS streak (including the current one); escalate once it climbs past `cap`.
 * Any real forward progress resets the streak to 0, so a transient stall that the
 * recovery clears never escalates.
 */
export function evaluateIdleStallRecoveryCap(recoveryCount: number, cap: number): boolean {
  return recoveryCount > cap;
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

export type ExitReason = 'success' | 'cancelled' | 'error' | 'limit' | 'iteration_cap_exhausted' | 'stall' | 'circuit_open' | 'rate_limit_exhausted' | 'timeout_repeat' | 'manager_persistent_hallucination' | 'codex_unhealthy_consecutive_failures' | 'ticket_audit_failed' | 'working_tree_modified_externally' | 'state_schema_version_ahead' | 'closer_handoff_terminal' | 'manager_handoff_pending' | 'done_without_commit_evidence' | 'codex_manager_no_progress' | 'recovery_exhausted' | 'idle_stall_unrecoverable' | 'all_tickets_terminal' | 'state_working_dir_missing';

/** R-CNAR-4(c): halt exits pause/defer — auto-resume.sh may retry. Does NOT include 'recovery_exhausted' (fatal, non-recoverable). */
export const isHaltExit = (r: ExitReason): boolean => r === 'cancelled' || r === 'limit' || r === 'timeout_repeat' || r === 'closer_handoff_terminal' || r === 'manager_handoff_pending' || r === 'done_without_commit_evidence';
/** R-CNAR-4(c): failure exits stop auto-resume.sh. Includes 'recovery_exhausted' — a non-recoverable terminal state. */
const FAILURE_EXIT_REASONS: ReadonlySet<ExitReason> = new Set<ExitReason>([
  'error', 'stall', 'circuit_open', 'rate_limit_exhausted', 'timeout_repeat',
  'manager_persistent_hallucination', 'iteration_cap_exhausted', 'codex_unhealthy_consecutive_failures',
  'ticket_audit_failed', 'working_tree_modified_externally', 'state_schema_version_ahead',
  'done_without_commit_evidence', 'codex_manager_no_progress', 'recovery_exhausted',
  'idle_stall_unrecoverable', 'state_working_dir_missing',
]);
export const isFailureExit = (r: ExitReason): boolean => FAILURE_EXIT_REASONS.has(r);

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
  | { action: 'exit'; reason: Extract<ExitReason, 'closer_handoff_terminal' | 'manager_handoff_pending' | 'recovery_exhausted'>; tracker: CloserHandoffTracker | null; detail: string };

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

/** Map a four-state EvidenceKind back to the legacy CompletionCommitEvidence source for error callers. */
function mapEvidenceKindToLegacySource(kind: string): CompletionCommitEvidence['source'] {
  if (kind === 'explicit') return 'explicit-reachable';
  if (kind === 'inferred-fresh' || kind === 'inferred-stale') return 'inferred';
  return 'absent';
}

export function guardCompletionCommitBeforeDone(args: {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  flags?: Record<string, unknown> | null;
  /** R-CCGR: backoff (ms) before the single re-read; pass 0 in test fixtures. */
  rereadBackoffMs?: number;
}): { ok: true; sha: string } | { ok: false; reason: string; source: CompletionCommitEvidence['source'] } {
  // R-WSRC-4 parity: PICKLE_TEST_MODE=1 bypasses for sandboxed test fixtures
  // whose workingDir is a synthetic temp dir without a real git repo.
  // Production sessions never set this env var; production guard is intact.
  if (process.env.PICKLE_TEST_MODE === '1') {
    return { ok: true, sha: 'pickle-test-mode-bypass' };
  }
  const allowInferred = (args.flags ?? {})['allow_inferred_completion_commit'] === true;
  const probe: EvidenceCtx = {
    sessionDir: args.sessionDir,
    ticketId: args.ticketId,
    workingDir: args.workingDir,
  };
  // R-AFCC-DEEP-4A: use readEvidence (replaces hasCompletionCommit).
  const evidenceAccepted = (r: { kind: string; sha?: string | null }): boolean =>
    (r.kind === 'explicit' && !!r.sha) || (allowInferred && !!r.sha);
  let evidenceR = readEvidence(probe);
  if (!evidenceAccepted(evidenceR)) {
    // R-CCGR: the worker commits + stamps `completion_commit`, then emits its
    // done-promise; mux-runner can read this guard before that frontmatter
    // write is durably visible. Re-read once after a short backoff so a
    // genuinely-complete ticket is not FATAL'd on a flush race.
    sleepSyncMs(args.rereadBackoffMs ?? guardRereadBackoffMs());
    evidenceR = readEvidence(probe);
  }
  // R-WUWC SOFT-variant: inferred-fresh — auto-promote to explicit by writing
  // the SHA into ticket frontmatter via persistEvidence, then re-probe.
  // This is the runtime equivalent of the operator workaround:
  // `edit ticket frontmatter to include completion_commit: <sha>`.
  if (evidenceR.kind === 'inferred-fresh' && evidenceR.sha) {
    try {
      const result = persistEvidence(probe, evidenceR.sha, { stage: 'best-effort' });
      if (result.action === 'written') {
        evidenceR = readEvidence(probe);
      }
    } catch { /* best-effort — fall through to existing classification */ }
  }
  if (evidenceR.kind === 'explicit' && evidenceR.sha) {
    return { ok: true, sha: evidenceR.sha };
  }
  if (allowInferred && evidenceR.sha) {
    // Operator bypass — proceed but record the kind for audit.
    return { ok: true, sha: evidenceR.sha };
  }
  // Map EvidenceKind back to legacy source for callers that inspect the error.
  const legacySource = mapEvidenceKindToLegacySource(evidenceR.kind);
  return {
    ok: false,
    source: legacySource,
    reason: `ticket ${args.ticketId} cannot flip Done: readEvidence().kind === '${evidenceR.kind}' (expected 'explicit'); ` +
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
  // Explicit no-handoff phrasings ("No `[manager]` criteria in this ticket",
  // "No manager items", "No handoff needed") are boilerplate, not a deferred item.
  // Workers write the `## Manager Handoff` header unconditionally; only a real
  // deferred item is a halt trigger. Bounded to the first clause ([^.\n]{0,40}) so a
  // genuine handoff that merely happens to start with "No" cannot be misclassified.
  if (/^no\b[^.\n]{0,40}\b(manager|criteria|handoff|items?|deferred)\b/i.test(firstNonEmptyLine)) return false;
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
// R-ORSR-2 — RecoveryController runtime adapters
//
// The controller (services/recovery-controller.ts) is dependency-injected; these
// adapters bind its callbacks to the real runtime. `attemptRecoveryBeforeTerminal`
// is wired at THREE terminal authorities — (1) closer_handoff_terminal,
// (2) codex manager-no-progress, and (3) wmw-auto-skip (oversized_no_progress) —
// so a stalled iteration runs the recovery ladder before parking. (Keep this
// count in sync with the three call sites; see mux-runner-fix-b.test.js L6.)
// `commitAndContinueDoneFlip` is the 7th `guardCompletionCommitBeforeDone`
// + `clearStaleDoneWithoutCommitEvidence` pair (R-PEDC parity 6→7).
// ---------------------------------------------------------------------------

export interface CommitAndContinueDoneFlipInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  statePath: string;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
  /**
   * Optional ownership-scoped staging (M1). When provided (non-empty), `git add`
   * stages ONLY these repo-relative paths instead of the whole tree (`-A`), so a
   * shared-dir exit-path commit cannot sweep a sibling ticket's dirty work into a
   * commit attributed to `ticketId`. Absent → default whole-tree `git add -A`
   * (the Done-flip path semantics are unchanged).
   */
  stagePaths?: readonly string[];
}

/**
 * Rung-1 committer: stage the dirty tree, commit referencing the ticket id, then
 * flip the ticket Done through the R-PEDC guard/clear pair (the 7th such pair in
 * this file). Atomic by construction — a failed `git commit` (e.g. refused by the
 * R-WSRC config-protection hook) returns `{ ok: false }` with nothing flipped, so
 * the ladder falls through to fix-forward-trivial rather than leaving a half-commit.
 */

function muxRealpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** R-WSRC-4: assert workingDir resolves under os.tmpdir() when PICKLE_TEST_MODE=1. No-op in production. */
function assertWorkingDirUnderTmpdirIfTestMode(workingDir: string): void {
  if (process.env.PICKLE_TEST_MODE !== '1') return;
  const tmpdirRealpath = muxRealpathOrSelf(os.tmpdir());
  const resolved = muxRealpathOrSelf(workingDir);
  const under = resolved === tmpdirRealpath || resolved.startsWith(tmpdirRealpath + path.sep);
  if (!under) throw new Error(
    `R-WSRC-4: PICKLE_TEST_MODE=1 but workingDir is outside os.tmpdir() (${tmpdirRealpath}): ${workingDir}. ` +
    `Test fixtures must root working_dir under os.tmpdir() to prevent git mutations against the real repo.`,
  );
}

export function commitAndContinueDoneFlip(input: CommitAndContinueDoneFlipInput): { ok: boolean; sha?: string } {
  assertWorkingDirUnderTmpdirIfTestMode(input.workingDir);
  // M1: ownership-scoped staging when stagePaths is provided (exit-path commit);
  // otherwise the default whole-tree add (Done-flip path, unchanged).
  const addArgs = input.stagePaths && input.stagePaths.length > 0
    ? ['-C', input.workingDir, 'add', '--', ...input.stagePaths]
    : ['-C', input.workingDir, 'add', '-A'];
  const add = spawnSync('git', addArgs, { encoding: 'utf-8', timeout: 30000 });
  if (add.status !== 0) {
    input.log(`commit-and-continue: git add failed for ${input.ticketId} (status ${add.status ?? 'null'})`);
    return { ok: false };
  }
  const commitMsg = `fix(${input.ticketId}): commit-and-continue recovery (R-ORSR-2)`;
  const commit = spawnSync('git', ['-C', input.workingDir, 'commit', '-m', commitMsg], { encoding: 'utf-8', timeout: 30000 });
  if (commit.status !== 0) {
    input.log(`commit-and-continue: git commit blocked/failed for ${input.ticketId} (status ${commit.status ?? 'null'})`);
    return { ok: false };
  }
  const guard = guardCompletionCommitBeforeDone({
    sessionDir: input.sessionDir,
    ticketId: input.ticketId,
    workingDir: input.workingDir,
    // The recovery commit references the ticket id (inferred-fresh evidence); the
    // ticket is not yet Done so allow inferred, then persist below post-flip.
    flags: { ...(input.flags ?? {}), allow_inferred_completion_commit: true },
  });
  if (!guard.ok) {
    return { ok: false };
  }
  clearStaleDoneWithoutCommitEvidence(input.statePath);
  if (markTicketDone(input.sessionDir, input.ticketId)) {
    input.log(`commit-and-continue: marked ${input.ticketId} Done (completion_commit: ${guard.sha})`);
  }
  // Persist completion_commit now that status is Done (mirrors applyAutoTicketCompletionValidation).
  try {
    const fp = ticketFilePath(input.sessionDir, input.ticketId);
    const raw = fs.readFileSync(fp, 'utf8');
    if (!readFrontmatterField(raw, 'completion_commit') && guard.sha) {
      const upd = upsertFrontmatterField(raw, 'completion_commit', guard.sha);
      if (upd) fs.writeFileSync(fp, upd);
    }
  } catch { /* best-effort — guard already proved evidence */ }
  return { ok: true, sha: guard.sha };
}

// ---------------------------------------------------------------------------
// R-MWIS-3 — commit a gate-passing uncommitted deliverable on the worker-exit /
// idle-stall recovery path.
//
// This is a WIRING module: it REUSES the existing #99 R-WCUC commit-before-failing
// behavior — the armed gate `runBetweenTicketFastTests` (only-passing, ignores
// skip-flags) plus the committer `commitAndContinueDoneFlip` (git add/commit +
// R-PEDC guard/clear + markTicketDone). It does NOT reimplement the gate or the
// commit. A silent (0-byte) worker exit or an idle-stall self-recovery that leaves
// a gate-passing deliverable in the tree no longer strands that work for manual
// recovery: it is committed before the loop advances / relaunches.
//
// Best-effort by construction: any throw → `{ committed:false, reason:'error' }`.
// Only gate-PASSING work is committed; gate-failing/clean/already-terminal cases
// are no-ops so the existing failure/skip/Done paths keep their behavior.
// ---------------------------------------------------------------------------

export interface CommitGatePassingDeliverableInput {
  sessionDir: string;
  statePath: string;
  workingDir: string;
  ticketId: string | null;
  extensionRoot: string;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
  /** Test seam: defaults to the production #99 gate `runBetweenTicketFastTests`. */
  runGate?: (extensionDir: string, extensionRoot: string) => BetweenTicketGateResult;
}

export type CommitGatePassingDeliverableReason =
  | 'no-ticket'
  | 'already-terminal'
  | 'clean-tree'
  | 'clean-ticket-tree'
  | 'no-extension-dir'
  | 'gate-failed'
  | 'committed'
  | 'commit-failed'
  | 'error';

/**
 * M1 (R-MWIS-3 / R-WCUC ownership pre-check): partition the working-tree dirty
 * paths into work OWNED by `ticketId` versus work that belongs to a DIFFERENT
 * ticket's session directory.
 *
 * The exit-path committer reuses `commitAndContinueDoneFlip`, whose `git add -A`
 * would otherwise stage the WHOLE dirty tree under `ticketId` — misattributing a
 * lagging sibling ticket's work when the session dir is shared (e.g. pickle-rick
 * self-build, where ticket artifacts under `<sessionDir>/<otherTicketId>/` are
 * tracked in the same repo).
 *
 * A dirty path is FOREIGN iff it resolves under `<sessionDir>/<otherTicketId>/`
 * for some ticket id other than `ticketId`; everything else (source deliverables,
 * the current ticket's own artifacts) is OWNED. This is deliberately conservative:
 * it never strands a source-file deliverable, it only refuses to commit work it
 * can positively attribute to another ticket.
 */
export function partitionExitPathDirtyByOwnership(
  dirtyPaths: readonly string[],
  workingDir: string,
  sessionDir: string,
  ticketId: string,
  allTicketIds: readonly string[],
): { owned: string[]; foreign: string[] } {
  // Absolute prefixes of OTHER tickets' session dirs (with trailing separator).
  const foreignPrefixes = allTicketIds
    .filter(id => id && id !== ticketId)
    .map(id => path.resolve(sessionDir, id) + path.sep);
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const rel of dirtyPaths) {
    const abs = path.resolve(workingDir, rel);
    if (foreignPrefixes.some(prefix => abs.startsWith(prefix))) {
      foreign.push(rel);
    } else {
      owned.push(rel);
    }
  }
  return { owned, foreign };
}

export interface CommitGatePassingDeliverableResult {
  committed: boolean;
  reason: CommitGatePassingDeliverableReason;
  sha?: string;
}

export function commitGatePassingDeliverableOnExitPath(
  input: CommitGatePassingDeliverableInput,
): CommitGatePassingDeliverableResult {
  const { sessionDir, statePath, workingDir, ticketId, extensionRoot, flags, log } = input;
  const gate = input.runGate ?? runBetweenTicketFastTests;
  try {
    if (!ticketId) return { committed: false, reason: 'no-ticket' };
    // The model-driven Done flip (worker self-attested) is handled by the existing
    // guardCompletionCommitBeforeDone callsite — don't double-commit it here.
    if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) {
      return { committed: false, reason: 'already-terminal' };
    }
    if (!isWorkingTreeDirty(workingDir)) return { committed: false, reason: 'clean-tree' };
    const extensionDir = path.join(workingDir, 'extension');
    if (!fs.existsSync(extensionDir)) return { committed: false, reason: 'no-extension-dir' };
    // M1: ownership pre-check. The shared committer would `git add -A` the whole
    // dirty tree under `ticketId`; on a shared working dir that misattributes a
    // lagging sibling ticket's work. Partition the dirty set and refuse to commit
    // when NOTHING is owned by this ticket; otherwise stage ONLY owned paths.
    let stagePaths: string[] | undefined;
    try {
      const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
      const allTicketIds = collectTickets(sessionDir).map(t => t.id).filter((id): id is string => Boolean(id));
      const { owned, foreign } = partitionExitPathDirtyByOwnership(dirtyPaths, workingDir, sessionDir, ticketId, allTicketIds);
      if (owned.length === 0) {
        log(`[exit-commit] ticket ${ticketId}: no ticket-owned dirty work (${foreign.length} foreign path(s)) — not committing under this ticket`);
        return { committed: false, reason: 'clean-ticket-tree' };
      }
      // Only scope staging when there IS foreign work to exclude; otherwise leave
      // stagePaths undefined so the committer keeps its whole-tree add behavior.
      if (foreign.length > 0) {
        stagePaths = owned;
        log(`[exit-commit] ticket ${ticketId}: staging ${owned.length} owned path(s), excluding ${foreign.length} foreign path(s)`);
      }
    } catch (err) {
      // Ownership probe is best-effort; on git error fall through to the existing
      // whole-tree behavior rather than stranding genuinely-owned work.
      log(`[exit-commit] ownership probe failed (ignored, falling back to whole-tree): ${safeErrorMessage(err)}`);
    }
    // REUSE the existing #99 armed gate — only commit gate-PASSING work.
    const gateResult = gate(extensionDir, extensionRoot);
    if (!gateResult.ok) {
      log(`[exit-commit] ticket ${ticketId}: gate not green — leaving uncommitted work for the failure/skip path`);
      return { committed: false, reason: 'gate-failed' };
    }
    // REUSE the existing #99 committer (git add/commit + R-PEDC guard + Done flip).
    const r = commitAndContinueDoneFlip({ sessionDir, ticketId, workingDir, statePath, flags, log, stagePaths });
    if (r.ok) {
      log(`[exit-commit] ticket ${ticketId}: committed gate-passing deliverable (completion_commit: ${r.sha})`);
      return { committed: true, reason: 'committed', sha: r.sha };
    }
    return { committed: false, reason: 'commit-failed' };
  } catch (err) {
    log(`[exit-commit] threw (ignored): ${safeErrorMessage(err)}`);
    return { committed: false, reason: 'error' };
  }
}

/** Probe the recovery evidence the runner already holds: tree state, plan artifacts, output. */
function assessRecoveryEvidence(sessionDir: string, workingDir: string, ticketId: string): RecoveryEvidence {
  let treeDirty = false;
  try { treeDirty = isWorkingTreeDirty(workingDir); } catch { /* non-repo / git error → treat as clean */ }
  let planArtifactExists = false;
  let planApproved = false;
  try {
    const entries = fs.readdirSync(path.join(sessionDir, ticketId));
    planArtifactExists = entries.some(f => /^plan_.*\.md$/.test(f));
    if (entries.includes('plan_review.md')) {
      const review = fs.readFileSync(path.join(sessionDir, ticketId, 'plan_review.md'), 'utf-8');
      planApproved = /\bAPPROVED\b/.test(review);
    }
  } catch { /* ticket dir unreadable → no plan evidence */ }
  return {
    treeDirty,
    planConvergedUncommitted: !treeDirty && isConvergedPlanEligible({ planArtifactExists, planReviewApproved: planApproved }),
    noWorkProduced: !treeDirty && !planArtifactExists,
  };
}

/**
 * fix-forward-trivial spawner: run the EXISTING gate remediator bin synchronously
 * (the same path finalize-gate uses), feeding it the armed gate's failures. Returns
 * true iff the remediator exited 0. Bounded to one invocation per ladder call by the
 * controller (INV-FIX-FORWARD-BOUND).
 */
function spawnRecoveryRemediator(
  input: AttemptRecoveryBeforeTerminalInput,
  gateFailures: BetweenTicketGateFailure[],
): boolean {
  try {
    const gateDir = path.join(input.sessionDir, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });
    const gateResultPath = path.join(gateDir, 'recovery_gate_result.json');
    const failures = gateFailures.map((f, i) => ({
      check: 'tests' as const,
      file: f.file || '',
      line: 0,
      ruleOrCode: '',
      message: f.name,
      severity: 'error' as const,
      occurrence_index: i,
    }));
    fs.writeFileSync(gateResultPath, JSON.stringify({
      status: 'red',
      failures,
      baseline_used: false,
      allowed_paths_used: false,
      elapsed_ms: 0,
      total_raw_failure_count: failures.length,
      new_failures_vs_baseline: failures.length,
    }), 'utf-8');
    const remediatorJs = path.join(input.extensionRoot, 'extension', 'bin', 'spawn-gate-remediator.js');
    const r = spawnSync(process.execPath, [
      remediatorJs,
      '--gate-result', gateResultPath,
      '--session-root', input.sessionDir,
      '--reason', 'per-iteration',
    ], { cwd: input.workingDir, encoding: 'utf-8', timeout: resolveWorkerTestGateTimeoutMs(input.extensionRoot) });
    return r.status === 0;
  } catch (err) {
    input.log(`fix-forward-trivial: remediator spawn failed for ${input.ticketId}: ${safeErrorMessage(err)}`);
    return false;
  }
}

export interface AttemptRecoveryBeforeTerminalInput {
  sessionDir: string;
  statePath: string;
  extensionRoot: string;
  workingDir: string;
  ticketId: string;
  iteration: number;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
}

/** R-ORSR-3 per-Phase verify-command budget (ms). Finite per subsystem invariant #3. */
const CONVERGED_PLAN_VERIFY_TIMEOUT_MS = 600_000;
/** R-ORSR-3 per-Phase git add/commit budget (ms). */
const CONVERGED_PLAN_GIT_TIMEOUT_MS = 30_000;

/**
 * R-ORSR-3 execute-converged-plan executor — the runtime adapter behind the
 * `RecoveryDeps.executeConvergedPlan` seam. Reads the approved plan from the ticket dir,
 * parses its authored Phases, and runs each Phase's verify command as one atomic commit
 * via `executePhaseLoop`. Partial failure (phase k fails) commits phases `0..k-1` and
 * returns `{ ok:false }` so the ladder records the failed attempt and falls through —
 * the ticket is never marked Done. A clean tree (the `planConvergedUncommitted` case)
 * has nothing to commit, so the per-Phase `git commit` fails and the rung honestly
 * reports `ok:false`; that is the documented down-scope, not a bug.
 */
function executeConvergedPlanAdapter(input: {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  log: (msg: string) => void;
}): { ok: boolean } {
  const ticketDir = path.join(input.sessionDir, input.ticketId);
  let phases: PlanPhase[];
  try {
    const planFile = fs.readdirSync(ticketDir)
      .filter(f => /^plan_.*\.md$/.test(f))
      .sort()
      .pop();
    if (!planFile) return { ok: false };
    phases = parsePlanPhases(fs.readFileSync(path.join(ticketDir, planFile), 'utf-8'));
  } catch { return { ok: false }; }
  if (phases.length === 0) return { ok: false };

  const result = executePhaseLoop({
    phases,
    executePhase: (phase) => {
      if (!phase.verify) return { ok: false };
      const r = spawnSync(phase.verify, {
        cwd: input.workingDir,
        shell: true,
        encoding: 'utf-8',
        timeout: CONVERGED_PLAN_VERIFY_TIMEOUT_MS,
      });
      return { ok: r.status === 0 };
    },
    commitPhase: (phase) => {
      const add = spawnSync('git', ['add', '-A'], {
        cwd: input.workingDir, encoding: 'utf-8', timeout: CONVERGED_PLAN_GIT_TIMEOUT_MS,
      });
      if (add.status !== 0) return { ok: false };
      const title = phase.title ? ` — ${phase.title}` : '';
      const commit = spawnSync('git', ['commit', '-m', `fix(${input.ticketId}): execute-converged-plan phase ${phase.index}${title}`], {
        cwd: input.workingDir, encoding: 'utf-8', timeout: CONVERGED_PLAN_GIT_TIMEOUT_MS,
      });
      return { ok: commit.status === 0 };
    },
  });

  const stoppedAt = result.failedIndex !== null ? ` (stopped at phase ${phases[result.failedIndex].index})` : '';
  input.log(`recovery: execute-converged-plan ran ${result.committed}/${phases.length} phase(s) for ${input.ticketId}${stoppedAt}`);
  return { ok: result.ok };
}

/**
 * Build the RecoveryDeps bound to the runtime and run the ladder. The ARMED gate is
 * `runBetweenTicketFastTests` — it runs the real whole-repo `test:fast` and ignores
 * `flags.skip_quality_gates_reason` by construction (never a skip-flagged green).
 * The execute-converged-plan executor (R-ORSR-3, e8f46d84) reads the approved plan and
 * runs each Phase as one atomic commit; on a clean converged tree it honestly reports
 * not-ok and the ladder falls through.
 */
export function attemptRecoveryBeforeTerminal(input: AttemptRecoveryBeforeTerminalInput): RecoveryOutcome {
  const extensionDir = path.join(input.workingDir, 'extension');
  let lastGateFailures: BetweenTicketGateFailure[] = [];
  const deps: RecoveryDeps = {
    iteration: input.iteration,
    ticketId: input.ticketId,
    assessEvidence: () => assessRecoveryEvidence(input.sessionDir, input.workingDir, input.ticketId),
    runArmedGate: () => {
      if (!fs.existsSync(extensionDir)) return { ok: true };
      const r = runBetweenTicketFastTests(extensionDir, input.extensionRoot);
      lastGateFailures = r.failures;
      return { ok: r.ok };
    },
    commitAndFlipDone: () => commitAndContinueDoneFlip({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      statePath: input.statePath,
      flags: input.flags,
      log: input.log,
    }),
    spawnRemediator: () => spawnRecoveryRemediator(input, lastGateFailures),
    executeConvergedPlan: () => executeConvergedPlanAdapter({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      log: input.log,
    }),
    appendAttempt: (attempt: RecoveryAttempt) => {
      try {
        sm.update(input.statePath, s => {
          if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
          s.recovery_attempts.push(attempt);
        });
      } catch { /* best-effort ledger append */ }
    },
    log: input.log,
  };
  return runRecoveryLadder(deps);
}

/** Disposition returned by `haltOrRecoverCodexNoProgress` for the 4 codex no-progress halt sites. */
type CodexNoProgressDisposition =
  | { kind: 'advanced' }
  | { kind: 'recovery_exhausted' }
  | { kind: 'halt' };

export interface HaltOrRecoverCodexNoProgressInput {
  statePath: string;
  sessionDir: string;
  extensionRoot: string;
  workingDir: string;
  iteration: number;
  log: (msg: string) => void;
}

/**
 * Shared codex-authority recovery seam. Invoked at all 4 `codex_manager_no_progress`
 * halt blocks BEFORE the terminal park: runs the recovery ladder and tells the caller
 * whether the queue advanced (relaunch, don't halt), the ladder is exhausted (halt with
 * the honest `recovery_exhausted`), or there is nothing to recover (existing
 * `codex_manager_no_progress` halt). `manager_handoff_pending` is never routed here.
 */
function haltOrRecoverCodexNoProgress(input: HaltOrRecoverCodexNoProgressInput): CodexNoProgressDisposition {
  let flags: Record<string, unknown> | null = null;
  let ticketId = '';
  let workingDir = input.workingDir;
  try {
    const s = readRecoverableJsonObject(input.statePath) as State | null;
    if (s) {
      flags = (s.flags as Record<string, unknown> | undefined) ?? null;
      ticketId = s.current_ticket || '';
      workingDir = s.working_dir || workingDir;
    }
  } catch { /* best-effort — fall through to halt if state is unreadable */ }
  if (!ticketId) return { kind: 'halt' };
  const recovery = attemptRecoveryBeforeTerminal({
    sessionDir: input.sessionDir,
    statePath: input.statePath,
    extensionRoot: input.extensionRoot,
    workingDir,
    ticketId,
    iteration: input.iteration,
    flags,
    log: input.log,
  });
  if (recovery.kind === 'advanced') {
    input.log(`recovery: ${recovery.strategy} advanced ${ticketId} before codex_manager_no_progress — relaunching.`);
    return { kind: 'advanced' };
  }
  if (recovery.kind === 'exhausted') {
    input.log(`recovery_exhausted: ladder exhausted for ${ticketId} (${recovery.reason}).`);
    return { kind: 'recovery_exhausted' };
  }
  return { kind: 'halt' };
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

/**
 * Returns true when the codegraph db mtime is older than the staleness threshold.
 * Returns false when the db is absent — full index is setup's responsibility.
 * Injectable `now` and `statSync` seams enable fast-tier unit tests.
 */
export function shouldSyncCodegraph(
  dbPath: string,
  stalenessMaxAgeMinutes: number,
  now: () => number = Date.now,
  statSync: (p: string) => { mtimeMs: number } = fs.statSync,
): boolean {
  try {
    const ageMs = now() - statSync(dbPath).mtimeMs;
    return ageMs >= stalenessMaxAgeMinutes * 60 * 1000;
  } catch {
    return false;
  }
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

/**
 * Sentinel file written into SESSION_ROOT on signal teardown when ≥1 ticket is
 * still remaining (any status other than Done). pipeline-runner reads its
 * presence as an authoritative "pickle phase did NOT complete" signal that
 * forces incomplete regardless of the mux exit code (which a SIGTERM-killed mux
 * sets to 0). Primary signal of B-RRH C2; consumed by pipeline-runner C1.
 */
export const PICKLE_INCOMPLETE_SENTINEL = 'pickle_incomplete.json';

/**
 * B-RRH C2: on signal teardown, if ≥1 ticket is still remaining (status !==
 * Done — Todo/In-Progress/Failed/Skipped all count), write the
 * `pickle_incomplete.json` sentinel into SESSION_ROOT and emit the
 * `pickle_incomplete` activity event. When all tickets are Done (or none exist),
 * write NO sentinel. Returns true iff the sentinel was written. Fully
 * best-effort: never throws (a signal handler must always reach process.exit).
 */
export function writePickleIncompleteSentinelIfRemaining(
  sessionDir: string,
  statePath: string,
  log: (msg: string) => void,
): boolean {
  try {
    const tickets = collectTickets(sessionDir);
    const remaining = tickets.filter(
      t => (t.status || '').toLowerCase().replace(/["']/g, '').trim() !== 'done',
    );
    if (tickets.length === 0 || remaining.length === 0) return false;
    const ts = new Date().toISOString();
    const sentinelPath = path.join(sessionDir, PICKLE_INCOMPLETE_SENTINEL);
    try {
      fs.writeFileSync(sentinelPath, JSON.stringify({
        reason: 'signal_teardown',
        remaining_count: remaining.length,
        total: tickets.length,
        ts,
      }, null, 2));
    } catch (err) {
      log(`WARNING: failed to write pickle_incomplete sentinel: ${safeErrorMessage(err)}`);
    }
    const incompleteEvent = { event: 'pickle_incomplete' as const, source: 'pickle' as const, ts };
    try { writeActivityEntry(statePath, incompleteEvent); } catch { /* telemetry best effort */ }
    try { logActivity(incompleteEvent); } catch { /* telemetry best effort */ }
    log(`pickle_incomplete: ${remaining.length}/${tickets.length} tickets remaining at signal teardown`);
    return true;
  } catch (err) {
    log(`WARNING: pickle_incomplete sentinel check failed: ${safeErrorMessage(err)}`);
    return false;
  }
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
    // B-RRH C2: stamp the pickle_incomplete sentinel BEFORE deactivation so a
    // SIGTERM-killed mux (which exits 0) cannot be read as a clean completion.
    writePickleIncompleteSentinelIfRemaining(path.dirname(statePath), statePath, log);
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

/**
 * R-CMWL-4: Tracks consecutive zero-progress codex manager relaunch passes.
 * A pass is zero-progress when the pending ticket count did not decrease since
 * the last relaunch. Resets to 0 on any pass with progress.
 * Returns `{ halt: true }` when 2 consecutive zero-progress passes occurred.
 */
function checkAndUpdateCodexManagerNoProgress(
  statePath: string,
  pendingCount: number,
  log: (msg: string) => void,
): { halt: boolean; consecutiveCount: number } {
  let halt = false;
  let consecutiveCount = 0;
  try {
    sm.update(statePath, (s) => {
      const baseline = typeof s.codex_manager_relaunch_pending_baseline === 'number'
        ? s.codex_manager_relaunch_pending_baseline : null;
      const prior = typeof s.codex_manager_consecutive_no_progress === 'number'
        ? s.codex_manager_consecutive_no_progress : 0;
      if (baseline === null) {
        s.codex_manager_consecutive_no_progress = 0;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      } else if (pendingCount >= baseline) {
        consecutiveCount = prior + 1;
        s.codex_manager_consecutive_no_progress = consecutiveCount;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      } else {
        consecutiveCount = 0;
        s.codex_manager_consecutive_no_progress = 0;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      }
      halt = consecutiveCount >= 2;
    });
  } catch (err) {
    log(`WARN: failed to update codex no-progress counter: ${safeErrorMessage(err)}`);
  }
  return { halt, consecutiveCount };
}

// eslint-disable-next-line complexity, max-lines-per-function -- HT-1 reviewed: legacy completion branch retained behavior-preserving; R-CHTS-CODEX adds recovery-seam branches; pre-existing violation, refactor deferred to a focused PR.
export async function processCompletionBranch(state: State, result: IterationOutcome['completion'], ctx: LoopContext): Promise<LoopAction> {
  if (result === 'task_completed') return processTaskCompleted(state, ctx);
  if (result === 'review_clean') return processReviewClean(ctx);
  if (result === 'inactive') {
    if (detectManagerInactiveExit(ctx.outcome)) {
      let postState: State = state;
      try { postState = ctxReadState(ctx); } catch { /* fall back to pre-iteration state */ }
      const inactiveExitKind = classifyManagerRelaunchExit(
        postState,
        ctx.outcome,
        ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
        ctx.maxTurns ?? null,
      );
      if (inactiveExitKind === 'codex_session_inactive') {
        const inactiveDecision = evaluateManagerRelaunch(
          postState,
          collectTickets(ctx.sessionDir),
          ctx.cbState ?? null,
          inactiveExitKind,
        );
        if (inactiveDecision.reason === 'time_limit') {
          ctx.log('Time limit reached. Exiting.');
          finalizeTerminalState(ctx.statePath, { step: 'completed', runnerIteration: ctx.iteration, exitReason: 'limit' });
          return { kind: 'break', reason: 'limit' };
        }
        if (inactiveDecision.shouldRelaunch) {
          const noProgress = checkAndUpdateCodexManagerNoProgress(ctx.statePath, inactiveDecision.pendingCount, ctx.log);
          if (noProgress.halt) {
            // AC-2 fail-safe: a missing working_dir on this git-mutating recovery
            // seam must halt, never fall back to process.cwd() (the real repo).
            const workingDir4R = postState.working_dir || state.working_dir;
            if (!workingDir4R) {
              recordExitReason(ctx.statePath, 'state_working_dir_missing');
              ctxDeactivate(ctx);
              return { kind: 'break', reason: 'state_working_dir_missing' };
            }
            // R-CHTS-CODEX: route through recovery seam before parking.
            const codexRecovery = haltOrRecoverCodexNoProgress({
              statePath: ctx.statePath,
              sessionDir: ctx.sessionDir,
              extensionRoot: ctx.extensionRoot,
              workingDir: workingDir4R,
              iteration: ctx.iteration,
              log: ctx.log,
            });
            if (codexRecovery.kind === 'advanced') {
              return { kind: 'relaunch', relaunchCount: inactiveDecision.nextRelaunchCount, pendingTickets: inactiveDecision.pendingCount, resetStall: true };
            }
            if (codexRecovery.kind === 'recovery_exhausted') {
              recordExitReason(ctx.statePath, 'recovery_exhausted');
              ctxDeactivate(ctx);
              return { kind: 'break', reason: 'recovery_exhausted' };
            }
            // kind === 'halt' → fall through to existing park.
            ctx.log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
            logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(ctx.sessionDir), iteration: ctx.iteration, backend: resolveBackendFromStateFileWithSource(ctx.statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: inactiveDecision.pendingCount });
            recordExitReason(ctx.statePath, 'codex_manager_no_progress');
            ctxDeactivate(ctx);
            return { kind: 'break', reason: 'codex_manager_no_progress' };
          }
          const relaunchBackend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
          ctx.log(
            `${relaunchBackend} manager subprocess exited via ${inactiveExitKind} with ${inactiveDecision.pendingCount} ticket(s) still pending — ` +
            `relaunching (count ${inactiveDecision.nextRelaunchCount}/${inactiveDecision.cap}).`,
          );
          recordManagerRelaunch(ctx.statePath, ctx.sessionDir, inactiveDecision, ctx.iteration, ctx.log);
          return { kind: 'relaunch', relaunchCount: inactiveDecision.nextRelaunchCount, pendingTickets: inactiveDecision.pendingCount, resetStall: true };
        }
      }
    }
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
      const noProgress = checkAndUpdateCodexManagerNoProgress(ctx.statePath, decision.pendingCount, ctx.log);
      if (noProgress.halt) {
        // AC-2 fail-safe: a missing working_dir on this git-mutating recovery
        // seam must halt, never fall back to process.cwd() (the real repo).
        const workingDir4Rerr = postState.working_dir || state.working_dir;
        if (!workingDir4Rerr) {
          recordExitReason(ctx.statePath, 'state_working_dir_missing');
          ctxDeactivate(ctx);
          return { kind: 'break', reason: 'state_working_dir_missing' };
        }
        // R-CHTS-CODEX: route through recovery seam before parking.
        const codexRecovery = haltOrRecoverCodexNoProgress({
          statePath: ctx.statePath,
          sessionDir: ctx.sessionDir,
          extensionRoot: ctx.extensionRoot,
          workingDir: workingDir4Rerr,
          iteration: ctx.iteration,
          log: ctx.log,
        });
        if (codexRecovery.kind === 'advanced') {
          return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: decision.pendingCount, resetStall: true };
        }
        if (codexRecovery.kind === 'recovery_exhausted') {
          recordExitReason(ctx.statePath, 'recovery_exhausted');
          ctxDeactivate(ctx);
          return { kind: 'break', reason: 'recovery_exhausted' };
        }
        // kind === 'halt' → fall through to existing park.
        ctx.log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
        logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(ctx.sessionDir), iteration: ctx.iteration, backend: resolveBackendFromStateFileWithSource(ctx.statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: decision.pendingCount });
        recordExitReason(ctx.statePath, 'codex_manager_no_progress');
        ctxDeactivate(ctx);
        return { kind: 'break', reason: 'codex_manager_no_progress' };
      }
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
 * R-WSWA-2 (R-WMW-2): per-ticket artifact-progress tracking + K=3 observability.
 *
 * The manager-turn-budget wedge (research→plan loop that never delegates
 * completion) is silent for ~60+ min because no signal counts how many spawns
 * produced no new review/conformance artifacts. These helpers snapshot the count
 * of `code_review_*.md` + `conformance_*.md` around each worker spawn, persist the
 * delta into `state.worker_artifact_progress[ticketId]` (schema v5, landed in
 * R-WSWA-1) so it survives a manager relaunch (R-MMTR boundary), and emit
 * `worker_artifact_progress_zero` once after K consecutive zero-delta spawns.
 * Observability ONLY — no halt, no action.
 */
export const WMW_OBSERVE_K_ENV = 'PICKLE_WMW_OBSERVE_K';
export const WMW_OBSERVE_K_DEFAULT = 3;

export function resolveWmwObserveK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_OBSERVE_K_ENV];
  if (!raw) return WMW_OBSERVE_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_OBSERVE_K_DEFAULT;
}

export const WMW_SKIP_K_ENV = 'PICKLE_WMW_SKIP_K';
export const WMW_SKIP_K_DEFAULT = 5;

export function resolveWmwSkipK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_SKIP_K_ENV];
  if (!raw) return WMW_SKIP_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_SKIP_K_DEFAULT;
}

// AC-A4 (B-RRH): the early-phase credit window — for a `large`-tier ticket's
// first N spawns, research/plan artifacts credit progress. N defaults to 4, kept
// strictly below the default skip threshold (WMW_SKIP_K_DEFAULT = 5) so phase
// churn PAST the window still reaches worker_auto_skip_oversized.
export const WMW_EARLY_PHASE_K_ENV = 'PICKLE_WMW_EARLY_PHASE_K';
export const WMW_EARLY_PHASE_K_DEFAULT = 4;

export function resolveWmwEarlyPhaseK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_EARLY_PHASE_K_ENV];
  if (!raw) return WMW_EARLY_PHASE_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_EARLY_PHASE_K_DEFAULT;
}

/**
 * Count the artifact files whose progress R-WMW tracks: code_review_* +
 * conformance_* markdown. AC-A4 (B-RRH): when `opts.creditEarlyPhases` is set,
 * ALSO count the graded early-phase artifacts `research*` + `plan*` so a large-tier
 * worker grinding through the early lifecycle (research → plan) during its first
 * N spawns credits forward progress instead of charging zero-progress. The default
 * (no opts) stays code_review_* + conformance_* only — existing callers and the
 * past-N phase-churn path are unchanged, so an oversized ticket still auto-skips.
 */
export function countWorkerArtifacts(
  ticketDir: string,
  opts: { creditEarlyPhases?: boolean } = {},
): number {
  let n = 0;
  try {
    for (const e of fs.readdirSync(ticketDir)) {
      if (!e.endsWith('.md')) continue;
      if (e.startsWith('code_review') || e.startsWith('conformance')) n++;
      else if (opts.creditEarlyPhases && (e.startsWith('research') || e.startsWith('plan'))) n++;
    }
  } catch { /* dir missing/unreadable → 0 */ }
  return n;
}

/**
 * AC-R-WMNP-1: digest of the working-tree source state so a worker that lands real
 * source work (new/grown files, changed diff) but writes no new lifecycle artifact
 * file still counts as progress. Combines `git status --porcelain` (covers untracked
 * + staged + unstaged path set) with `git diff --numstat` (covers per-file line
 * churn on tracked files) into one comparable string. Returns `null` when git is
 * unavailable or EITHER probe fails (L1) -- a half-signature from one successful
 * probe would silently drop the other probe's signal and could read as a spurious
 * change/no-change against a prior COMPLETE signature. The caller's `?? prev`
 * fallback then preserves the prior complete signature instead of corrupting it.
 * `spawnSync` reports a timeout as `status === null` plus `error.code === 'ETIMEDOUT'`
 * (no thrown error), so an OR-in on the ETIMEDOUT codes catches a timed-out probe.
 */
export function computeSourceTreeSignature(workingDir: string): string | null {
  try {
    const status = spawnSync('git', ['-C', workingDir, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 10_000 });
    const numstat = spawnSync('git', ['-C', workingDir, 'diff', '--numstat'], { encoding: 'utf-8', timeout: 10_000 });
    const statusErr = (status.error as NodeJS.ErrnoException | undefined)?.code;
    const numstatErr = (numstat.error as NodeJS.ErrnoException | undefined)?.code;
    if (
      status.status !== 0
      || numstat.status !== 0
      || statusErr === 'ETIMEDOUT'
      || numstatErr === 'ETIMEDOUT'
    ) {
      return null;
    }
    return `${status.stdout ?? ''} ${numstat.stdout ?? ''}`;
  } catch {
    return null;
  }
}

/**
 * AC-A3 (B-RRH): scoped working-tree signature. Identical contract to
 * `computeSourceTreeSignature` (null on git-unavailable / non-zero / ETIMEDOUT
 * EITHER probe, so the caller's `?? prev` preserves a prior COMPLETE signature)
 * but bounded to `scope.json:allowed_paths` (reusing the `getLatestCommitInScope`
 * convention from `services/artifact-progress-detector.ts`). A peer session's
 * dirty `prds/` file is OUTSIDE allowed_paths and so is absent from the signature
 * — closing the B-HRPW cross-session signature pollution. When scope.json is
 * absent / malformed / has no `allowed_paths`, it delegates to the whole-tree
 * `computeSourceTreeSignature` (unscoped fallback, never crashes the runner).
 */
/** Read `allowed_paths` git-pathspecs from a scope.json FILE path; absent/malformed → []. Fail-open. */
function readScopeAllowedPathSpecsFromFile(scopeJsonPath?: string): string[] {
  const pathSpecs: string[] = [];
  if (!scopeJsonPath) return pathSpecs;
  try {
    const raw = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
    if (Array.isArray(raw?.allowed_paths)) {
      for (const p of raw.allowed_paths) {
        if (typeof p === 'string') pathSpecs.push(p);
      }
    }
  } catch { /* scope.json absent or malformed — fall through to unscoped */ }
  return pathSpecs;
}

/** Combine a status+numstat probe pair into a signature; null on non-zero/ETIMEDOUT either probe. */
function gitProbesToSignature(
  status: ReturnType<typeof spawnSync>,
  numstat: ReturnType<typeof spawnSync>,
): string | null {
  const statusErr = (status.error as NodeJS.ErrnoException | undefined)?.code;
  const numstatErr = (numstat.error as NodeJS.ErrnoException | undefined)?.code;
  if (status.status !== 0 || numstat.status !== 0 || statusErr === 'ETIMEDOUT' || numstatErr === 'ETIMEDOUT') {
    return null;
  }
  return `${String(status.stdout ?? '')} ${String(numstat.stdout ?? '')}`;
}

export function computeScopedSourceTreeSignature(
  workingDir: string,
  scopeJsonPath?: string,
): string | null {
  const pathSpecs = readScopeAllowedPathSpecsFromFile(scopeJsonPath);
  if (pathSpecs.length === 0) return computeSourceTreeSignature(workingDir);
  try {
    const status = spawnSync('git', ['-C', workingDir, 'status', '--porcelain', '--', ...pathSpecs], { encoding: 'utf-8', timeout: 10_000 });
    const numstat = spawnSync('git', ['-C', workingDir, 'diff', '--numstat', '--', ...pathSpecs], { encoding: 'utf-8', timeout: 10_000 });
    return gitProbesToSignature(status, numstat);
  } catch {
    return null;
  }
}

/**
 * AC-A5 (B-RRH): compiled default for `hardening.breaker_recovery_grace_seconds`
 * (30s). A spawn within this many seconds of a circuit-breaker recovery is given
 * grace — its zero-progress increment is suppressed (the worker is racing a
 * just-reopened breaker, not genuinely stuck).
 */
export const DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS = 30;

/**
 * Resolve `hardening.breaker_recovery_grace_seconds` from the settings bag.
 * Mirrors `resolveHardeningSettings` doctrine: absent / partial / malformed bag
 * or non-(non-negative-integer) field falls back to the compiled default; never
 * throws.
 */
export function resolveBreakerRecoveryGraceSeconds(bag: unknown): number {
  if (!bag || typeof bag !== 'object') return DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS;
  const block = (bag as Record<string, unknown>).hardening;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS;
  const grace = (block as Record<string, unknown>).breaker_recovery_grace_seconds;
  if (typeof grace === 'number' && Number.isInteger(grace) && grace >= 0) return grace;
  return DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS;
}

/**
 * AC-A5 (B-RRH): true when the circuit breaker recently recovered (transitioned
 * out of OPEN) and `nowMs` is within `graceSeconds` of that recovery. A still-OPEN
 * breaker is NOT a recovery (the loop exits on OPEN elsewhere); HALF_OPEN is
 * actively probing recovery; a CLOSED breaker that has tripped at least once
 * (`total_opens > 0`) is within grace while its last transition is recent.
 * Fail-open: an unparseable `last_change` yields false.
 */
export function isWithinBreakerRecoveryGrace(
  cbState: CircuitBreakerState | null | undefined,
  graceSeconds: number,
  nowMs: number,
): boolean {
  if (!cbState) return false;
  if (cbState.state === 'OPEN') return false;
  if (cbState.state === 'HALF_OPEN') return true;
  if (cbState.total_opens > 0 && typeof cbState.last_change === 'string') {
    const changedMs = Date.parse(cbState.last_change);
    if (!Number.isFinite(changedMs)) return false;
    const elapsed = nowMs - changedMs;
    return elapsed >= 0 && elapsed <= graceSeconds * 1000;
  }
  return false;
}

/**
 * AC-A1 (B-RRH) default done-guard: a ticket is "fine" (never charged) when its
 * frontmatter status is Done AND it carries explicit (`completion_commit`) OR
 * inferred (`completion_commit_inferred`) completion evidence. Fail-open — a
 * missing/unreadable ticket file yields false so the normal charge path runs.
 */
function defaultDoneGuard(sessionDir: string, ticketId: string): boolean {
  try {
    if (normalizeTicketStatus(getTicketStatus(sessionDir, ticketId)) !== 'done') return false;
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    const explicit = (readFrontmatterField(raw, 'completion_commit') ?? '').trim();
    const inferred = (readFrontmatterField(raw, 'completion_commit_inferred') ?? '').trim();
    return explicit.length > 0 || inferred.length > 0;
  } catch {
    return false;
  }
}

/**
 * AC-A4 (B-RRH): true when the ticket is `large`-tier AND still inside its early
 * phase-credit window (`priorSpawnCount < n`). Outside the window — or for any
 * non-large tier — research/plan artifacts no longer credit progress, so a ticket
 * that only churns phases past the window still reaches worker_auto_skip_oversized.
 * Fail-open: a missing/unreadable ticket file yields false.
 */
export function resolveCreditEarlyPhases(
  sessionDir: string,
  ticketId: string,
  priorSpawnCount: number,
  n: number,
): boolean {
  if (priorSpawnCount >= n) return false;
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    const tier = (readFrontmatterField(raw, 'complexity_tier') ?? '').trim().toLowerCase();
    return tier === 'large';
  } catch {
    return false;
  }
}

/**
 * AC-A2 (B-RRH): per-ticket ladder exhaustion is an ADVANCE while ≥1 runnable Todo
 * remains; only when none remains does the run EXIT (B-LERD: run-exit on a still-
 * progressable bundle). Flips the exhausted ticket Failed/oversized so it leaves
 * the runnable set, emits the (A0-frozen) `ticket_ladder_exhausted` literal, clears
 * current_ticket, then returns `'advance'` (a runnable ticket remains) or `'exit'`
 * (none remains — the caller performs the recovery_exhausted run-exit). The global
 * iteration cap is enforced separately at the loop top.
 */
export function advanceOrExitOnLadderExhaustion(input: {
  sessionDir: string;
  statePath: string;
  ticketId: string;
  reason: string;
  log: (m: string) => void;
}): 'advance' | 'exit' {
  const { sessionDir, statePath, ticketId, reason, log } = input;
  try {
    updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
    const tfPath = ticketFilePath(sessionDir, ticketId);
    const tfRaw = fs.readFileSync(tfPath, 'utf-8');
    const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', 'oversized_no_progress');
    if (tfUpdated) fs.writeFileSync(tfPath, tfUpdated);
  } catch (err) { log(`[ticket-ladder] frontmatter flip failed (ignored): ${safeErrorMessage(err)}`); }
  try {
    writeActivityEntry(statePath, {
      event: 'ticket_ladder_exhausted',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: { reason },
    });
  } catch { /* best-effort */ }
  updateMuxLifecycleState(statePath, { currentTicket: null });
  return noRunnableTicketsRemain(sessionDir) ? 'exit' : 'advance';
}

/**
 * Persist the post-spawn progress delta for one ticket and, on exactly the
 * K-th consecutive zero-PROGRESS spawn, emit `worker_artifact_progress_zero`.
 * `beforeCount` is the snapshot taken BEFORE the spawn; the AFTER snapshot is read
 * here. Progress = artifact-count grew (`delta > 0`) OR the working-tree source
 * signature changed since the prior spawn (AC-R-WMNP-1). Only a spawn that produced
 * NEITHER a new artifact NOR a source-tree change increments `zero_progress_count`;
 * any forward progress resets it to 0. Firing uses `=== k` so it emits once at the
 * threshold (not re-spamming at k+1) and re-arms after a reset.
 */
export function recordWorkerArtifactProgress(
  statePath: string,
  sessionDir: string,
  ticketId: string,
  beforeCount: number,
  opts: {
    k?: number;
    iteration?: number;
    log?: (m: string) => void;
    workingDir?: string;
    sourceSignatureFn?: (workingDir: string) => string | null;
    // AC-A4 (B-RRH): credit research/plan artifacts as progress (early iters of a
    // large-tier ticket). Threaded into countWorkerArtifacts for the AFTER snapshot;
    // the charge site MUST pass the SAME flag into the BEFORE snapshot so the delta
    // is consistent.
    creditEarlyPhases?: boolean;
    // AC-A5 (B-RRH): rate-limited / within-breaker-recovery-grace spawn — the
    // zero-progress counter is HELD (never incremented) so a 429 or breaker-recovery
    // race does not poison the no-progress ladder.
    suppressIncrement?: boolean;
    // AC-A1 (B-RRH): done-guard predicate — a Done ticket with explicit OR inferred
    // completion evidence is never charged. Defaults to a fail-open frontmatter read.
    doneGuardFn?: (sessionDir: string, ticketId: string) => boolean;
  } = {},
): { spawnCount: number; lastArtifactCount: number; zeroProgressCount: number; fired: boolean; doneGuard: boolean; incrementSuppressed: boolean } {
  const k = opts.k ?? resolveWmwObserveK();
  const afterCount = countWorkerArtifacts(path.join(sessionDir, ticketId), { creditEarlyPhases: opts.creditEarlyPhases });
  const delta = afterCount - beforeCount;

  // AC-A1 (B-RRH): a Done ticket with completion evidence is fine — never charge it
  // (B-LERD: run-exit on a Done ticket). Fail-open: any read error → not guarded.
  const doneGuardFn = opts.doneGuardFn ?? defaultDoneGuard;
  let doneGuard = false;
  try { doneGuard = doneGuardFn(sessionDir, ticketId); } catch { doneGuard = false; }

  // AC-R-WMNP-1: capture the current source-tree signature. A non-null signature
  // that differs from the prior spawn's stored signature counts as progress even
  // when no new artifact file appeared.
  const sigFn = opts.sourceSignatureFn ?? computeSourceTreeSignature;
  const sourceSignature = opts.workingDir ? sigFn(opts.workingDir) : null;

  let incremented = false;
  const updated = sm.update(statePath, s => {
    const map = (s.worker_artifact_progress && typeof s.worker_artifact_progress === 'object')
      ? s.worker_artifact_progress
      : (s.worker_artifact_progress = {});
    const prev = map[ticketId] ?? { spawn_count: 0, last_artifact_count: 0, zero_progress_count: 0 };
    const artifactProgressed = delta > 0;
    // AC-R-WMNP-1 (M2/M3): a non-null signature counts as forward progress when
    // (a) no prior signature was ever captured (FIRST capture — spawn 1 that lands
    // only source work must seed the baseline, not be scored zero-progress), or
    // (b) a prior null sentinel recorded a git-unavailable spawn and this probe
    // finally succeeded (gap recovery — the prior `undefined` guard hid this until
    // spawn 3), or (c) the signature actually changed since the prior spawn.
    const sourceProgressed = sourceSignature !== null
      && (prev.last_source_signature === undefined
        || prev.last_source_signature === null
        || sourceSignature !== prev.last_source_signature);
    const progressed = artifactProgressed || sourceProgressed;
    // Charge precedence: A1 done-guard resets (ticket is fine) → A any forward
    // progress resets → A5 suppression HOLDS (no increment) → otherwise increment.
    let nextZero: number;
    if (doneGuard || progressed) {
      nextZero = 0;
    } else if (opts.suppressIncrement) {
      nextZero = prev.zero_progress_count;
    } else {
      nextZero = prev.zero_progress_count + 1;
      incremented = true;
    }
    map[ticketId] = {
      spawn_count: prev.spawn_count + 1,
      last_artifact_count: afterCount,
      zero_progress_count: nextZero,
      // Carry the freshest signature forward. On a probe failure persist an
      // explicit `null` sentinel (M3) — not the prior value, and not `undefined` —
      // so a later successful probe is detected as gap-recovery progress rather
      // than staying invisible behind a missing-baseline guard. Only preserve a
      // prior COMPLETE (non-null) signature when there was no prior at all.
      last_source_signature: sourceSignature !== null
        ? sourceSignature
        : (prev.last_source_signature ?? null),
    };
  });

  const entry = updated.worker_artifact_progress?.[ticketId]
    ?? { spawn_count: 1, last_artifact_count: afterCount, zero_progress_count: 0 };
  // Fire only when THIS spawn incremented to the threshold — a held (suppressed)
  // or done-guarded spawn that merely sits at k must not re-fire.
  const fired = incremented && entry.zero_progress_count === k;
  if (fired) {
    writeActivityEntry(statePath, {
      event: 'worker_artifact_progress_zero',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: {
        spawn_count: entry.spawn_count,
        last_artifact_count: entry.last_artifact_count,
        zero_progress_count: entry.zero_progress_count,
        observe_k: k,
      },
    });
    opts.log?.(`[observe] worker_artifact_progress_zero: ticket ${ticketId} produced no new review/conformance artifacts for ${k} consecutive spawns`);
  }
  return {
    spawnCount: entry.spawn_count,
    lastArtifactCount: entry.last_artifact_count,
    zeroProgressCount: entry.zero_progress_count,
    fired,
    doneGuard,
    incrementSuppressed: !!opts.suppressIncrement && !incremented && !doneGuard,
  };
}

// ─── Ticket 90574654: silent-death sub-classification + salvage-first recovery ───

/** Silent-death sub-classes (90574654). `log_empty` → `worker_silent_death`; `log_truncated` → existing `worker_partial_lifecycle_exit`. */
export type SilentDeathSubClass = 'log_empty' | 'log_truncated';

export interface PartialLifecycleExitClassification {
  /** `null` → graceful exit (terminal promise token present); not a silent-death shape, no recovery policy. */
  subClass: SilentDeathSubClass | null;
  artifactsMissing: string[];
  sessionLogSize: number;
  logPath: string;
  pid: number | null;
}

/** Worker terminal completion signal (promise-tokens.ts WORKER_DONE). */
const WORKER_TERMINAL_PROMISE_RE = /<promise>\s*I AM DONE\s*<\/promise>/;
const SILENT_DEATH_GIT_TIMEOUT_MS = 10_000;
const LIFECYCLE_ARTIFACT_RE = /^(research|plan|conformance|code_review).*\.md$/;
const SILENT_DEATH_RESPAWN_STRATEGY = 'silent_death_respawn';

/**
 * Sub-classify the worker exit by its session log(s). The LATEST
 * `worker_session_<pid>.log` (mtime, filename tiebreak) decides the sub-class:
 * absent or 0-byte → `log_empty`; nonzero without the terminal promise token →
 * `log_truncated`; nonzero WITH the token → graceful (`null`).
 * `sessionLogSize` stays the SUM across all logs (existing payload semantics).
 */
function classifyWorkerSessionLogs(ticketDir: string, files: string[]): {
  subClass: SilentDeathSubClass | null;
  sessionLogSize: number;
  logPath: string;
  pid: number | null;
} {
  const logs: Array<{ file: string; size: number; mtimeMs: number }> = [];
  let sessionLogSize = 0;
  for (const file of files) {
    if (!/^worker_session_\d+\.log$/.test(file)) continue;
    try {
      const st = fs.statSync(path.join(ticketDir, file));
      sessionLogSize += st.size;
      logs.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* ignore unreadable log */ }
  }
  logs.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.file.localeCompare(b.file));
  const latest = logs.length > 0 ? logs[logs.length - 1] : null;
  if (!latest) {
    return { subClass: 'log_empty', sessionLogSize, logPath: path.join(ticketDir, 'worker_session_absent.log'), pid: null };
  }
  const pidMatch = latest.file.match(/^worker_session_(\d+)\.log$/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const logPath = path.join(ticketDir, latest.file);
  if (latest.size === 0) return { subClass: 'log_empty', sessionLogSize, logPath, pid };
  let content = '';
  try { content = fs.readFileSync(logPath, 'utf-8'); } catch { /* unreadable nonzero log → treat as truncated */ }
  return { subClass: WORKER_TERMINAL_PROMISE_RE.test(content) ? null : 'log_truncated', sessionLogSize, logPath, pid };
}

/**
 * Count successful silent-death respawns already drawn from the shared cap for
 * THIS ticket (persisted ledger — survives relaunch and `setup.js --resume`).
 * The cap is shared across both sub-classes (log_empty + log_truncated) but
 * scoped per ticket, mirroring `worker_artifact_progress` keying: ticket B's
 * silent death must not be charged against ticket A's budget.
 */
function countSilentDeathRespawns(statePath: string, ticketId: string): number {
  return countLedgerSuccesses(statePath, ticketId, SILENT_DEATH_RESPAWN_STRATEGY);
}

/** Count `outcome: 'success'` entries in `state.recovery_attempts` for one ticket + strategy (persisted ledger — survives relaunch and `setup.js --resume`). */
function countLedgerSuccesses(statePath: string, ticketId: string, strategy: string): number {
  try {
    const s = readRecoverableJsonObject(statePath) as State | null;
    if (!s || !Array.isArray(s.recovery_attempts)) return 0;
    return s.recovery_attempts.filter(
      (a) => a && a.strategy === strategy && a.outcome === 'success' && a.ticket === ticketId,
    ).length;
  } catch { return 0; }
}

/**
 * R-WSE-2 / R-PIAP-A4: Emit worker_partial_lifecycle_exit when a worker exits
 * mid-lifecycle leaving required artifacts missing. The required set is derived
 * from TIER_LIFECYCLE[tier] (R-PIAP-A1) via requiredTierArtifactPrefixes — never
 * a hardcoded list — so a trivial ticket (implement + code_review only) is not
 * penalized for absent research_*.md / plan_*.md.
 *
 * Progress gate: tiers whose lifecycle includes research_review keep the R-WSE-2
 * "research APPROVED" precondition (don't flag a worker still iterating on
 * research). Tiers without research (trivial/small) instead require at least one
 * gated artifact to be present so a not-started worker is never flagged.
 *
 * 90574654 delta: the exit is sub-classified by worker session log. `log_empty`
 * (0-byte/absent log) emits the NEW `worker_silent_death` event instead;
 * `log_truncated` and graceful exits keep the EXISTING event. Exactly ONE event
 * fires per exit — the two events are mutually exclusive by construction. The
 * classification is returned so the caller can route silent-death shapes into
 * `applySilentDeathRecoveryPolicy`. Returns `null` when no partial-lifecycle
 * exit was detected (no event emitted).
 */
export function checkPartialLifecycleExit(sessionDir: string, statePath: string, ticketId: string): PartialLifecycleExitClassification | null {
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return null; }

  let tier: TicketComplexityTier = 'medium';
  try {
    tier = parseTicketFrontmatter(ticketFilePath(sessionDir, ticketId))?.complexity_tier ?? 'medium';
  } catch { /* default medium */ }

  const requiredPrefixes = requiredTierArtifactPrefixes(tier);
  const artifactsMissing = findMissingPrefixes(files, requiredPrefixes);

  if (TIER_LIFECYCLE[tier].includes('research_review')) {
    if (!files.includes('research_review.md')) return null;
    let reviewContent: string;
    try { reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8'); } catch { return null; }
    if (!reviewContent.trimEnd().endsWith('APPROVED')) return null;
  } else if (artifactsMissing.length === requiredPrefixes.length) {
    // No research gate (trivial/small): require ≥1 gated artifact present as
    // progress evidence so a not-started worker is never flagged.
    return null;
  }

  if (artifactsMissing.length === 0) return null;

  const { subClass, sessionLogSize, logPath, pid } = classifyWorkerSessionLogs(ticketDir, files);

  if (subClass === 'log_empty') {
    // 90574654: silent death — NEVER also the worker_partial_lifecycle_exit event.
    writeActivityEntry(statePath, {
      event: 'worker_silent_death',
      ts: new Date().toISOString(),
      ticket: ticketId,
      pid,
      log_path: logPath,
      sub_class: 'log_empty',
      respawn_attempt: countSilentDeathRespawns(statePath, ticketId),
    });
  } else {
    writeActivityEntry(statePath, {
      event: 'worker_partial_lifecycle_exit',
      ts: new Date().toISOString(),
      source: 'pickle',
      ticket: ticketId,
      gate_payload: { artifacts_missing: artifactsMissing, session_log_size: sessionLogSize },
    });
  }

  return { subClass, artifactsMissing, sessionLogSize, logPath, pid };
}

export interface SilentDeathRecoveryInput {
  sessionDir: string;
  statePath: string;
  ticketId: string;
  workingDir: string;
  iteration: number;
  classification: PartialLifecycleExitClassification | null;
  /** HEAD sha captured before the iteration — base of the iteration commit window. */
  preIterSha?: string | null;
  /** Epoch ms when the iteration began — freshness window for lifecycle artifacts. */
  iterationStartMs?: number;
  /** Injectable for tests; defaults to `resolveHardeningSettings(loadPickleSettingsBag())`. */
  settings?: HardeningSettings | null;
  /** Injectable for tests; defaults to `archiveBeforeDestructive` (0780b805). */
  archive?: (ctx: ArchiveContext) => ArchiveResult | null;
  log?: (msg: string) => void;
}

export type SilentDeathRecoveryDecision =
  | { action: 'none' }
  | { action: 'hold'; subClass: SilentDeathSubClass; evidence: 'completion_commit' | 'scoped_commit' | 'fresh_artifacts' | 'archive_failed' }
  | { action: 'respawn'; subClass: SilentDeathSubClass; attempt: number; cap: number }
  | { action: 'halt'; subClass: SilentDeathSubClass; exitReason: 'recovery_exhausted'; cap: number };

/** Best-effort git probe with a finite timeout (bin/ subsystem invariant #3). Returns null on any failure. */
function silentDeathGit(args: string[], cwd: string): string | null {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: SILENT_DEATH_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch { return null; }
}

/** Read `allowed_paths` from the session-root scope.json; null when unscoped/unreadable. */
function readScopeAllowedPaths(sessionDir: string): string[] | null {
  try {
    const scope = readRecoverableJsonObject(path.join(sessionDir, 'scope.json')) as Record<string, unknown> | null;
    if (!scope || !Array.isArray(scope.allowed_paths)) return null;
    return scope.allowed_paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch { return null; }
}

function isWithinAllowedPaths(file: string, allowed: string[]): boolean {
  return allowed.some((a) => {
    const prefix = a.endsWith('/') ? a : `${a}/`;
    return file === a || file.startsWith(prefix);
  });
}

/** Salvage probe 1: ticket frontmatter carries an explicit completion sha (quoted forms accepted, R-CCQF parity). */
function hasFrontmatterCompletionSha(sessionDir: string, ticketId: string): boolean {
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    for (const field of ['completion_commit', 'completion_commit_inferred'] as const) {
      const value = (readFrontmatterField(raw, field) ?? '').trim().replace(/^['"]+|['"]+$/g, '');
      if (/^[0-9a-f]{7,40}$/i.test(value)) return true;
    }
  } catch { /* missing/unreadable ticket file → no evidence */ }
  return false;
}

/** Salvage probe 2: a commit landed in the iteration window touching only `allowed_paths` (unscoped session → any commit counts). */
function hasScopedIterationWindowCommit(input: SilentDeathRecoveryInput): boolean {
  if (!input.preIterSha) return false;
  const head = silentDeathGit(['rev-parse', 'HEAD'], input.workingDir);
  if (!head || head === input.preIterSha) return false;
  const diffOut = silentDeathGit(['diff', '--name-only', `${input.preIterSha}..HEAD`], input.workingDir);
  if (diffOut === null) return false;
  const touched = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (touched.length === 0) return false;
  const allowed = readScopeAllowedPaths(input.sessionDir);
  if (!allowed || allowed.length === 0) return true;
  return touched.every((f) => isWithinAllowedPaths(f, allowed));
}

/** Salvage probe 3: a lifecycle artifact was written inside the iteration window. */
function hasFreshLifecycleArtifacts(input: SilentDeathRecoveryInput): boolean {
  if (typeof input.iterationStartMs !== 'number') return false;
  try {
    const ticketDir = path.join(input.sessionDir, input.ticketId);
    for (const file of fs.readdirSync(ticketDir)) {
      if (!LIFECYCLE_ARTIFACT_RE.test(file)) continue;
      try {
        if (fs.statSync(path.join(ticketDir, file)).mtimeMs >= input.iterationStartMs) return true;
      } catch { /* ignore unstattable artifact */ }
    }
  } catch { /* ticket dir unreadable → no evidence */ }
  return false;
}

/** Append one entry to `state.recovery_attempts` (R-WMW-5 persistence pattern: state-backed, survives relaunch/--resume). */
function appendRecoveryLedgerEntry(statePath: string, attempt: RecoveryAttempt): void {
  try {
    sm.update(statePath, (s) => {
      if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
      s.recovery_attempts.push(attempt);
    });
  } catch { /* best-effort ledger append — never block recovery */ }
}

function detectSilentDeathAttributableWork(
  input: SilentDeathRecoveryInput,
): 'completion_commit' | 'scoped_commit' | 'fresh_artifacts' | null {
  if (hasFrontmatterCompletionSha(input.sessionDir, input.ticketId)) return 'completion_commit';
  if (hasScopedIterationWindowCommit(input)) return 'scoped_commit';
  if (hasFreshLifecycleArtifacts(input)) return 'fresh_artifacts';
  return null;
}

/**
 * 90574654 — ONE shared recovery policy for both silent-death sub-classes,
 * salvage FIRST:
 *  (a) attributable work (frontmatter completion sha | iteration-window commit
 *      touching only allowed_paths | fresh lifecycle artifacts) → `hold`: NO
 *      respawn, no cap drawdown, ticket status untouched (H4 hold path —
 *      ticket 7eb9fa20; until it lands, hold = suppress respawn only).
 *  (b) dirty tree → `archiveBeforeDestructive` (reason `silent_death`,
 *      `.codegraph/**` excluded via isCodegraphArtifact inside the helper).
 *      `ArchiveAbortError` is fail-closed: respawn suppressed. Other archive
 *      errors (e.g. non-repo workingDir) are fail-open per ticket contract.
 *  (c) no attributable work → `respawn`, drawing down the ONE shared
 *      `silent_death_respawn_cap` persisted in `state.recovery_attempts`
 *      (strategy `silent_death_respawn`) so the budget survives relaunch and
 *      `setup.js --resume`.
 *  (d) cap exhausted → `halt` with the existing HALT-class `recovery_exhausted`.
 *
 * Never writes `worker_artifact_progress` (R-WMW-5 precedence) and never flips
 * ticket status.
 */
export function applySilentDeathRecoveryPolicy(input: SilentDeathRecoveryInput): SilentDeathRecoveryDecision {
  const cls = input.classification;
  if (!cls || cls.subClass === null) return { action: 'none' };
  const subClass = cls.subClass;
  const log = input.log ?? (() => { /* silent default */ });

  const evidence = detectSilentDeathAttributableWork(input);
  if (evidence) {
    log(`[silent-death] ${subClass} for ${input.ticketId}: attributable work (${evidence}) — hold, no respawn`);
    return { action: 'hold', subClass, evidence };
  }

  try {
    const archive = input.archive ?? archiveBeforeDestructive;
    archive({
      cwd: input.workingDir,
      sessionDir: input.sessionDir,
      ticketDir: path.join(input.sessionDir, input.ticketId),
      reason: 'silent_death',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ArchiveAbortError || (err instanceof Error && err.name === 'ArchiveAbortError')) {
      log(`[silent-death] ${subClass} for ${input.ticketId}: pre-respawn archive failed (${msg}) — suppressing respawn (fail-closed)`);
      return { action: 'hold', subClass, evidence: 'archive_failed' };
    }
    log(`[silent-death] dirty-tree archive probe failed for ${input.ticketId} (ignored): ${msg}`);
  }

  const settings = input.settings ?? resolveHardeningSettings(loadPickleSettingsBag());
  const cap = settings.silent_death_respawn_cap;
  const prior = countSilentDeathRespawns(input.statePath, input.ticketId);
  if (prior < cap) {
    const attempt = prior + 1;
    appendRecoveryLedgerEntry(input.statePath, {
      strategy: SILENT_DEATH_RESPAWN_STRATEGY,
      outcome: 'success',
      reason: `${subClass} respawn ${attempt}/${cap} for ${input.ticketId}`,
      iteration: input.iteration,
      ticket: input.ticketId,
    });
    log(`[silent-death] ${subClass} for ${input.ticketId}: no attributable work — respawn ${attempt}/${cap}`);
    return { action: 'respawn', subClass, attempt, cap };
  }

  appendRecoveryLedgerEntry(input.statePath, {
    strategy: SILENT_DEATH_RESPAWN_STRATEGY,
    outcome: 'failed',
    reason: `cap_exhausted (${prior}/${cap}) for ${input.ticketId} — falling through to no-progress halt`,
    iteration: input.iteration,
    ticket: input.ticketId,
  });
  log(`[silent-death] ${subClass} for ${input.ticketId}: respawn cap ${cap} exhausted — halting`);
  return { action: 'halt', subClass, exitReason: 'recovery_exhausted', cap };
}

// ---------------------------------------------------------------------------
// Ticket 7eb9fa20 (H4) — Failed-flip evidence suppression with bounded
// non-runnable hold. ONE shared policy guards the three real Failed-flip
// callsites: (1) detectAndRecoverHeadRegression's evidence-absent fallback
// (e56ed23f: the head-regression DIVERGENCE/ambiguous/undiscovered path now
// first emits `orphan_commit_unreattachable` and routes here to the hold path;
// it NEVER rewrites history — no `git reset`, no `--force`; `marked_failed` is
// reachable only when this shared policy returns `proceed` with NO evidence),
// (2) the R-WMW-5 wmw-auto-skip flip, (3) spawn-morty's gate-fail reset+flip
// (spawn-morty imports `evaluateFailedFlipSuppression` from this module —
// runtime-only usage, so the existing mux-runner→spawn-morty import of
// `resolveCodexModel` does not create an ESM evaluation-order hazard).
//
// Evidence is an OR-predicate, not AND: fresh lifecycle artifacts in the
// [spawn, exit] window (skew-tolerant, `.codegraph/**` excluded) OR a
// ticket-scoped commit (frontmatter completion sha authoritative — but only
// when it resolves to a real commit object, so a garbage sha can never hold a
// ticket; else a window commit whose touched paths ⊆ scope allowed_paths).
// Evidence-check errors fail OPEN (existing flip behavior proceeds).
// Suppressions persist as `state.recovery_attempts` entries (strategy
// `failed_flip_suppressed`) — NO new state.json top-level field (R-RMBS-1) —
// and emit the `failed_flip_suppressed` activity event. At
// `hardening.failed_flip_suppression_cap` (default 2) the decision escalates
// to the existing no-progress halt instead of suppressing again.
// ---------------------------------------------------------------------------

export const FAILED_FLIP_SUPPRESSED_STRATEGY = 'failed_flip_suppressed';
/** Mtime skew tolerance for the artifact-evidence window (filesystem timestamp granularity). */
const FAILED_FLIP_SKEW_MS = 2_000;

export type FailedFlipCallsite = 'head_regression' | 'wmw_auto_skip' | 'worker_gate_fail';
export type FailedFlipEvidenceKind = 'fresh_artifacts' | 'ticket_commit' | 'both';

export interface FailedFlipSuppressionInput {
  sessionDir: string;
  statePath: string;
  ticketId: string;
  workingDir: string;
  iteration: number;
  callsite: FailedFlipCallsite;
  /** Spawn timestamp (epoch ms) opening the evidence window; null/absent disables the artifact arm. */
  windowStartMs?: number | null;
  /** Exit timestamp (epoch ms) closing the evidence window; defaults to now. */
  windowEndMs?: number | null;
  /** HEAD sha captured before the window — base of the scoped-commit probe. */
  preSha?: string | null;
  /** Injectable for tests; defaults to `resolveHardeningSettings(loadPickleSettingsBag())`. */
  settings?: HardeningSettings | null;
  log?: (msg: string) => void;
}

export type FailedFlipSuppressionDecision =
  | { action: 'suppress'; evidence: FailedFlipEvidenceKind; suppressionCount: number }
  | { action: 'proceed'; reason: 'no_evidence' | 'evidence_check_error' }
  | { action: 'escalate'; cap: number };

/** Evidence arm (a): a lifecycle artifact mtime inside [spawn, exit] + skew; `.codegraph/**` excluded via isCodegraphArtifact. */
function hasFreshTicketArtifactEvidence(input: FailedFlipSuppressionInput): boolean {
  if (typeof input.windowStartMs !== 'number') return false;
  const windowEnd = typeof input.windowEndMs === 'number' ? input.windowEndMs : Date.now();
  const ticketDir = path.join(input.sessionDir, input.ticketId);
  for (const file of fs.readdirSync(ticketDir)) {
    if (isCodegraphArtifact(file)) continue;
    if (!LIFECYCLE_ARTIFACT_RE.test(file)) continue;
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(path.join(ticketDir, file)).mtimeMs; } catch { continue; }
    if (mtimeMs >= input.windowStartMs - FAILED_FLIP_SKEW_MS && mtimeMs <= windowEnd + FAILED_FLIP_SKEW_MS) {
      return true;
    }
  }
  return false;
}

/**
 * Frontmatter completion sha, authoritative but garbage-proof: the sha counts
 * only when it resolves to a real commit object in workingDir (a regex-valid
 * but nonexistent sha must NOT hold a ticket — R-CXOR-1 unrecoverable-orphan
 * flips stay flips).
 */
function hasVerifiedFrontmatterCompletionSha(sessionDir: string, ticketId: string, workingDir: string): boolean {
  let raw: string;
  try { raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8'); } catch { return false; }
  for (const field of ['completion_commit', 'completion_commit_inferred'] as const) {
    const value = (readFrontmatterField(raw, field) ?? '').trim().replace(/^['"]+|['"]+$/g, '');
    if (!/^[0-9a-f]{7,40}$/i.test(value)) continue;
    if (silentDeathGit(['cat-file', '-t', value], workingDir) === 'commit') return true;
  }
  return false;
}

/** Evidence arm (b): frontmatter completion sha (verified) OR a window commit whose touched paths ⊆ allowed_paths. */
function hasTicketScopedCommitEvidence(input: FailedFlipSuppressionInput): boolean {
  if (hasVerifiedFrontmatterCompletionSha(input.sessionDir, input.ticketId, input.workingDir)) return true;
  if (!input.preSha) return false;
  const head = silentDeathGit(['rev-parse', 'HEAD'], input.workingDir);
  if (!head || head === input.preSha) return false;
  const diffOut = silentDeathGit(['diff', '--name-only', `${input.preSha}..HEAD`], input.workingDir);
  if (diffOut === null) return false;
  const touched = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (touched.length === 0) return false;
  const allowed = readScopeAllowedPaths(input.sessionDir);
  if (!allowed || allowed.length === 0) return true;
  return touched.every((f) => isWithinAllowedPaths(f, allowed));
}

/** OR-combine the two evidence arms. Returns null when neither holds. */
function detectFailedFlipEvidence(input: FailedFlipSuppressionInput): FailedFlipEvidenceKind | null {
  const artifacts = hasFreshTicketArtifactEvidence(input);
  const commit = hasTicketScopedCommitEvidence(input);
  if (artifacts && commit) return 'both';
  if (artifacts) return 'fresh_artifacts';
  if (commit) return 'ticket_commit';
  return null;
}

/**
 * Decide suppress / proceed / escalate for one Failed-flip intent.
 * - suppress: evidence present, under cap — ledger entry appended (strategy
 *   `failed_flip_suppressed`, outcome success), `failed_flip_suppressed`
 *   activity event emitted, frontmatter status preserved by the caller.
 * - proceed: no evidence (caller archives a dirty tree, then flips) or the
 *   evidence check itself errored (fail-open: existing flip behavior).
 * - escalate: evidence present but cap reached — caller routes to the
 *   existing no-progress halt; the flip is still skipped (a ticket is only
 *   ever flipped Failed with evidence absent).
 */
export function evaluateFailedFlipSuppression(input: FailedFlipSuppressionInput): FailedFlipSuppressionDecision {
  const log = input.log ?? (() => { /* silent default */ });
  let evidence: FailedFlipEvidenceKind | null;
  try {
    evidence = detectFailedFlipEvidence(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[failed-flip] evidence check failed for ${input.ticketId} at ${input.callsite} (fail-open, flip proceeds): ${msg}`);
    return { action: 'proceed', reason: 'evidence_check_error' };
  }
  if (!evidence) return { action: 'proceed', reason: 'no_evidence' };

  const settings = input.settings ?? resolveHardeningSettings(loadPickleSettingsBag());
  const cap = settings.failed_flip_suppression_cap;
  const prior = countLedgerSuccesses(input.statePath, input.ticketId, FAILED_FLIP_SUPPRESSED_STRATEGY);
  if (prior >= cap) {
    appendRecoveryLedgerEntry(input.statePath, {
      strategy: FAILED_FLIP_SUPPRESSED_STRATEGY,
      outcome: 'failed',
      reason: `cap_exhausted (${prior}/${cap}) at ${input.callsite} for ${input.ticketId} — escalating to no-progress halt`,
      iteration: input.iteration,
      ticket: input.ticketId,
    });
    log(`[failed-flip] ${input.callsite} for ${input.ticketId}: evidence (${evidence}) but suppression cap ${cap} reached — escalating`);
    return { action: 'escalate', cap };
  }

  const suppressionCount = prior + 1;
  appendRecoveryLedgerEntry(input.statePath, {
    strategy: FAILED_FLIP_SUPPRESSED_STRATEGY,
    outcome: 'success',
    reason: `${input.callsite} flip suppressed ${suppressionCount}/${cap} (${evidence}) for ${input.ticketId}`,
    iteration: input.iteration,
    ticket: input.ticketId,
  });
  try {
    writeActivityEntry(input.statePath, {
      event: 'failed_flip_suppressed',
      ts: new Date().toISOString(),
      ticket: input.ticketId,
      evidence,
      suppression_count: suppressionCount,
    });
  } catch { /* best-effort telemetry — never block the suppression */ }
  log(`[failed-flip] ${input.callsite} for ${input.ticketId}: flip suppressed ${suppressionCount}/${cap} (${evidence}) — ticket held, status preserved`);
  return { action: 'suppress', evidence, suppressionCount };
}

/**
 * Ticket ids with an ACTIVE failed-flip suppression hold: a success ledger
 * entry exists AND the operator has not re-queued the ticket (frontmatter
 * `status: Todo` releases the hold — same heal flow as oversized_no_progress).
 * Selection-layer only (R-RMBS-1: `isPendingMuxTicket` stays canonical and
 * untouched). Any read error → empty set (fail-open: never blocks scheduling).
 */
export function readActiveFailedFlipHolds(sessionDir: string): Set<string> {
  const held = new Set<string>();
  try {
    const s = readRecoverableJsonObject(path.join(sessionDir, 'state.json')) as State | null;
    if (!s || !Array.isArray(s.recovery_attempts)) return held;
    for (const a of s.recovery_attempts) {
      if (a && a.strategy === FAILED_FLIP_SUPPRESSED_STRATEGY && a.outcome === 'success' && typeof a.ticket === 'string') {
        held.add(a.ticket);
      }
    }
    for (const id of [...held]) {
      try {
        if (normalizeTicketStatus(getTicketStatus(sessionDir, id)) === 'todo') held.delete(id);
      } catch { /* unreadable status → stay held (conservative) */ }
    }
  } catch { return held; }
  return held;
}

/**
 * Evidence-absent flip path: archive a dirty tree BEFORE the flip so the
 * runner's downstream reset path can never destroy unexamined work.
 * `archiveBeforeDestructive` self-no-ops on a clean tree. Best-effort: the
 * flip itself is a non-destructive frontmatter write, so archive failure
 * (including ArchiveAbortError) logs loudly but does not block the flip.
 */
function archiveDirtyTreeBeforeFlip(input: { workingDir: string; sessionDir: string; ticketId: string; log: (msg: string) => void }): void {
  try {
    archiveBeforeDestructive({
      cwd: input.workingDir,
      sessionDir: input.sessionDir,
      ticketDir: path.join(input.sessionDir, input.ticketId),
      reason: 'pre_reset',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.log(`[failed-flip] pre-flip archive failed for ${input.ticketId} (flip proceeds; tree untouched): ${msg}`);
  }
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
    // poisoned sentinel value does not brick the phase with exit 2. Logged here
    // for observability; validateStartupState performs the same (idempotent)
    // repair silently as part of the single authoritative validation path.
    const timeoutRepair = repairZeroWorkerTimeout(ownerState);
    if (timeoutRepair.repaired) {
      sm.update(statePath, s => { s.worker_timeout_seconds = timeoutRepair.value; });
      log(`[mux-runner] R-WTZ: repaired worker_timeout_seconds 0 → ${timeoutRepair.value}s at load`);
    }
    // Single source of truth for startup-state validation — the same rules used
    // by validateStartupState (covered by mux-runner-startup-validation.test.js).
    // Convert its thrown Error into the runner's exit-2 contract.
    try {
      validateStartupState(ownerState, statePath);
    } catch (err) {
      console.error(safeErrorMessage(err));
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

  // Session-scoped CodegraphService. Declared before signal handlers so closures can reference it.
  // Initialized (async) below, after signal-handler registration — null until create() resolves.
  let cgService: CodegraphService | null = null;
  let cgTicketCount = 0;

  const emitCgSessionSummary = (): void => {
    try {
      if (cgService === null) return;
      const ctrs = cgService.getSessionCounters();
      const index_status: 'healthy' | 'degraded' | 'latched' | 'disabled' =
        ctrs.latched > 0 ? 'latched' : ctrs.degraded > 0 ? 'degraded' : 'healthy';
      writeActivityEntry(statePath, {
        event: 'codegraph_session_summary',
        ts: new Date().toISOString(),
        tickets: cgTicketCount,
        degraded_ops: ctrs.degraded,
        index_status,
      });
    } catch { /* best-effort */ }
  };

  const closeCgService = (): void => {
    if (cgService === null) return;
    try { cgService.close(); } catch { /* best-effort */ }
  };

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
    emitCgSessionSummary();
    closeCgService();
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
  // Artifact-progress snapshot for R-WTB-A1 no-progress window check.
  let lastArtifactProgressSnapshot: ArtifactProgressSnapshot = { latestMtimeEpoch: 0, latestCommitSha: null };
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
  // R-MWIS-2: main-loop idle-stall watchdog. lastProgressEpoch is bumped on every
  // forward-progress marker (iteration advance / state write, worker spawn). The
  // gated watchdog check before each worker spawn detects a wedged loop that is NOT
  // in any legitimate wait state and self-recovers instead of sitting at 0% CPU.
  const muxNow = (): number => Date.now();
  const idleStallThresholdSeconds = resolveIdleStallThresholdSeconds();
  // L2: bound consecutive idle-stall self-recoveries. A genuinely wedged loop that
  // re-arms the stall every pass must escalate instead of spinning forever; any
  // real forward progress resets the streak.
  const idleStallRecoveryCap = resolveIdleStallRecoveryCap();
  let idleStallRecoveryCount = 0;
  // Seeded so the watchdog never trips on a fresh loop; the iteration-advance write
  // (below) always refreshes it before the watchdog reads it each pass.
  // eslint-disable-next-line no-useless-assignment -- declaration-required seed; refreshed at iteration_start before any read
  let lastProgressEpoch = muxNow();
  let readinessGateChecked = false;
  let ticketAuditGateChecked = false;
  let smokeGateBypassEmitted = false;
  let bundleBootstrapApplied = false;

  // Initialize session-scoped CodegraphService (fail-open — never blocks session start).
  const cgSettings = resolveCodegraphSettings(loadPickleSettingsBag());
  const cgWorkingDir = ownerState.working_dir || process.cwd();
  const cgDbPath = path.join(cgWorkingDir, '.codegraph', 'codegraph.db');
  try {
    cgService = await CodegraphService.create(
      cgWorkingDir,
      cgSettings,
      { emit: (ev) => writeActivityEntry(statePath, ev as unknown as ActivityLogEntry) },
    );
  } catch (err) {
    log(`codegraph service init failed (ignored): ${safeErrorMessage(err)}`);
  }

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

    state = clearStalePerTicketCacheAtIterationStart(statePath, state, log, sessionDir);

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
    const templateName = resolveCommandTemplate(state.command_template);
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
      : resolvePreTicket(sessionDir, state.current_ticket);
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
    // R-MWIS-2: iteration advance + state write is a forward-progress marker.
    lastProgressEpoch = muxNow();
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
        // R-ORSR-2: intercept the closer_handoff_terminal park with the recovery
        // ladder. manager_handoff_pending is operator-gated and never recovered.
        if (closerDecision.reason === 'closer_handoff_terminal') {
          // AC-2 fail-safe: missing working_dir must halt this git-mutating
          // recovery call, never fall back to process.cwd() (the real repo).
          if (!state.working_dir) {
            recordExitReason(statePath, 'state_working_dir_missing');
            safeDeactivate(statePath);
            exitReason = 'state_working_dir_missing';
            break;
          }
          const recovery = attemptRecoveryBeforeTerminal({
            sessionDir,
            statePath,
            extensionRoot,
            workingDir: state.working_dir,
            ticketId: state.current_ticket || '',
            iteration,
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
            log,
          });
          if (recovery.kind === 'advanced') {
            log(`recovery: ${recovery.strategy} advanced ${state.current_ticket} before closer_handoff_terminal — continuing.`);
            persistCloserHandoffTracker(statePath, null);
            lastStateIteration = -1;
            stallCount = 0;
            // eslint-disable-next-line no-useless-assignment -- R-ORSR-2 WIP checkpoint (babysitter): defensive state reload after recovery mutation; keep until worker finalizes the ladder loop.
            state = readRunnerState(statePath);
            continue;
          }
          if (recovery.kind === 'exhausted') {
            log(`recovery_exhausted: ladder exhausted for ${state.current_ticket} (${recovery.reason}). Exiting at iteration ${iteration}.`);
            recordExitReason(statePath, 'recovery_exhausted');
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = 'recovery_exhausted';
            break;
          }
          // fall_through → existing closer terminal park.
        }
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

    // L5: all-terminal short-circuit. `applyAllTicketsDoneCompletion` only fires
    // when every ticket is Done; it does NOT catch the all-terminal-Failed case
    // (e.g. every pending ticket flipped oversized_no_progress). When `preTicket`
    // resolved to null AND no runnable ticket remains, exit CLEANLY here rather
    // than entering `runIteration` with a null ticket (which spawns a manager with
    // no work and re-arms the idle-stall watchdog every pass). Matches the all-Done
    // clean-deactivation pattern but with a distinct, non-failure exit reason.
    if (templateName !== 'meeseeks.md' && !preTicket && noRunnableTicketsRemain(sessionDir)) {
      log('all tickets terminal (no runnable ticket and no all-Done completion) — clean exit before runIteration.');
      recordExitReason(statePath, 'all_tickets_terminal');
      finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'completed' });
      exitReason = 'all_tickets_terminal';
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

    // R-MWIS-2: main-loop idle-stall watchdog. Before each worker spawn, check whether
    // the loop has made no forward progress for longer than the bounded threshold while
    // in NO legitimate wait state (rate-limit wait, breaker OPEN, last_error, subprocess
    // errors). If wedged, emit a diagnostic event and self-recover (re-evaluate the
    // current ticket / re-spawn) rather than sit silently at 0% CPU.
    try {
      const idleDecision = evaluateMuxIdleStallWatchdog({
        active: state.active === true,
        nowMs: muxNow(),
        lastProgressMs: lastProgressEpoch,
        thresholdSeconds: idleStallThresholdSeconds,
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        rateLimitWaiting: fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
        circuitBreakerExecutable: !cbEnabled || !cbState || canExecute(cbState),
        lastError: state.last_error ?? null,
        // mux state.json carries last_subprocess_error (ErrorRecord|null), the
        // worker-error wait-state signal; treat a present record as 1 accumulated error.
        consecutiveSubprocessErrors: state.last_subprocess_error != null ? 1 : 0,
      });
      if (idleDecision.stalled) {
        // L2: bound consecutive self-recoveries. The streak increments per stall;
        // a single recovery that clears the wedge advances the loop (resetting the
        // streak), but a loop that re-arms the stall every pass climbs the streak
        // and escalates once it exceeds the cap rather than spinning forever.
        idleStallRecoveryCount += 1;
        if (evaluateIdleStallRecoveryCap(idleStallRecoveryCount, idleStallRecoveryCap)) {
          const msg = `[idle-stall] self-recovery exceeded cap (${idleStallRecoveryCount} > ${idleStallRecoveryCap}) — escalating idle_stall_unrecoverable at iteration ${iteration}`;
          log(msg);
          process.stderr.write(`[mux-runner] ${msg}\n`);
          recordExitReason(statePath, 'idle_stall_unrecoverable');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'idle_stall_unrecoverable';
          break;
        }
        log(`[idle-stall] no forward progress for ${idleDecision.idleSeconds}s (>= ${idleStallThresholdSeconds}s) with clean wait-state — emitting mux_idle_stall_detected and self-recovering (attempt ${idleStallRecoveryCount}/${idleStallRecoveryCap})`);
        process.stderr.write(`[mux-runner] idle-stall watchdog: ${idleDecision.idleSeconds}s idle, re-evaluating current ticket\n`);
        logActivity({
          event: 'mux_idle_stall_detected',
          source: 'pickle',
          session: path.basename(sessionDir),
          iteration,
          gate_payload: {
            threshold_seconds: idleStallThresholdSeconds,
            idle_seconds: idleDecision.idleSeconds,
            observed_iteration: curIter,
            current_ticket: state.current_ticket ?? null,
            step: typeof state.step === 'string' ? state.step : 'unknown',
          },
        });
        // R-MWIS-3: before self-recovering past the current ticket, commit any
        // gate-passing uncommitted deliverable via the existing #99 R-WCUC path so
        // the re-select/relaunch below cannot strand completed work.
        // AC-2 fail-safe: missing working_dir must halt this git-mutating commit,
        // never fall back to process.cwd() (the real repo).
        if (!state.working_dir) {
          recordExitReason(statePath, 'state_working_dir_missing');
          safeDeactivate(statePath);
          exitReason = 'state_working_dir_missing';
          break;
        }
        commitGatePassingDeliverableOnExitPath({
          sessionDir,
          statePath,
          workingDir: state.working_dir,
          ticketId: state.current_ticket ?? null,
          extensionRoot,
          flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          log,
        });
        // Self-recovery: re-evaluate the current ticket so the next pass re-selects a
        // pending ticket and re-spawns a worker. Reset the stall trackers + progress
        // epoch so the watchdog re-arms cleanly. Mirrors the recovery-advanced reset.
        const nextPending = findNextPendingTicketId(sessionDir);
        updateMuxLifecycleState(statePath, { currentTicket: nextPending ?? null });
        lastStateIteration = -1;
        stallCount = 0;
        lastProgressEpoch = muxNow();
        continue;
      }
    } catch (err) {
      // Watchdog is best-effort — never crash the loop on a watchdog failure.
      log(`idle-stall watchdog threw (ignored): ${safeErrorMessage(err)}`);
    }

    // Per-spawn codegraph staleness sync (fail-open — bounded by sync_timeout_ms in the service).
    if (cgService !== null) {
      if (shouldSyncCodegraph(cgDbPath, cgSettings.staleness_max_age_minutes)) {
        try { await cgService.sync(); } catch { /* degrade already emitted by the service */ }
      }
      cgTicketCount = collectTickets(sessionDir).filter((t) => t.status === 'Done').length;
    }

    const iterWorkingDir = state.working_dir || process.cwd();
    const preIterSha = readHeadCommit(iterWorkingDir);
    // 90574654: iteration-window start — freshness base for silent-death salvage probes.
    const iterStartMs = Date.now();
    // R-WSWA-2: snapshot the per-ticket review/conformance artifact count BEFORE the
    // worker spawn; the AFTER snapshot + delta persistence happen once it exits.
    const apTicketId = state.current_ticket || null;
    // AC-A4 (B-RRH): a large-tier ticket's first N spawns credit early-phase
    // (research/plan) artifacts as progress. Compute the flag from the PRIOR
    // per-ticket spawn_count so the BEFORE/AFTER counts use the same prefix set.
    const apPriorSpawnCount = (apTicketId && state.worker_artifact_progress?.[apTicketId]?.spawn_count) || 0;
    const apCreditEarlyPhases = apTicketId
      ? resolveCreditEarlyPhases(sessionDir, apTicketId, apPriorSpawnCount, resolveWmwEarlyPhaseK())
      : false;
    const apBeforeCount = apTicketId ? countWorkerArtifacts(path.join(sessionDir, apTicketId), { creditEarlyPhases: apCreditEarlyPhases }) : 0;
    const outcome = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel).catch(
      (err: unknown): Awaited<ReturnType<typeof runIteration>> => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`runIteration threw (treating as spawn error): ${msg}`);
        process.stderr.write(`[mux-runner] runIteration threw: ${msg}\n`);
        return { completion: 'error', timedOut: false, exitCode: null, wallSeconds: 0 } as Awaited<ReturnType<typeof runIteration>>;
      }
    );
    const result = outcome.completion;

    // R-MWIS-3: worker-exit path. A silent/0-byte worker exit may leave a
    // gate-passing deliverable uncommitted in the tree; route it through the
    // existing #99 R-WCUC commit path BEFORE the loop advances (a clean-tree
    // relaunch would otherwise discard it). No-op when the tree is clean, the gate
    // is red, or the model already flipped the ticket terminal.
    // AC-2 fail-safe: missing working_dir must halt this git-mutating commit,
    // never fall back to process.cwd() (the real repo). The guard sits OUTSIDE
    // the best-effort try so the break targets the main loop (a break inside the
    // try would still target the loop, but the catch must not swallow the halt).
    if (!state.working_dir) {
      recordExitReason(statePath, 'state_working_dir_missing');
      safeDeactivate(statePath);
      exitReason = 'state_working_dir_missing';
      break;
    }
    try {
      const exitCommit = commitGatePassingDeliverableOnExitPath({
        sessionDir,
        statePath,
        workingDir: state.working_dir,
        ticketId: previousTicket,
        extensionRoot,
        flags: (state.flags as Record<string, unknown> | undefined) ?? null,
        log,
      });
      if (exitCommit.committed) {
        lastProgressEpoch = muxNow();
        // L2: a committed deliverable is genuine forward progress — reset the streak.
        idleStallRecoveryCount = 0;
      }
    } catch { /* best-effort — never block iteration on exit-path commit */ }

    // AC-A5 (B-RRH): a rate-limited spawn (rate_limit_wait.json present OR the
    // iteration log shows a 429) OR a spawn within breaker-recovery grace must NOT
    // increment the no-progress counter (B-RLAR-D2 429-spawn counter poisoning).
    // Fail-open: any probe error → not suppressed.
    let apSuppressIncrement = false;
    try {
      const apRateLimited =
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking probe (mirrors the rate_limit_wait check above)
        fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json'))
        || detectRateLimitInLog(path.join(sessionDir, `tmux_iteration_${iteration}.log`)).limited;
      const apBreakerGrace = isWithinBreakerRecoveryGrace(
        cbState,
        resolveBreakerRecoveryGraceSeconds(loadPickleSettingsBag(extensionRoot)),
        Date.now(),
      );
      apSuppressIncrement = apRateLimited || apBreakerGrace;
    } catch { /* best-effort — never block iteration on rate-limit/breaker probing */ }

    // R-WSWA-2: persist the post-spawn artifact-count delta and emit
    // worker_artifact_progress_zero at exactly K consecutive zero-delta spawns.
    // AC-A3 (B-RRH): scope the source-tree signature to scope.json:allowed_paths so a
    // peer session's dirty prds/ file is absent from the signature (B-HRPW).
    let apProgressResult: { spawnCount: number; lastArtifactCount: number; zeroProgressCount: number; fired: boolean; doneGuard: boolean; incrementSuppressed: boolean } | null = null;
    try {
      if (apTicketId) apProgressResult = recordWorkerArtifactProgress(statePath, sessionDir, apTicketId, apBeforeCount, {
        iteration,
        log,
        workingDir: state.working_dir || process.cwd(),
        sourceSignatureFn: (wd) => computeScopedSourceTreeSignature(wd, path.join(sessionDir, 'scope.json')),
        creditEarlyPhases: apCreditEarlyPhases,
        suppressIncrement: apSuppressIncrement,
      });
    } catch { /* best-effort observability — never block iteration on progress tracking */ }
    // L2: a worker that produced NEW artifacts (non-zero delta) made genuine
    // progress — reset the consecutive idle-stall recovery streak.
    if (apProgressResult && apProgressResult.zeroProgressCount === 0) idleStallRecoveryCount = 0;

    // AC-A1 (B-RRH): a Done ticket with completion evidence that produced no new
    // artifacts is NOT stuck — reset (handled in recordWorkerArtifactProgress), clear
    // current_ticket, advance, no increment (B-LERD: run-exit on a Done ticket).
    if (templateName !== 'meeseeks.md' && apTicketId && apProgressResult?.doneGuard) {
      log(`[done-guard] ticket ${apTicketId} is Done with completion evidence — counter reset, advancing without charge`);
      updateMuxLifecycleState(statePath, { currentTicket: null });
      continue;
    }

    // R-WSWA-3: at PICKLE_WMW_SKIP_K (default 5) consecutive zero-progress spawns, flip the
    // ticket to Failed/oversized_no_progress (dirty tree preserved) and advance the loop.
    const skipK = resolveWmwSkipK();
    if (apTicketId && apProgressResult && apProgressResult.zeroProgressCount >= skipK) {
      // AC-R-WMNP-4: route the terminal no-progress trigger through the SAME
      // RecoveryController ladder as closer_handoff_terminal BEFORE the bare Failed
      // flip / respawn. A near-green diff (fix-forward-trivial / execute-converged-plan
      // / auto-split) advances the ticket instead of being respawned indefinitely;
      // only a genuinely exhausted ladder escalates to recovery_exhausted. A
      // fall_through (nothing to recover) proceeds to the existing terminal flip.
      if (templateName !== 'meeseeks.md') {
        // AC-2 fail-safe: missing working_dir must halt this git-mutating
        // recovery call, never fall back to process.cwd() (the real repo).
        if (!state.working_dir) {
          recordExitReason(statePath, 'state_working_dir_missing');
          safeDeactivate(statePath);
          exitReason = 'state_working_dir_missing';
          break;
        }
        const wmwRecovery = attemptRecoveryBeforeTerminal({
          sessionDir,
          statePath,
          extensionRoot,
          workingDir: state.working_dir,
          ticketId: apTicketId,
          iteration,
          flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          log,
        });
        if (wmwRecovery.kind === 'advanced') {
          log(`recovery: ${wmwRecovery.strategy} advanced ${apTicketId} before wmw-auto-skip Failed flip — continuing.`);
          // Reset the zero-progress counter so a recovered ticket is not re-skipped on the next spawn.
          try {
            sm.update(statePath, s => {
              const entry = s.worker_artifact_progress?.[apTicketId];
              if (entry) entry.zero_progress_count = 0;
            });
          } catch { /* best-effort */ }
          lastStateIteration = -1;
          stallCount = 0;
          continue;
        }
        if (wmwRecovery.kind === 'exhausted') {
          // AC-A2 (B-RRH): per-ticket ladder exhaustion advances to the next runnable
          // Todo (emitting ticket_ladder_exhausted) instead of killing the whole run;
          // run-exit only when no runnable ticket remains.
          const ladderAction = advanceOrExitOnLadderExhaustion({
            sessionDir,
            statePath,
            ticketId: apTicketId,
            reason: `recovery_exhausted: ${wmwRecovery.reason}`,
            log,
          });
          if (ladderAction === 'advance') {
            log(`ticket_ladder_exhausted: ${apTicketId} (${wmwRecovery.reason}) — advancing to next runnable ticket at iteration ${iteration}.`);
            lastStateIteration = -1;
            stallCount = 0;
            continue;
          }
          log(`recovery_exhausted: ladder exhausted for ${apTicketId} (${wmwRecovery.reason}) and no runnable ticket remains — exiting at iteration ${iteration}.`);
          recordExitReason(statePath, 'recovery_exhausted');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'recovery_exhausted';
          break;
        }
        // fall_through → proceed to the existing terminal Failed flip below.
      }
      // 7eb9fa20: evidence-backed flip-intents are suppressed (held) instead of
      // flipped. Evidence absent → archive a dirty tree first, then flip (the
      // wmw flip itself preserves the dirty tree; archival guards the runner's
      // downstream reset paths). Cap reached → existing no-progress halt.
      {
        const wmwWorkingDir = state.working_dir || process.cwd();
        const ffDecision = evaluateFailedFlipSuppression({
          sessionDir,
          statePath,
          ticketId: apTicketId,
          workingDir: wmwWorkingDir,
          iteration,
          callsite: 'wmw_auto_skip',
          windowStartMs: iterStartMs,
          windowEndMs: Date.now(),
          preSha: preIterSha,
          log,
        });
        if (ffDecision.action === 'suppress') {
          const holdMsg = `[wmw-auto-skip] ticket ${apTicketId}: Failed flip suppressed (${ffDecision.evidence}) — ticket held, status preserved`;
          log(holdMsg);
          process.stderr.write(`${holdMsg}\n`);
          // Clear current_ticket so the next iteration selects past the held
          // ticket (resolvePreTicket also refuses to re-engage a held ticket).
          updateMuxLifecycleState(statePath, { currentTicket: null });
          continue;
        }
        if (ffDecision.action === 'escalate') {
          const capMsg = `[wmw-auto-skip] ticket ${apTicketId}: suppression cap ${ffDecision.cap} reached.`;
          log(capMsg);
          process.stderr.write(`${capMsg}\n`);
          // AC-A2 (B-RRH): suppression-cap exhaustion advances while a runnable Todo
          // remains; run-exit only when none remains.
          const ladderAction = advanceOrExitOnLadderExhaustion({
            sessionDir,
            statePath,
            ticketId: apTicketId,
            reason: `suppression_cap_reached: ${ffDecision.cap}`,
            log,
          });
          if (ladderAction === 'advance') {
            log(`ticket_ladder_exhausted: ${apTicketId} (suppression cap ${ffDecision.cap}) — advancing to next runnable ticket at iteration ${iteration}.`);
            lastStateIteration = -1;
            stallCount = 0;
            continue;
          }
          log(`recovery_exhausted: suppression cap reached for ${apTicketId} and no runnable ticket remains — halting.`);
          recordExitReason(statePath, 'recovery_exhausted');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'recovery_exhausted';
          break;
        }
        archiveDirtyTreeBeforeFlip({ workingDir: wmwWorkingDir, sessionDir, ticketId: apTicketId, log });
      }
      const skipMsg = `[wmw-auto-skip] ticket ${apTicketId}: ${apProgressResult.zeroProgressCount}/${skipK} consecutive zero-progress spawns — flipping to Failed/oversized_no_progress`;
      log(skipMsg);
      process.stderr.write(`${skipMsg}\n`);
      try {
        updateTicketFrontmatter(apTicketId, sessionDir, { status: 'Failed', completion_commit: null });
        const tfPath = ticketFilePath(sessionDir, apTicketId);
        const tfRaw = fs.readFileSync(tfPath, 'utf-8');
        const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', 'oversized_no_progress');
        if (tfUpdated) fs.writeFileSync(tfPath, tfUpdated);
      } catch (err) { log(`[wmw-auto-skip] frontmatter flip failed (ignored): ${safeErrorMessage(err)}`); }
      try {
        writeActivityEntry(statePath, {
          event: 'worker_auto_skip_oversized',
          ts: new Date().toISOString(),
          ticket: apTicketId,
          gate_payload: {
            spawn_count: apProgressResult.spawnCount,
            zero_progress_count: apProgressResult.zeroProgressCount,
            skip_k: skipK,
            failure_reason: 'oversized_no_progress',
          },
        });
      } catch { /* best-effort */ }
      // AC-R-WMNP-3: a terminal no-progress flip clears current_ticket (+ the
      // per-ticket cache, via updateMuxLifecycleState's ticket-change path) so the
      // next iteration's resolvePreTicket selects the next pending ticket rather
      // than re-engaging the just-flipped Failed ticket (order-deadlock).
      updateMuxLifecycleState(statePath, { currentTicket: null });
      continue;
    }

    // R-WSE-2: detect partial lifecycle exit (research-review APPROVED, downstream artifacts missing)
    // 90574654: sub-classify the exit (log_empty → worker_silent_death |
    // log_truncated → worker_partial_lifecycle_exit) and route BOTH sub-classes
    // into the ONE salvage-first recovery policy. hold/respawn both continue the
    // loop (hold drew no cap and left the ticket untouched — H4 lands the real
    // hold semantics in 7eb9fa20; respawn lets the manager re-spawn under the
    // drawn-down persistent cap). Cap exhausted falls through to the existing
    // no-progress halt shape. Fail-open: any error → log + existing behavior.
    // R-WSE-3: emit stderr breadcrumb when ticket Failed after research APPROVED
    try {
      const iterTicket = state.current_ticket;
      if (iterTicket) {
        const plExit = checkPartialLifecycleExit(sessionDir, statePath, iterTicket);
        if (plExit && plExit.subClass) {
          const sdDecision = applySilentDeathRecoveryPolicy({
            sessionDir,
            statePath,
            ticketId: iterTicket,
            workingDir: iterWorkingDir,
            iteration,
            classification: plExit,
            preIterSha,
            iterationStartMs: iterStartMs,
            log,
          });
          if (sdDecision.action === 'halt') {
            log(`[silent-death] halting loop at iteration ${iteration}: respawn cap exhausted for ${iterTicket}.`);
            recordExitReason(statePath, sdDecision.exitReason);
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = sdDecision.exitReason;
            break;
          }
        }
      }
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
          // R-CXOR-1: detect HEAD regression — worker may have committed then git-reset to baseline.
          if (previousTicketStartCommit) {
            try {
              const hrResult = detectAndRecoverHeadRegression({
                ticketId: prevTicketInfo.id,
                workingDir: prevTicketInfo.working_dir || state.working_dir || process.cwd(),
                startCommit: previousTicketStartCommit,
                completionCommitSha: guard.sha || null,
                sessionDir,
                statePath,
                iteration,
                iterationStartMs: iterStartMs,
                log,
              });
              if (hrResult.action === 'suppression_cap_escalate') {
                // 7eb9fa20: cap reached with evidence — existing no-progress halt.
                const msg = `[failed-flip] suppression cap exhausted for ${prevTicketInfo.id} at head-regression — halting (recovery_exhausted).`;
                log(msg);
                process.stderr.write(`${msg}\n`);
                recordExitReason(statePath, 'recovery_exhausted');
                safeDeactivate(statePath);
                removeRunnerSessionMapEntry(statePath, log);
                return;
              }
            } catch (err) { log(`head-regression check failed (ignored): ${safeErrorMessage(err)}`); }
          }
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
      // R-WTB-A1: check artifact progress before halting — if the worker produced new
      // artifacts or commits within the no-progress window, reset the counter and continue.
      const noProgressWindowS = resolveNoProgressWindowSeconds();
      const ticketDir = ticketForTimeout ? path.join(sessionDir, ticketForTimeout) : null;
      const scopeJsonPath = path.join(sessionDir, 'scope.json');
      let progressDetected = false;
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      if (ticketDir && fs.existsSync(ticketDir)) {
        const pResult = detectArtifactProgress(ticketDir, lastArtifactProgressSnapshot, {
          workingDir: state.working_dir || sessionDir,
          scopeJsonPath,
        });
        lastArtifactProgressSnapshot = { latestMtimeEpoch: pResult.latestMtimeEpoch, latestCommitSha: pResult.latestCommitSha };
        if (pResult.progressed) {
          progressDetected = true;
          writeActivityEntry(statePath, {
            event: 'ticket_timeout_progress_extension',
            ts: new Date().toISOString(),
            ticket: ticketForTimeout,
            gate_payload: {
              latest_mtime_epoch: pResult.latestMtimeEpoch,
              latest_commit_sha: pResult.latestCommitSha,
              timeout_count: timeoutCount,
              no_progress_window_seconds: noProgressWindowS,
            },
          });
          timeoutCount = 1;
          lastTimeoutTicket = ticketForTimeout;
          log(`[info] Artifact progress detected for ticket ${ticketForTimeout} — timeout counter reset (window: ${noProgressWindowS}s)`);
        }
      }
      if (!progressDetected) {
        writeActivityEntry(statePath, {
          event: 'ticket_timeout_halted_no_progress',
          ts: new Date().toISOString(),
          ticket: ticketForTimeout,
          gate_payload: {
            timeout_count: timeoutCount,
            no_progress_window_seconds: noProgressWindowS,
            latest_mtime_epoch: lastArtifactProgressSnapshot.latestMtimeEpoch,
            latest_commit_sha: lastArtifactProgressSnapshot.latestCommitSha,
          },
        });
        log(`Timeout halt: ticket ${ticketForTimeout} timed out ${timeoutCount} consecutive iterations`);
        executeTimeoutHalt({ statePath, sessionDir, ticketNow: ticketForTimeout, timeoutCount });
        exitReason = 'timeout_repeat';
        break;
      }
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
    } else if (result === 'inactive') {
      if (detectManagerInactiveExit(outcome)) {
        let postState: State = state;
        try { postState = readRunnerState(statePath); } catch { /* fall back */ }
        const inactiveExitKind = classifyManagerRelaunchExit(postState, outcome, iterLogFile, runnerMaxTurns);
        if (inactiveExitKind === 'codex_session_inactive') {
          const inactiveDecision = evaluateManagerRelaunch(postState, collectTickets(sessionDir), cbState, inactiveExitKind);
          if (inactiveDecision.reason === 'time_limit') {
            log('Time limit reached. Exiting.');
            finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
            exitReason = 'limit';
            break;
          }
          if (inactiveDecision.shouldRelaunch) {
            const noProgress = checkAndUpdateCodexManagerNoProgress(statePath, inactiveDecision.pendingCount, log);
            if (noProgress.halt) {
              // AC-2 fail-safe: missing working_dir must halt this git-mutating
              // recovery seam, never fall back to process.cwd() (the real repo).
              if (!postState.working_dir && !state.working_dir) {
                recordExitReason(statePath, 'state_working_dir_missing');
                safeDeactivate(statePath);
                exitReason = 'state_working_dir_missing';
                break;
              }
              // R-CHTS-CODEX: route through recovery seam before parking.
              const codexRecovery = haltOrRecoverCodexNoProgress({
                statePath,
                sessionDir,
                extensionRoot,
                workingDir: postState.working_dir || state.working_dir,
                iteration,
                log,
              });
              if (codexRecovery.kind === 'advanced') {
                lastStateIteration = -1;
                stallCount = 0;
                await sleep(1000);
                continue;
              }
              if (codexRecovery.kind === 'recovery_exhausted') {
                recordExitReason(statePath, 'recovery_exhausted');
                safeDeactivate(statePath);
                removeRunnerSessionMapEntry(statePath, log);
                exitReason = 'recovery_exhausted';
                break;
              }
              // kind === 'halt' → fall through to existing park.
              log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
              logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackendFromStateFileWithSource(statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: inactiveDecision.pendingCount });
              recordExitReason(statePath, 'codex_manager_no_progress');
              safeDeactivate(statePath);
              removeRunnerSessionMapEntry(statePath, log);
              exitReason = 'codex_manager_no_progress';
              break;
            }
            const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
            log(`${relaunchBackend} manager subprocess exited via ${inactiveExitKind} with ${inactiveDecision.pendingCount} ticket(s) still pending — relaunching (count ${inactiveDecision.nextRelaunchCount}/${inactiveDecision.cap}).`);
            recordManagerRelaunch(statePath, sessionDir, inactiveDecision, iteration, log);
            lastStateIteration = -1;
            stallCount = 0;
            await sleep(1000);
            continue;
          }
        }
      }
      log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break;
    } else if (result === 'error') {
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
        const noProgress = checkAndUpdateCodexManagerNoProgress(statePath, relaunchDecision.pendingCount, log);
        if (noProgress.halt) {
          // AC-2 fail-safe: missing working_dir must halt this git-mutating
          // recovery seam, never fall back to process.cwd() (the real repo).
          if (!postState.working_dir && !state.working_dir) {
            recordExitReason(statePath, 'state_working_dir_missing');
            safeDeactivate(statePath);
            exitReason = 'state_working_dir_missing';
            break;
          }
          // R-CHTS-CODEX: route through recovery seam before parking.
          const codexRecovery = haltOrRecoverCodexNoProgress({
            statePath,
            sessionDir,
            extensionRoot,
            workingDir: postState.working_dir || state.working_dir,
            iteration,
            log,
          });
          if (codexRecovery.kind === 'advanced') {
            lastStateIteration = -1;
            stallCount = 0;
            await sleep(1000);
            continue;
          }
          if (codexRecovery.kind === 'recovery_exhausted') {
            recordExitReason(statePath, 'recovery_exhausted');
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = 'recovery_exhausted';
            break;
          }
          // kind === 'halt' → fall through to existing park.
          log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
          logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackendFromStateFileWithSource(statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: relaunchDecision.pendingCount });
          recordExitReason(statePath, 'codex_manager_no_progress');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'codex_manager_no_progress';
          break;
        }
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

  emitCgSessionSummary();
  closeCgService();

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
