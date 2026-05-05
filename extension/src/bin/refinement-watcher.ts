#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, formatTime, drainStreamJsonLines, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { processLine } from './log-watcher.js';

const ROLES = ['requirements', 'codebase', 'risk-scope'] as const;
type RoleId = (typeof ROLES)[number];

const ROLE_ICONS: Record<RoleId, string> = {
  requirements: '📋',
  codebase: '🔍',
  'risk-scope': '⚠️',
};

const ROLE_COLORS: Record<RoleId, string> = {
  requirements: Style.CYAN,
  codebase: Style.GREEN,
  'risk-scope': Style.YELLOW,
};

const sm = new StateManager();

interface WorkerState {
  logPath: string | null;
  offset: number;
  lineBuf: string;
  cycle: number;
  done: boolean; // analysis_<role>.md exists
}

function discoverLatestWorkerLog(refinementDir: string, roleId: RoleId): { logPath: string; cycle: number } | null {
  try {
    const files = fs.readdirSync(refinementDir)
      .filter((f) => f.startsWith(`worker_${roleId}_c`) && f.endsWith('.log'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10);
        const numB = parseInt(b.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10);
        return (numA || 0) - (numB || 0);
      });
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    const cycle = parseInt(latest.replace(`worker_${roleId}_c`, '').replace('.log', ''), 10) || 1;
    return { logPath: path.join(refinementDir, latest), cycle };
  } catch {
    return null;
  }
}

function roleStatus(refinementDir: string, roleId: RoleId): '⏳' | '✅' | '❌' {
  const analysisFile = path.join(refinementDir, `analysis_${roleId}.md`);
  if (!fs.existsSync(analysisFile)) return '⏳';
  // Check if the analysis has content (not just created empty)
  try {
    const stat = fs.statSync(analysisFile);
    return stat.size > 100 ? '✅' : '⏳';
  } catch {
    return '⏳';
  }
}

function initWorkers(): Map<RoleId, WorkerState> {
  const workers = new Map<RoleId, WorkerState>();
  for (const role of ROLES) {
    workers.set(role, { logPath: null, offset: 0, lineBuf: '', cycle: 0, done: false });
  }
  return workers;
}

function emitWorkerText(role: RoleId, text: string, width: number, prefix: string): void {
  const { RESET: r, DIM: d } = Style;
  const color = ROLE_COLORS[role];
  const icon = ROLE_ICONS[role];
  for (const line of text.split('\n')) {
    const truncated = line.length > width ? line.slice(0, width - 3) + '…' : line;
    process.stdout.write(`${prefix}${color}${icon} ${d}${role}${r} ${truncated}\n`);
  }
}

function drainFinalWorkerLogs(workers: Map<RoleId, WorkerState>, width: number): void {
  for (const role of ROLES) {
    const ws = workers.get(role)!;
    if (!ws.logPath) continue;
    drainStreamJsonLines(ws.logPath, ws.offset, ws.lineBuf, processLine, (text: string) => {
      emitWorkerText(role, text, width, '');
    });
  }
}

function renderManifestSummary(manifest: Record<string, unknown>, startTime: number, sep: string): void {
  const { BOLD: b, RESET: r, DIM: d } = Style;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  process.stdout.write(`\n${sep}\n`);
  process.stdout.write(`${b}${Style.GREEN}🥒 Refinement Complete${r} ${d}(${formatTime(elapsed)})${r}\n`);
  process.stdout.write(`   Cycles: ${manifest.cycles_completed}/${manifest.cycles_requested}\n`);
  const manifestWorkers = Array.isArray(manifest.workers) ? manifest.workers : [];
  for (const w of manifestWorkers) {
    if (!w || typeof w !== 'object') continue;
    const worker = w as Record<string, unknown>;
    const icon = worker.success ? '✅' : '❌';
    process.stdout.write(`   ${icon} ${String(worker.role ?? 'unknown')}\n`);
  }
  process.stdout.write(`\n`);
}

function maybePrintStatusHeader(refinementDir: string, elapsed: number): void {
  const { RESET: r } = Style;
  const statusParts = ROLES.map((role) => {
    const status = roleStatus(refinementDir, role);
    const color = ROLE_COLORS[role];
    return `${status} ${color}${role}${r}`;
  }).join(' │ ');
  process.stdout.write(`\n${Style.DIM}[${formatTime(elapsed)}]${r} ${statusParts}\n`);
}

function drainRoleLog(
  refinementDir: string,
  role: RoleId,
  ws: WorkerState,
  width: number,
  sep: string,
  lastRole: RoleId | null,
): { anyOutput: boolean; lastRole: RoleId | null } {
  const discovered = discoverLatestWorkerLog(refinementDir, role);
  if (!discovered) return { anyOutput: false, lastRole };

  let currentLastRole = lastRole;
  if (discovered.logPath !== ws.logPath) {
    ws.logPath = discovered.logPath;
    ws.offset = 0;
    ws.lineBuf = '';
    ws.cycle = discovered.cycle;
    const cycleLabel = ws.cycle > 1 ? ` (Cycle ${ws.cycle})` : '';
    process.stdout.write(`\n${sep}\n${Style.BOLD}${ROLE_COLORS[role]}${ROLE_ICONS[role]} ${role}${cycleLabel}${Style.RESET}\n${sep}\n`);
    currentLastRole = role;
  }

  const prevOffset = ws.offset;
  const result = drainStreamJsonLines(ws.logPath, ws.offset, ws.lineBuf, processLine, (text: string) => {
    if (currentLastRole !== role) {
      currentLastRole = role;
      process.stdout.write(`${ROLE_COLORS[role]}${Style.DIM}── ${ROLE_ICONS[role]} ${role} ──${Style.RESET}\n`);
    }
    for (const line of text.split('\n')) {
      const truncated = line.length > width ? line.slice(0, width - 3) + '…' : line;
      process.stdout.write(`  ${truncated}\n`);
    }
  });
  ws.offset = result.offset;
  ws.lineBuf = result.lineBuf;

  if (!ws.done && roleStatus(refinementDir, role) === '✅') {
    ws.done = true;
    process.stdout.write(`  ${Style.GREEN}✅ ${role} analysis complete${Style.RESET}\n`);
  }
  return { anyOutput: result.offset > prevOffset, lastRole: currentLastRole };
}

/**
 * R-MWR-5: refinement-watcher polls indefinitely until the session is
 * provably done. The session is provably done when state.json shows
 * `active=false` AND `step` has advanced past `prd` (so we are not
 * mid-refinement). State.json missing or unreadable also counts as
 * "done" — the test fixtures lean on this for clean teardown without
 * hand-rolling a state.json.
 *
 * Pre-R-MWR-5 the helper additionally required NO manifest after a 3s
 * sleep; that was a relic of the "break on first manifest sighting"
 * design. Under R-MWR-5 the watcher renders the manifest summary BUT
 * keeps polling so manifest rewrites are consumed without exit, so the
 * 3s manifest re-check no longer makes sense — when the session is
 * inactive the watcher should exit regardless of whether a manifest
 * has been written.
 */
async function shouldStopForInactiveSession(sessionDir: string): Promise<boolean> {
  const statePath = path.join(sessionDir, 'state.json');
  let state: { active?: unknown; step?: unknown };
  try {
    state = sm.read(statePath) as { active?: unknown; step?: unknown };
  } catch {
    return true;
  }
  if (state.active !== false) return false;
  if (state.step === 'prd') return false;
  return true;
}

/**
 * R-MWR-5: read the manifest and re-render the summary when its content
 * changes (cycle 1 → cycle 2 rewrite). Returns the new lastManifestKey
 * and whether the summary has been rendered at least once. Extracted to
 * keep main()'s cyclomatic complexity within the lint cap.
 */
function consumeManifestRewrite(
  manifestPath: string,
  workers: Map<RoleId, WorkerState>,
  width: number,
  sep: string,
  startTime: number,
  lastManifestKey: string,
  summaryRendered: boolean,
): { lastManifestKey: string; summaryRendered: boolean } {
  const manifest = readRecoverableJsonObject(manifestPath) as Record<string, unknown> | null;
  if (!manifest) return { lastManifestKey, summaryRendered };
  const manifestKey = JSON.stringify(manifest);
  if (manifestKey === lastManifestKey) return { lastManifestKey, summaryRendered };
  drainFinalWorkerLogs(workers, width);
  renderManifestSummary(manifest, startTime, sep);
  return { lastManifestKey: manifestKey, summaryRendered: true };
}

async function main() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node refinement-watcher.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    process.stdout.write('\nDetached.\n');
    process.exit(0);
  });

  const refinementDir = path.join(sessionDir, 'refinement');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

  const { BOLD: b, DIM: d, RESET: r, MAGENTA: m } = Style;
  const width = () => Math.min((process.stdout.columns || 60) - 2, 80);
  const sep = () => `${d}${'─'.repeat(width())}${r}`;

  process.stdout.write(`\n${b}${m}🥒 Pickle Rick — Refinement Team Monitor${r}\n${sep()}\n`);

  const workers = initWorkers();

  const startTime = Date.now();
  let lastRole: RoleId | null = null;
  let lastStatusPrint = 0;
  // R-MWR-5: track the last manifest content we rendered so a rewrite
  // (e.g., cycle 1 manifest replaced by cycle 2 manifest) re-renders
  // instead of being silently consumed or causing an exit.
  let lastManifestKey = '';
  let summaryRendered = false;

  while (true) {
    // R-MWR-5: read manifest each tick. First sighting renders the
    // summary; subsequent rewrites that change the content re-render.
    // We DO NOT break on manifest sighting — exit is owned exclusively
    // by shouldStopForInactiveSession. This is the documented
    // contract: "polls indefinitely; rewrite consumed without exit".
    ({ lastManifestKey, summaryRendered } = consumeManifestRewrite(
      manifestPath, workers, width(), sep(), startTime, lastManifestKey, summaryRendered,
    ));

    // Wait for refinement directory to exist
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(refinementDir)) {
      // Check the inactive-session exit BEFORE the awaiting-spinner
      // sleep so a missing-state-fixture test path can exit promptly.
      if (await shouldStopForInactiveSession(sessionDir)) {
        if (!summaryRendered) {
          process.stdout.write(`\n${sep()}\n${Style.YELLOW}⚠️  Session inactive with no manifest — refinement may have failed.${r}\n`);
        }
        break;
      }
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      process.stdout.write(`\r${d}Waiting for refinement workers... (${formatTime(elapsed)})${r}\x1b[K`);
      await sleep(1000);
      continue;
    }

    // Print status header every 10s
    const now = Date.now();
    const elapsed = Math.floor((now - startTime) / 1000);
    if (now - lastStatusPrint >= 10_000) {
      lastStatusPrint = now;
      maybePrintStatusHeader(refinementDir, elapsed);
    }

    // Discover and drain each worker's log
    let anyOutput = false;
    for (const role of ROLES) {
      const ws = workers.get(role)!;
      const drained = drainRoleLog(refinementDir, role, ws, width(), sep(), lastRole);
      lastRole = drained.lastRole;
      if (drained.anyOutput) anyOutput = true;
    }

    // Exit when state.json reports the session has ended (regardless
    // of manifest presence — see shouldStopForInactiveSession docs).
    if (await shouldStopForInactiveSession(sessionDir)) {
      if (!summaryRendered) {
        process.stdout.write(`\n${sep()}\n${Style.YELLOW}⚠️  Session inactive with no manifest — refinement may have failed.${r}\n`);
      }
      break;
    }

    await sleep(anyOutput ? 200 : 500);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'refinement-watcher.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[refinement-watcher] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
