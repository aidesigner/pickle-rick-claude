import { execSync, execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { State, VALID_STEPS, LockError, SessionMapEntry, type ActivityEvent, type PickleSettings, type Backend } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { updateTicketStatusInTransaction } from './transaction-ticket-ops.js';

let stateWriteSeq = 0;

/** Extracts a string message from any thrown value. Never throws. */
/**
 * R-CNAR-8: Atomic clear of all five `current_ticket_*` per-ticket cache fields.
 * Call this at any site that writes `current_ticket = null` OR transitions
 * `current_ticket` to a new value. Without it, stale tier/budget/max-iter values
 * survive into the next ticket's run, and on `--resume` after a clean-success
 * exit (when the cache survives in state.json) the per-ticket cap-check trips
 * before any new ticket starts. R-CNAR-7 self-heals at iteration_start as a
 * safety net for state authored before this fix; this helper closes the leak
 * at every upstream site.
 *
 * Returns the count of fields cleared (0 = state was already clean). Idempotent.
 */
export function clearTicketCacheFields(state: { [k: string]: unknown }): number {
  let cleared = 0;
  for (const key of [
    'current_ticket_tier',
    'current_ticket_budget',
    'current_ticket_max_iterations',
    'current_ticket_worker_timeout_seconds',
    'current_ticket_budget_start_iteration',
  ]) {
    if (state[key] !== undefined) {
      delete state[key];
      cleared++;
    }
  }
  return cleared;
}

export function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const Style = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  MAGENTA: '\x1b[35m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
} as const;

type StyleColor = keyof typeof Style;

export function getWidth(maxW: number = 90): number {
  const cols = process.stdout.columns || 80;
  return Math.min(cols - 4, maxW);
}

export function getHeight(fallback: number = 24): number {
  const rows = process.stdout.rows;
  return rows && rows > 0 ? rows : fallback;
}

export function wrapText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [text];
  const lines: string[] = [];
  const words = text.split(' ');
  let currentLine = '';

  for (const word of words) {
    if ((currentLine === '' ? word : currentLine + ' ' + word).length <= width) {
      currentLine += (currentLine === '' ? '' : ' ') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      while (currentLine.length > width) {
        lines.push(currentLine.slice(0, width));
        currentLine = currentLine.slice(width);
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}

export const DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 240_000;

export function printMinimalPanel(
  title: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  colorName: StyleColor = 'GREEN',
  icon: string = '🥒'
) {
  const width = getWidth();
  const c = Style[colorName] || Style.GREEN;
  const r = Style.RESET;
  const b = Style.BOLD;
  const d = Style.DIM;

  if (title) {
    process.stdout.write(`\n${c}${icon} ${b}${title}${r}\n`);
  }

  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length === 0) {
    process.stdout.write('\n');
    return;
  }

  const maxKeyLen = Math.max(...fieldKeys.map((k) => k.length)) + 1;

  for (const [key, value] of Object.entries(fields)) {
    const valWidth = width - maxKeyLen - 5;
    const wrappedVal = wrapText(String(value), valWidth);

    process.stdout.write(
      `  ${d}${key + ':'}${' '.repeat(maxKeyLen - key.length - 1)}${r} ${wrappedVal[0]}\n`
    );
    for (let i = 1; i < wrappedVal.length; i++) {
      process.stdout.write(`  ${' '.repeat(maxKeyLen)} ${wrappedVal[i]}\n`);
    }
  }
  process.stdout.write('\n');
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/** Compact ISO stamp safe for use in file/dir names: `2026-04-27T20-15-30Z`. */
export function isoCompactStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}

/** Local calendar day key used for filenames/report buckets: `YYYY-MM-DD`. */
export function formatLocalDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const CANONICAL_EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');
const EXTENSION_ROOT_SENTINEL = path.join('extension', 'bin', 'log-watcher.js');
const INSTALL_ROOT_SENTINEL = '.pickle-install-root';
const EXTENSION_DIR_TEST = 'EXTENSION_DIR_TEST';

let extensionDirFallbackEmitted = false;

interface ShellError extends Error {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

function runArgvCmd(
  cmd: string[],
  options: { cwd?: string; check: boolean; capture: boolean }
): string {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (options.check && (result.status ?? 1) !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}\nError: ${result.stderr || ''}`);
  }
  return (result.stdout || '').trim();
}

function shellErrorOutput(error: unknown, stream: 'stderr' | 'stdout'): string {
  return error instanceof Error && stream in error
    ? String((error as ShellError)[stream] || '')
    : '';
}

function runShellCmd(
  cmd: string,
  options: { cwd?: string; check: boolean; capture: boolean }
): string {
  try {
    const stdout = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return (stdout || '').trim();
  } catch (error) {
    if (options.check) {
      const msg = shellErrorOutput(error, 'stderr') || safeErrorMessage(error);
      throw new Error(`Command failed: ${cmd}\nError: ${msg}`);
    }
    return shellErrorOutput(error, 'stdout').trim();
  }
}

export function runCmd(
  cmd: string | string[],
  options: { cwd?: string; check?: boolean; capture?: boolean } = {}
): string {
  const { cwd, check = true, capture = true } = options;

  // Array form: use spawnSync so each argument is passed verbatim (no shell splitting).
  // String form: use execSync via the shell (supports pipes, globs, etc.).
  if (Array.isArray(cmd)) {
    return runArgvCmd(cmd, { cwd, check, capture });
  }

  return runShellCmd(cmd, { cwd, check, capture });
}

/**
 * Returns the pickle-rick **package root** — `~/.claude/pickle-rick` — which
 * holds `pickle_settings.json`, `persona.md`, `szechuan-sauce-*-principles.md`,
 * `debug.log`, `templates/`, and the `extension/` code tree as a subdirectory.
 *
 * To reach the compiled JS (hooks/, services/, bin/), callers must join
 * `'extension'` themselves: `path.join(getExtensionRoot(), 'extension', 'bin', 'xxx.js')`.
 * The name is historical — it predates the `extension/` subdirectory layout.
 */
export function getExtensionRoot(): string {
  return resolveExtensionRoot(process.env.EXTENSION_DIR);
}

function resolveExtensionRoot(requestedRoot: string | undefined): string {
  if (!requestedRoot) return CANONICAL_EXTENSION_ROOT;
  if (extensionRootSentinelExists(requestedRoot)) return requestedRoot;
  if (allowsMissingExtensionSentinelForTests()) return requestedRoot;

  emitExtensionDirFallbackOnce(
    requestedRoot,
    CANONICAL_EXTENSION_ROOT,
    `missing sentinel ${path.join(requestedRoot, EXTENSION_ROOT_SENTINEL)}`,
  );
  return CANONICAL_EXTENSION_ROOT;
}

function extensionRootSentinelExists(extensionRoot: string): boolean {
  return fs.existsSync(path.join(extensionRoot, EXTENSION_ROOT_SENTINEL)) ||
         fs.existsSync(path.join(extensionRoot, INSTALL_ROOT_SENTINEL));
}

function allowsMissingExtensionSentinelForTests(): boolean {
  return process.env.NODE_ENV === 'test' && process.env[EXTENSION_DIR_TEST] === '1';
}

function emitExtensionDirFallbackOnce(requestedPath: string, fallbackPath: string, reason: string): void {
  if (extensionDirFallbackEmitted) return;
  extensionDirFallbackEmitted = true;

  process.stderr.write(
    `[pickle-rick] EXTENSION_DIR fallback: requested=${requestedPath} fallback=${fallbackPath} reason=${reason}\n`,
  );
  writeExtensionDirFallbackActivity(requestedPath, fallbackPath, reason);
}

function writeExtensionDirFallbackActivity(requestedPath: string, fallbackPath: string, reason: string): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event: ActivityEvent = {
      ts: ts.toISOString(),
      event: 'extension_dir_fallback',
      source: 'pickle',
      requested_path: requestedPath,
      fallback_path: fallbackPath,
      reason,
    };
    fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(`[pickle-rick] Failed to log extension_dir_fallback: ${safeErrorMessage(err)}\n`);
  }
}

function writePhantomSessionDemotedActivity(cwd: string, sessionPath: string): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event: ActivityEvent = {
      ts: ts.toISOString(),
      event: 'phantom_session_demoted',
      source: 'pickle',
      requested_path: cwd,
      session_path: sessionPath,
      exit_reason: 'orphan-session-dir-missing',
    };
    fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(`[pickle-rick] Failed to log phantom_session_demoted: ${safeErrorMessage(err)}\n`);
  }
}

function getCanonicalActivityDataRoot(): string {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

/** Test helper: resets process-level fallback emission guard. */
export function _resetExtensionDirFallbackForTests(): void {
  extensionDirFallbackEmitted = false;
}

/**
 * Root directory for pickle data that must NOT live under ~/.claude (Claude Code
 * gates ~/.claude writes with permission prompts). Session dirs, the jar queue,
 * worktrees, activity logs, metrics cache, and the session map all live here.
 *
 * Resolution order:
 *   1. PICKLE_DATA_ROOT (canonical explicit override)
 *   2. PICKLE_DATA_DIR (legacy explicit override — production or test)
 *   3. EXTENSION_DIR — ONLY when it's been pinned to a non-canonical path
 *      (test-harness convenience: tests redirect data into the same tmp dir
 *      they pin the extension root to). The hook dispatcher sets EXTENSION_DIR
 *      to the canonical install path (~/.claude/pickle-rick) in production,
 *      which would otherwise poison data resolution — every hook subprocess
 *      would read sessions from the install dir instead of the XDG data dir.
 *   4. ~/.local/share/pickle-rick (production default)
 */
export function getDataRoot(): string {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  const extDir = process.env.EXTENSION_DIR;
  if (extDir) {
    const canonicalExtDir = path.join(os.homedir(), '.claude/pickle-rick');
    if (path.resolve(extDir) !== path.resolve(canonicalExtDir)) return extDir;
  }
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

export function statusSymbol(status: string | null): string {
  const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
  if (s === 'done') return '[x]';
  if (s === 'in progress') return '[~]';
  if (s === 'skipped') return '[!]';
  return '[ ]';
}

/**
 * Safely extracts YAML frontmatter from a string without catastrophic regex backtracking.
 * Uses indexOf for delimiter search — O(n) regardless of content shape.
 * Returns the frontmatter body and byte offsets, or null if no valid block found.
 */
export function extractFrontmatter(content: string): { body: string; start: number; end: number } | null {
  // Support both Unix (\n) and Windows (\r\n) line endings
  const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLen === 0) return null;
  const closeIdx = content.indexOf('\n---', openLen);
  if (closeIdx === -1) return null;
  // +4 for '\n---', +1 more if followed by a newline to consume the full delimiter line
  const rawEnd = closeIdx + 4;
  const end = content[rawEnd] === '\n' ? rawEnd + 1 : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n' ? rawEnd + 2 : rawEnd;
  return { body: content.slice(openLen, closeIdx), start: 0, end };
}

export function readFrontmatterField(content: string, field: string): string | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  return raw.length > 0 ? raw : null;
}

function readFirstMarkdownHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

export function upsertFrontmatterField(content: string, field: string, value: string): string | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${field}: "${value}"`;
  if (new RegExp(`^${escaped}:\\s*(.+)$`, 'm').test(fm.body)) {
    const nextBody = fm.body.replace(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'), line);
    return content.slice(0, fm.start) + `---\n${nextBody}\n---\n` + content.slice(fm.end);
  }
  const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
  if (closingNewline === -1) return null;
  const insertPoint = closingNewline + 1;
  return content.slice(0, insertPoint) + `${line}\n` + content.slice(insertPoint);
}

export function ticketFilePath(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
}

export function clearTicketResolutionTimestamps(content: string): string {
  const fm = extractFrontmatter(content);
  if (!fm) return content;
  const filteredBody = fm.body
    .split(/\r?\n/)
    .filter((line) => !/^(completed_at|skipped_at):\s*/.test(line))
    .join('\n');
  return content.slice(0, fm.start) + `---\n${filteredBody}\n---\n` + content.slice(fm.end);
}

export interface TicketInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  order: number;
  type: string | null;
  working_dir: string | null;
  completed_at: string | null;
  skipped_at: string | null;
  complexity_tier?: 'trivial' | 'small' | 'medium' | 'large';
  /** IDs of tickets this ticket depends on (must run before this one). */
  depends_on: string[];
}

export type TicketStatus = TicketInfo['status'];
export type TicketComplexityTier = NonNullable<TicketInfo['complexity_tier']>;

export interface TicketTierBudget {
  tier: TicketComplexityTier;
  max_iterations: number;
  worker_timeout_seconds: number;
}

export const VALID_TICKET_COMPLEXITY_TIERS = ['trivial', 'small', 'medium', 'large'] as const;

export const TICKET_TIER_BUDGETS: Record<TicketComplexityTier, Omit<TicketTierBudget, 'tier'>> = {
  trivial: { max_iterations: 5, worker_timeout_seconds: 5 * 60 },
  small: { max_iterations: 10, worker_timeout_seconds: 10 * 60 },
  medium: { max_iterations: 30, worker_timeout_seconds: 20 * 60 },
  large: { max_iterations: 60, worker_timeout_seconds: 80 * 60 },
} as const;

export interface TierCapPartial {
  max_iterations?: number;
  worker_timeout_seconds?: number;
}

export type TierCapsConfig = Partial<Record<TicketComplexityTier, TierCapPartial>>;

export function normalizeTicketComplexityTier(value: unknown): TicketComplexityTier {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(normalized)) {
      return normalized as TicketComplexityTier;
    }
  }
  return 'medium';
}

function readTierCapsBlock(block: unknown): TierCapsConfig {
  if (!block || typeof block !== 'object') return {};
  const result: TierCapsConfig = {};
  for (const tier of VALID_TICKET_COMPLEXITY_TIERS) {
    const entry = (block as Record<string, unknown>)[tier];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const partial: TierCapPartial = {};
    const maxIter = Number(e.max_iterations);
    if (Number.isFinite(maxIter) && Number.isInteger(maxIter) && maxIter > 0) {
      partial.max_iterations = maxIter;
    }
    const tmout = Number(e.worker_timeout_seconds);
    if (Number.isFinite(tmout) && Number.isInteger(tmout) && tmout > 0) {
      partial.worker_timeout_seconds = tmout;
    }
    if (partial.max_iterations !== undefined || partial.worker_timeout_seconds !== undefined) {
      result[tier] = partial;
    }
  }
  return result;
}

export function loadPickleSettingsBag(extensionRoot = getExtensionRoot()): PickleSettings | null {
  try {
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    return readRecoverableJsonObject(settingsPath) as PickleSettings | null;
  } catch {
    return null;
  }
}

export function resolveWorkerTestGateTimeoutMs(
  extensionRoot = getExtensionRoot(),
  settings?: PickleSettings | null,
): number {
  const settingsBag = settings === undefined ? loadPickleSettingsBag(extensionRoot) : settings;
  const timeoutMs = Number(settingsBag?.worker_test_gate_timeout_ms);
  if (Number.isFinite(timeoutMs) && Number.isInteger(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS;
}

export function readPickleSettingsTierCaps(
  settings: Record<string, unknown> | null | undefined,
): TierCapsConfig {
  if (!settings) return {};
  return readTierCapsBlock((settings as { tier_caps?: unknown }).tier_caps);
}

export function readStateTierCapOverrides(
  state: State | null | undefined,
): TierCapsConfig {
  const flags = state?.flags;
  if (!flags || typeof flags !== 'object') return {};
  return readTierCapsBlock((flags as Record<string, unknown>).tier_cap_override);
}

/**
 * Canonical ticket-tier budget accessor. Resolution order, applied
 * independently per field (max_iterations, worker_timeout_seconds):
 *
 *   1. state.flags.tier_cap_override.<tier>.<field>
 *   2. pickle_settings.tier_caps.<tier>.<field>
 *   3. TICKET_TIER_BUDGETS[<tier>].<field>  (compiled-in default)
 *
 * Invalid (non-positive-integer) values fall through to the next tier of
 * precedence rather than throwing. Reader honors both pickle_settings v1
 * (schema_version absent) and v2 (schema_version === 2) — only the
 * `tier_caps` block is inspected, so older or newer settings files are safe.
 *
 * If `settings` is `undefined`, the on-disk pickle_settings.json is read via
 * `readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'))`.
 * Pass `null` to bypass disk I/O (compiled defaults only) — useful in tests.
 */
export function getTicketTierBudgetWithOverrides(
  state: State | null | undefined,
  tier: unknown,
  settings?: Record<string, unknown> | null,
): TicketTierBudget {
  const normalizedTier = normalizeTicketComplexityTier(tier);
  const defaults = TICKET_TIER_BUDGETS[normalizedTier];
  const settingsBag = settings === undefined ? loadPickleSettingsBag() : settings;
  const settingsCap = readPickleSettingsTierCaps(settingsBag)[normalizedTier] ?? {};
  const stateCap = readStateTierCapOverrides(state)[normalizedTier] ?? {};
  return {
    tier: normalizedTier,
    max_iterations: stateCap.max_iterations ?? settingsCap.max_iterations ?? defaults.max_iterations,
    worker_timeout_seconds: stateCap.worker_timeout_seconds ?? settingsCap.worker_timeout_seconds ?? defaults.worker_timeout_seconds,
  };
}

export function ticketTierBudget(tier: unknown): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, tier, null);
}

export function ticketInfoBudget(ticketInfo: Pick<TicketInfo, 'complexity_tier'> | null | undefined): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, ticketInfo?.complexity_tier, null);
}

export class MissingTicketError extends Error {
  constructor(
    public readonly sessionRoot: string,
    public readonly ticketId: string,
    public readonly ticketPath: string
  ) {
    super(`Ticket ${ticketId} not found in session ${sessionRoot}`);
    this.name = 'MissingTicketError';
  }
}

/**
 * Read a string-array field from a YAML-ish frontmatter body. Supports both
 * inline `field: [a, b]` and block list:
 *   field:
 *     - a
 *     - b
 * Mirrors the extractor in `check-readiness.ts:dependencyRefs`.
 */
function readFrontmatterStringArray(body: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^${escaped}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${escaped}:\\s*$`).test(line));
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

export function parseTicketFrontmatter(filePath: string): TicketInfo | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) return null;
    const get = (field: string): string | null => {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    const complexity_tier = normalizeTicketComplexityTier(get('complexity_tier'));
    // AC-SSV-05: collect both `depends_on` and the legacy `dependencies` alias,
    // strip optional `external:` prefix, dedupe. These edges feed topoSortTickets.
    const rawDeps = [
      ...readFrontmatterStringArray(fm.body, 'depends_on'),
      ...readFrontmatterStringArray(fm.body, 'dependencies'),
    ];
    const seen = new Set<string>();
    const depends_on: string[] = [];
    for (const dep of rawDeps) {
      const cleaned = dep.replace(/^external:\s*/i, '').trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      depends_on.push(cleaned);
    }
    return {
      id: get('id'),
      title: get('title'),
      status: get('status'),
      order: parseInt(get('order') || '0', 10) || 0,
      type: get('type'),
      working_dir: get('working_dir'),
      completed_at: get('completed_at'),
      skipped_at: get('skipped_at'),
      complexity_tier,
      depends_on,
    };
  } catch {
    return null;
  }
}

export function getTicketStatus(sessionRoot: string, ticketId: string): TicketStatus {
  const ticketPath = path.join(sessionRoot, ticketId, `linear_ticket_${ticketId}.md`);
  if (!fs.existsSync(ticketPath)) {
    throw new MissingTicketError(sessionRoot, ticketId, ticketPath);
  }
  const parsed = parseTicketFrontmatter(ticketPath);
  if (!parsed) {
    throw new MissingTicketError(sessionRoot, ticketId, ticketPath);
  }
  return parsed.status;
}

export interface CompletionCommitEvidence {
  sha: string | null;
  source: 'explicit' | 'inferred' | 'absent';
}

function resolveTicketPath(args: {
  sessionDir?: string;
  ticketId?: string;
  ticketPath?: string;
}): string | null {
  if (typeof args.ticketPath === 'string' && args.ticketPath.length > 0) return args.ticketPath;
  if (typeof args.sessionDir === 'string' && args.sessionDir.length > 0 && typeof args.ticketId === 'string' && args.ticketId.length > 0) {
    return path.join(args.sessionDir, args.ticketId, `linear_ticket_${args.ticketId}.md`);
  }
  return null;
}

function gitCommitExists(workingDir: string, sha: string): boolean {
  try {
    execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function extractRequirementCodes(title: string | null): string[] {
  if (!title) return [];
  return [...new Set(Array.from(title.matchAll(/\bR-[A-Z0-9-]+\b/gi), match => match[0].toLowerCase()))];
}

type MatchingCommit = {
  sha: string;
  epoch: number;
};

function parseGitLogBlocks(raw: string): Array<{ sha: string; epoch: number; message: string }> {
  return raw
    .split('\n---pickle-commit-boundary---\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = '', epochRaw = '0', ...messageParts] = entry.split('\n');
      return {
        sha: sha.trim(),
        epoch: Number(epochRaw.trim()) || 0,
        message: messageParts.join('\n').trim(),
      };
    })
    .filter(entry => /^[0-9a-f]{40}$/i.test(entry.sha));
}

function findMatchingCommit(args: {
  workingDir: string;
  ticketId: string | null;
  title: string | null;
  startTimeEpoch?: number | null;
  ticketPath?: string | null;
}): MatchingCommit | null {
  const matchers = [
    ...(args.ticketId ? [args.ticketId.toLowerCase()] : []),
    ...extractRequirementCodes(args.title),
  ];
  if (matchers.length === 0) return null;
  const startTimeEpoch = Number(args.startTimeEpoch);
  const checkEntry = (entry: { sha: string; epoch: number; message: string }): MatchingCommit | null => {
    if (Number.isFinite(startTimeEpoch) && startTimeEpoch > 0 && entry.epoch < startTimeEpoch) return null;
    const lower = entry.message.toLowerCase();
    return matchers.some(token => lower.includes(token)) ? { sha: entry.sha, epoch: entry.epoch } : null;
  };

  const commands: string[][] = [];
  if (args.ticketPath) {
    commands.push(['-C', args.workingDir, 'log', '-n', '20', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', '--', args.ticketPath]);
  }
  commands.push(['-C', args.workingDir, 'log', '-n', '50', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', 'HEAD']);

  for (const gitArgs of commands) {
    try {
      const raw = execFileSync('git', gitArgs, {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const entry of parseGitLogBlocks(raw)) {
        const matched = checkEntry(entry);
        if (matched) return matched;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function hasCommitReferencingTicketSince(args: {
  workingDir: string;
  ticketId: string | null;
  title?: string | null;
  startTimeEpoch?: number | null;
  ticketPath?: string | null;
}): { sha: string | null; matched: boolean } {
  const match = findMatchingCommit({
    workingDir: args.workingDir,
    ticketId: args.ticketId,
    title: args.title ?? null,
    startTimeEpoch: args.startTimeEpoch,
    ticketPath: args.ticketPath,
  });
  return match ? { sha: match.sha, matched: true } : { sha: null, matched: false };
}

export function hasCompletionCommit(args: {
  sessionDir?: string;
  ticketId?: string;
  ticketPath?: string;
  workingDir: string;
  startTimeEpoch?: number | null;
}): CompletionCommitEvidence {
  const ticketPath = resolveTicketPath(args);
  if (!ticketPath) return { sha: null, source: 'absent' };
  let content: string;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch {
    return { sha: null, source: 'absent' };
  }

  const explicit = readFrontmatterField(content, 'completion_commit');
  if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit) && gitCommitExists(args.workingDir, explicit)) {
    return { sha: explicit, source: 'explicit' };
  }

  const inferredField = readFrontmatterField(content, 'completion_commit_inferred');
  if (inferredField && /^[0-9a-f]{7,40}$/i.test(inferredField) && gitCommitExists(args.workingDir, inferredField)) {
    return { sha: inferredField, source: 'inferred' };
  }

  const inferred = findMatchingCommit({
    workingDir: args.workingDir,
    ticketId: readFrontmatterField(content, 'id') ?? args.ticketId ?? null,
    title: readFrontmatterField(content, 'title') ?? readFirstMarkdownHeading(content),
    startTimeEpoch: args.startTimeEpoch,
    ticketPath,
  });
  if (inferred) return { sha: inferred.sha, source: 'inferred' };
  return { sha: null, source: 'absent' };
}

/**
 * Marks a ticket's frontmatter status as "Done" by rewriting the status line.
 * No-op if ticket dir or file doesn't exist, or status is already Done.
 */
export function markTicketDone(sessionDir: string, ticketId: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, 'Done', sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

export function markTicketSkipped(sessionDir: string, ticketId: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, 'Skipped', sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the dependency graph (indegree + reverse edges) for topoSortTickets.
 * Extracted purely to keep the main function under cyclomatic-complexity 15.
 */
function buildTicketDepGraph(tickets: TicketInfo[]): {
  indegree: Map<number, number>;
  edges: Map<number, number[]>;
} {
  const byId = new Map<string, number>();
  tickets.forEach((t, index) => {
    if (t.id) byId.set(t.id, index);
  });
  const indegree = new Map<number, number>();
  const edges = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    indegree.set(i, 0);
    edges.set(i, []);
  }
  for (let i = 0; i < tickets.length; i++) {
    for (const depId of tickets[i].depends_on) {
      const depIdx = byId.get(depId);
      if (depIdx === undefined) continue; // external/unknown dep — ignore for ordering
      edges.get(depIdx)!.push(i);
      indegree.set(i, (indegree.get(i) || 0) + 1);
    }
  }
  return { indegree, edges };
}

/**
 * Topologically sort tickets so that any ticket whose ID appears in another
 * ticket's `depends_on` list comes BEFORE the dependent ticket. Ties (no
 * incoming-edge difference) break on the numeric `order` field, then on
 * stable insertion index. Throws on cycle detection with both/all member IDs
 * in the message.
 *
 * Implementation: Kahn's algorithm with a ready-queue re-sorted by
 * `(order, originalIndex)` for deterministic output.
 *
 * AC-SSV-05: replaces the prior pure-numeric sort that allowed C-T0 (order 200)
 * to run before NEW-T2 (order 300) when NEW-T2 depended on C-T0, even when the
 * caller supplied them in dependent-first form.
 */
export function topoSortTickets(tickets: TicketInfo[]): TicketInfo[] {
  if (tickets.length <= 1) return [...tickets];
  const { indegree, edges } = buildTicketDepGraph(tickets);
  const compare = (a: number, b: number): number => {
    const oa = tickets[a].order;
    const ob = tickets[b].order;
    return oa !== ob ? oa - ob : a - b;
  };
  const ready: number[] = [];
  for (let i = 0; i < tickets.length; i++) {
    if ((indegree.get(i) || 0) === 0) ready.push(i);
  }
  ready.sort(compare);
  const out: TicketInfo[] = [];
  while (ready.length > 0) {
    const i = ready.shift()!;
    out.push(tickets[i]);
    for (const next of edges.get(i)!) {
      const nextDeg = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }
  if (out.length !== tickets.length) {
    const stuck = tickets.filter((_, i) => (indegree.get(i) || 0) > 0).map((t) => t.id || '<unknown>');
    throw new Error(`Ticket dependency cycle detected: ${stuck.join(' → ')} → ${stuck[0] || '<unknown>'}`);
  }
  return out;
}

export function collectTickets(sessionDir: string): TicketInfo[] {
  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    const tickets: TicketInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(sessionDir, entry.name);
      try {
        const files = fs.readdirSync(subDir);
        for (const file of files) {
          if (!file.startsWith('linear_ticket_') || !file.endsWith('.md')) continue;
          const parsed = parseTicketFrontmatter(path.join(subDir, file));
          if (parsed) tickets.push(parsed);
        }
      } catch {
        /* skip */
      }
    }
    return topoSortTickets(tickets);
  } catch {
    return [];
  }
}

function formatIterationLine(state: Partial<State>): string {
  const iter = Number(state.iteration) || 0;
  const maxIter = Number(state.max_iterations) || 0;
  return maxIter > 0 ? `${iter} of ${maxIter}` : `${iter}`;
}

function appendTicketSummaryLines(lines: string[], tickets: TicketInfo[], state: Partial<State>): void {
  if (tickets.length === 0) return;
  lines.push('Tickets:');
  for (const ticket of tickets) {
    lines.push(formatTicketSummaryLine(ticket, state));
  }
}

function formatTicketSummaryLine(t: TicketInfo, state: Partial<State>): string {
  const sym = statusSymbol(t.status || '');
  const title = (t.title || '').length > 60
    ? (t.title || '').slice(0, 60) + '...'
    : (t.title || '');
  const typeTag = t.type === 'review' ? ' [REVIEW]' : '';
  const dirTag = t.working_dir && t.working_dir !== state.working_dir ? ` (${t.working_dir})` : '';
  const tierTag = t.complexity_tier && t.complexity_tier !== 'medium'
    ? ` [${t.complexity_tier}]`
    : '';
  const skippedNote = (t.status || '').toLowerCase().replace(/["']/g, '') === 'skipped'
    ? ' (no verified completion — re-attempt)'
    : '';
  return `  ${sym} ${t.id || '?'}: ${title}${typeTag}${tierTag}${dirTag}${skippedNote}`;
}

function appendResumeActionLines(lines: string[], state: Partial<State>, iterationNum?: number): void {
  const isFirstIteration = (iterationNum === 1 || iterationNum === undefined)
    && (Number(state.iteration) || 0) === 0
    && (state.history || []).length === 0;
  lines.push('');
  if (isFirstIteration) {
    lines.push(
      'THIS IS A NEW SESSION. Begin the lifecycle from the current phase.',
      'Read state.json for full context, then start working on the task.',
    );
    return;
  }
  lines.push(
    'NEXT ACTION: Resume from current phase. Read state.json for context.',
    'Do NOT restart from scratch. Continue where you left off.',
  );
}

export function buildHandoffSummary(state: Partial<State>, sessionDir: string, iterationNum?: number): string {
  const task = state.original_prompt || '';
  const truncatedTask = task.length > 300 ? task.slice(0, 300) + ' [truncated]' : task;
  const prdPath = path.join(sessionDir, 'prd.md');
  const prdExists = fs.existsSync(prdPath);
  const tickets = collectTickets(sessionDir);
  const lines = [
    '=== PICKLE RICK LOOP CONTEXT ===',
    `Phase: ${state.step || 'unknown'}`,
    `Iteration: ${formatIterationLine(state)}`,
    `Session: ${sessionDir}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Task: ${truncatedTask}`,
    `PRD: ${prdExists ? 'exists' : 'not yet created'}`,
  ];
  const rawMinIter = Number(state.min_iterations);
  const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
  if (minIter > 0) {
    lines.push(`Min Passes: ${minIter}`);
  }
  if (state.command_template) {
    lines.push(`Template: ${state.command_template}`);
  }
  appendTicketSummaryLines(lines, tickets, state);
  const workingDirs = new Set(tickets.map(t => t.working_dir).filter(Boolean));
  if (workingDirs.size >= 2) {
    lines.push('');
    lines.push(`⚠️  MULTI-REPO: Tickets span ${[...workingDirs].join(', ')}. Consider separate sessions per repo.`);
  }
  appendResumeActionLines(lines, state, iterationNum);
  return lines.join('\n');
}

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep that yields to the OS scheduler instead of busy-waiting. */
function sleepMs(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

export interface RetryLockOptions {
  /** Maximum number of retry attempts before throwing LockError. Default: 10. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 100. */
  baseLockDelayMs?: number;
  /** Age threshold in ms after which a lock file is considered stale and stolen. Default: 30000. */
  staleLockTimeoutMs?: number;
  /** Whether to add random jitter to backoff delays. Default: true. */
  lockJitter?: boolean;
}

const RETRY_LOCK_DEFAULTS = {
  maxRetries: 10,
  baseLockDelayMs: 100,
  staleLockTimeoutMs: 30_000,
  lockJitter: true,
} as const;

function stealStaleLock(lockPath: string, staleLockTimeoutMs: number): void {
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > staleLockTimeoutMs) {
      try { fs.unlinkSync(lockPath); } catch { /* already gone — race is fine */ }
    }
  } catch {
    // lock file doesn't exist — expected
  }
}

function tryRunWithExclusiveLock<T>(lockPath: string, fn: () => T): { acquired: true; value: T } | { acquired: false } {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }

    try {
      return { acquired: true, value: fn() };
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* ignore cleanup failure */ }
    }
  } catch (e) {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EEXIST') throw e;
    return { acquired: false };
  }
}

function sleepBeforeRetry(attempt: number, baseLockDelayMs: number, lockJitter: boolean): void {
  const backoff = baseLockDelayMs * Math.pow(2, attempt);
  const jitter = lockJitter ? Math.random() * baseLockDelayMs : 0;
  sleepMs(Math.min(backoff + jitter, 5000));
}

/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries with exponential
 * backoff and optional jitter, stealing locks older than staleLockTimeoutMs.
 * Writes PID to lock file for stale detection. NEVER silently falls through —
 * throws LockError if maxRetries is exhausted.
 */
export function withRetryLock<T>(lockPath: string, fn: () => T, opts: RetryLockOptions = {}): T {
  const maxRetries = opts.maxRetries ?? RETRY_LOCK_DEFAULTS.maxRetries;
  const baseLockDelayMs = opts.baseLockDelayMs ?? RETRY_LOCK_DEFAULTS.baseLockDelayMs;
  const staleLockTimeoutMs = opts.staleLockTimeoutMs ?? RETRY_LOCK_DEFAULTS.staleLockTimeoutMs;
  const lockJitter = opts.lockJitter ?? RETRY_LOCK_DEFAULTS.lockJitter;

  let attempt = 0;

  while (true) {
    // Steal stale lock if present — unlink + create in tight sequence to minimize TOCTOU window
    stealStaleLock(lockPath, staleLockTimeoutMs);

    // Atomic exclusive create; write PID for stale-detection by other processes
    const locked = tryRunWithExclusiveLock(lockPath, fn);
    if (locked.acquired) return locked.value;

    if (attempt >= maxRetries) {
      throw new LockError(
        `[pickle] Lock acquisition failed after ${maxRetries} retries (${lockPath})`
      );
    }
    sleepBeforeRetry(attempt, baseLockDelayMs, lockJitter);
    attempt++;
  }
}

/**
 * R-SHB-5/6: Atomically prune `current_sessions.json` entries whose session
 * directory has been deleted or whose `state.json` is unreadable. This is the
 * janitor for the run-#6 forensic operator workaround — pre-fix, 13 phantom
 * map entries pointed at removed session dirs and shadowed live same-cwd
 * lookups in stop-hook + resolver paths.
 *
 * Atomic write via `.tmp.<pid>` rename so concurrent readers never see a
 * truncated map. Returns `{ pruned, total }` so callers can log + decide.
 * Idempotent: missing map file is a no-op; map with all-valid entries is
 * a no-op (no write).
 *
 * Best-effort throughout — never throws on filesystem races, locked files,
 * or malformed map content. The cwd-resolve path calls this BEFORE reading
 * the map, so even a corrupted prune result fails-safe to "no entries
 * pruned + read original map".
 */
export function pruneOrphanedMapEntries(dataRoot: string): { pruned: number; total: number } {
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  let map: Record<string, unknown> | null;
  try {
    map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
  } catch {
    return { pruned: 0, total: 0 };
  }
  if (!map || typeof map !== 'object') return { pruned: 0, total: 0 };

  const entries = Object.entries(map);
  const total = entries.length;
  if (total === 0) return { pruned: 0, total: 0 };

  const survivors: Record<string, unknown> = {};
  let pruned = 0;
  for (const [cwd, entry] of entries) {
    const sessionPath = resolveSessionPath(entry);
    if (!sessionPath) {
      writePhantomSessionDemotedActivity(cwd, '');
      pruned++;
      continue;
    }
    let dirExists = false;
    try {
      dirExists = fs.statSync(sessionPath).isDirectory();
    } catch {
      // dirExists already false
    }
    if (!dirExists) {
      writePhantomSessionDemotedActivity(cwd, sessionPath);
      pruned++;
      continue;
    }
    let stateReadable = false;
    try {
      fs.accessSync(path.join(sessionPath, 'state.json'), fs.constants.R_OK);
      stateReadable = true;
    } catch {
      // stateReadable already false
    }
    if (!stateReadable) {
      writePhantomSessionDemotedActivity(cwd, sessionPath);
      pruned++;
      continue;
    }
    survivors[cwd] = entry;
  }

  if (pruned === 0) return { pruned: 0, total };

  const tmpPath = `${sessionsMapPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(survivors, null, 2));
    fs.renameSync(tmpPath, sessionsMapPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { pruned: 0, total };
  }
  return { pruned, total };
}

/**
 * Extracts the session path from a session map entry.
 * Handles both the legacy string format and the current object format ({ sessionPath, pid })
 * for backward compatibility with existing current_sessions.json files.
 */
export function resolveSessionPath(entry: string | SessionMapEntry | unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof (entry as SessionMapEntry).sessionPath === 'string') {
    return (entry as SessionMapEntry).sessionPath;
  }
  return '';
}

function sameWorkingDir(a: unknown, b: string): boolean {
  return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}

interface SessionLookupState {
  active?: unknown;
  working_dir?: unknown;
  started_at?: unknown;
  state_mtime_ms?: number;
}

interface SessionLookupCandidate {
  sessionPath: string;
  recencyMs: number;
}

const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;

function readSessionLookupState(sessionPath: string): SessionLookupState | null {
  try {
    const statePath = path.join(sessionPath, 'state.json');
    let stateMtimeMs = 0;
    try { stateMtimeMs = fs.statSync(statePath).mtimeMs; } catch { /* missing state read below will fail */ }
    const state = new StateManager().read(statePath);
    return {
      active: state.active,
      working_dir: state.working_dir,
      started_at: state.started_at,
      state_mtime_ms: stateMtimeMs,
    };
  } catch {
    return null;
  }
}

function getSessionRecencyMs(state: SessionLookupState): number {
  if (typeof state.started_at === 'string') {
    const startedAtMs = new Date(state.started_at).getTime();
    const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
    if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
      return startedAtMs;
    }
  }
  return state.state_mtime_ms ?? 0;
}

function preferNewerSession(
  best: SessionLookupCandidate | null,
  candidate: SessionLookupCandidate,
): SessionLookupCandidate {
  if (!best) return candidate;
  if (candidate.recencyMs !== best.recencyMs) {
    return candidate.recencyMs > best.recencyMs ? candidate : best;
  }
  return candidate.sessionPath.localeCompare(best.sessionPath) > 0 ? candidate : best;
}

function selectScannedSessionPath(
  sessionPaths: string[],
  cwd: string,
  requireActive: boolean,
): string {
  let activeMatch: SessionLookupCandidate | null = null;
  let inactiveMatch: SessionLookupCandidate | null = null;

  for (const sessionPath of sessionPaths) {
    const state = readSessionLookupState(sessionPath);
    if (!state) continue;
    if (!sameWorkingDir(state.working_dir, cwd)) continue;
    const candidate = {
      sessionPath,
      recencyMs: getSessionRecencyMs(state),
    };
    if (state.active === true) {
      activeMatch = preferNewerSession(activeMatch, candidate);
      continue;
    }
    if (!requireActive) {
      inactiveMatch = preferNewerSession(inactiveMatch, candidate);
    }
  }

  return activeMatch?.sessionPath ?? inactiveMatch?.sessionPath ?? '';
}

function resolveMappedSessionForCwd(
  map: Record<string, unknown>,
  cwd: string,
  requireActive: boolean,
): string | null {
  const mappedPath = resolveSessionPath(map[cwd]);
  if (!mappedPath || !fs.existsSync(mappedPath)) return '';
  const state = readSessionLookupState(mappedPath);
  if (!state) {
    return requireActive ? '' : mappedPath;
  }
  if (sameWorkingDir(state.working_dir, cwd)) {
    if (state.active === true) return mappedPath;
    return requireActive ? '' : mappedPath;
  }
  if (!requireActive && (state.working_dir == null || state.working_dir === '')) {
    return mappedPath;
  }
  return '';
}

function readSessionsMapFallback(sessionsMapPath: string, cwd: string, requireActive: boolean): string {
  try {
    const map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
    return map ? resolveMappedSessionForCwd(map, cwd, requireActive) ?? '' : '';
  } catch {
    return '';
  }
}

/**
 * Resolves the session for a cwd from the session map first, then falls back
 * to scanning session state by working_dir when the map is missing or stale.
 */
export function findSessionPathForCwd(
  cwd: string,
  options: { requireActive?: boolean } = {},
): string {
  const { requireActive = false } = options;
  const dataRoot = getDataRoot();
  // R-SHB-6: prune phantom map entries before reading. Pre-fix, removed
  // session dirs left stale entries that shadowed live same-cwd lookups.
  pruneOrphanedMapEntries(dataRoot);
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  const mappedFallback = readSessionsMapFallback(sessionsMapPath, cwd, requireActive);
  if (mappedFallback && requireActive) return mappedFallback;

  const sessionsDir = path.join(dataRoot, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return mappedFallback;
  }

  const scannedMatch = selectScannedSessionPath(
    entries.map((entry) => path.join(sessionsDir, entry)),
    cwd,
    requireActive,
  );
  if (scannedMatch) {
    return scannedMatch;
  }

  return mappedFallback;
}

/** Matrix palette shared across all monitor panes. */
export const MatrixStyle = {
  BRIGHT: '\x1b[1;32m',    // bold green
  GREEN: '\x1b[32m',       // normal green
  DIM: '\x1b[2;32m',       // dim green
  CYAN: '\x1b[36m',        // cyan accent
  ERR: '\x1b[1;31m',       // bold red
  WARN: '\x1b[33m',        // yellow
  R: '\x1b[0m',            // reset
} as const;

export const RAIN_CHARS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ012345789Z:."=*+-<>¦╌╎';

/** Generates a Matrix-styled separator line with random rain characters. */
export function matrixSeparator(width: number): string {
  const line: string[] = [];
  for (let i = 0; i < width; i++) {
    line.push(Math.random() < 0.2
      ? RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]
      : '─');
  }
  return `${MatrixStyle.DIM}${line.join('')}${MatrixStyle.R}`;
}

/** Finds the most recent tmux_iteration_N.log in a session directory. */
export function latestIterationLog(sessionDir: string): string | null {
  try {
    const logs = fs
      .readdirSync(sessionDir)
      .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
        const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
        return (numA || 0) - (numB || 0);
      });
    return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1]) : null;
  } catch {
    return null;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB

/**
 * Reads stream-json log from `offset`, processes complete lines via the
 * provided `processor`, and emits output. Returns new offset and partial
 * trailing line buffer.
 */
export function drainStreamJsonLines(
  logPath: string,
  offset: number,
  lineBuf: string,
  processor: (line: string) => string | null,
  emit: (text: string) => void,
): { offset: number; lineBuf: string } {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return { offset, lineBuf };
    fd = fs.openSync(logPath, 'r');
    let pos = offset;
    let buf = lineBuf;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const raw = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
      if (bytesRead === 0) break;
      buf += raw.subarray(0, bytesRead).toString('utf-8');
      pos += bytesRead;
    }
    fs.closeSync(fd);
    fd = null;
    const lines = buf.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      const result = processor(line);
      if (result !== null) emit(result);
    }
    return { offset: pos, lineBuf: trailing };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { offset, lineBuf };
  }
}

/**
 * R-MWR-4: detect truncation of a file-tail watcher's current log.
 *
 * When the file at `logPath` is truncated (size shrinks below the
 * caller's recorded `offset`), tail-style watchers must reset their
 * offset and partial-line buffer so post-truncate content is consumed
 * instead of skipped. Without this hook, `drainStreamJsonLines` and
 * `drainLog` early-return on `size <= offset` and the watcher feeds a
 * dead chunk forever.
 *
 * Returns the post-check offset and lineBuf, plus a `truncated` flag
 * the caller uses to print exactly one dim `(reconnecting...)` line
 * per disconnect (R-MWR-6: banner stays reserved for liveness-probe
 * inactive exits, NOT for EOF).
 *
 * Returns the inputs unchanged if the file is missing or unreadable —
 * those cases are owned by the caller's own `latestIterationLog` /
 * worker-log discovery loop.
 */
export function detectLogTruncation(
  logPath: string,
  offset: number,
  lineBuf: string,
): { offset: number; lineBuf: string; truncated: boolean } {
  try {
    const { size } = fs.statSync(logPath);
    if (size < offset) {
      return { offset: 0, lineBuf: '', truncated: true };
    }
  } catch {
    // Missing or unreadable — caller will pick this up on its next
    // discovery iteration. Do not mutate offset.
  }
  return { offset, lineBuf, truncated: false };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Emits log content to stdout, stripping ANSI codes and truncating long lines. */
function emitLog(content: string): void {
  const width = Math.min((process.stdout.columns || 80) - 2, 120);
  const lines = content.replace(ANSI_REGEX, '').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
  }
}

/**
 * Reads new bytes from a log file starting at `offset`, emits them to stdout,
 * and returns the new offset. Reads in 64 KiB chunks to limit memory usage.
 */
export function drainLog(logPath: string, offset: number): number {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return offset;
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break; // EOF — file was truncated
      emitLog(decoder.write(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    const trailing = decoder.end();
    if (trailing) emitLog(trailing);
    fs.closeSync(fd);
    return pos;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore double-close */ }
    }
    return offset;
  }
}

/**
 * Atomically writes `state` as pretty-printed JSON to `filePath`.
 * Writes to a `.tmp` sibling first, then renames — prevents partial reads.
 */
export function writeStateFile(filePath: string, state: State | object): void {
  stateWriteSeq = (stateWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${stateWriteSeq}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

/**
 * Updates a single key in a session's state.json with validation.
 * Numeric, boolean, and step keys are type-checked before writing.
 */
export function updateState(key: string, value: string, sessionDir: string): void {
  const statePath = path.join(sessionDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}`);
  }

  if (key === 'step' && !(VALID_STEPS as readonly string[]).includes(value)) {
    throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
  }

  const NUMERIC_KEYS = new Set(['iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch', 'min_iterations']);
  const BOOLEAN_KEYS = new Set(['tmux_mode', 'chain_meeseeks']);
  // active and completion_promise are owned by tmux-runner/cancel.js — never via CLI
  const ALLOWED_KEYS = new Set([
    ...NUMERIC_KEYS, ...BOOLEAN_KEYS, 'step', 'working_dir',
    'original_prompt', 'current_ticket', 'started_at', 'session_dir', 'command_template',
  ]);
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(`Unknown state key "${key}". Allowed: ${[...ALLOWED_KEYS].join(', ')}`);
  }

  // Validate value BEFORE acquiring lock to fail fast
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Key "${key}" requires a finite number, got "${value}"`);
    }
    if (!Number.isInteger(num)) {
      throw new Error(`Key "${key}" requires an integer, got "${value}"`);
    }
    if (['iteration', 'max_iterations', 'max_time_minutes', 'start_time_epoch', 'min_iterations'].includes(key) && num < 0) {
      throw new Error(`Key "${key}" requires a non-negative integer, got "${value}"`);
    }
    if (key === 'worker_timeout_seconds' && num <= 0) {
      throw new Error(`Key "${key}" requires a positive integer, got "${value}"`);
    }
  } else if (BOOLEAN_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
    }
  }

  const sm = new StateManager();
  sm.update(statePath, state => {
    if (NUMERIC_KEYS.has(key)) {
      (state as unknown as Record<string, unknown>)[key] = Number(value);
    } else if (BOOLEAN_KEYS.has(key)) {
      (state as unknown as Record<string, unknown>)[key] = value === 'true';
    } else {
      (state as unknown as Record<string, unknown>)[key] = value;
    }
    if (key === 'current_ticket') {
      // R-CNAR-8: when an operator manually retargets current_ticket, ALL 5
      // cache fields must clear together. Pre-fix the missing 3 fields skewed
      // ticketBudgetIterationCount on the next iteration.
      delete state.current_ticket_tier;
      delete state.current_ticket_budget;
      delete state.current_ticket_max_iterations;
      delete state.current_ticket_worker_timeout_seconds;
      delete state.current_ticket_budget_start_iteration;
    }
  });
  console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}

/**
 * Monitor-window modes — map to the layout selector inside tmux-monitor.sh.
 * `pickle` is the default (2×2 grid with morty-watcher in the bottom-left);
 * `meeseeks` / `council` swap morty-watcher for mux-runner.log tail;
 * `refinement` swaps in refinement-watcher.
 */
export type MonitorMode = 'pickle' | 'meeseeks' | 'council' | 'refinement';

type MonitorPane = 0 | 1 | 2 | 3;

interface WatcherPaneCommand {
  pane: MonitorPane;
  name: string;
  command: string;
}

export interface EnsureMonitorWindowResult {
  status: 'skipped' | 'created' | 'exists' | 'recreated' | 'error';
  reason?: string;
}

export interface EnsureMonitorWindowOptions {
  sessionDir: string;
  extensionRoot?: string;
  /** Force a specific mode; if omitted, inferred from state.json.command_template. */
  mode?: MonitorMode;
  /** Test override: inject process spawns for tmux/bash calls. */
  spawnSyncFn?: typeof spawnSync;
  /** Test override: if false, skip even when process.env.TMUX is set. */
  inTmux?: boolean;
  /** Test override: tmux binary name (default: "tmux"). */
  tmuxBin?: string;
  /** Test override: bash binary name (default: "bash"). */
  bashBin?: string;
  /** Optional logger — called with human-readable status lines. */
  log?: (msg: string) => void;
}

/** Infers monitor mode from state.json's command_template. Defaults to 'pickle'. */
export function inferMonitorMode(sessionDir: string): MonitorMode {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { command_template?: string };
    const tpl = (state.command_template || '').toLowerCase();
    if (tpl === 'meeseeks.md') return 'meeseeks';
    if (tpl === 'council-of-ricks.md') return 'council';
    return 'pickle';
  } catch {
    return 'pickle';
  }
}

export function restartDeadWatcherPanes(
  sessionDir: string,
  extensionRoot: string,
  mode: MonitorMode,
  spawnSyncFn: typeof spawnSync = spawnSync,
  /**
   * R-MWR-3: log-line prefix for respawn decisions. Defaults to
   * `restartDeadWatcherPanes` for boundary-driven invocations
   * (`ensureMonitorWindow` re-attach). The continuous in-monitor
   * watchdog (`startRespawnWatchdog`) passes `monitor-watchdog` so
   * AC-MWR-05 grep can distinguish the two callers in `mux-runner.log`.
   */
  logTag: string = 'restartDeadWatcherPanes',
): void {
  if (isSessionInactive(sessionDir)) return;

  const sessionName = readCurrentTmuxSessionName(spawnSyncFn);
  if (!sessionName) {
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: unable to resolve tmux session name`);
    return;
  }

  for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
    const target = `${sessionName}:monitor.${watcher.pane}`;
    const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
    if (currentCommand === null) {
      appendWatcherRestartLog(
        sessionDir,
        `${logTag} WARN: unable to read pane_current_command for pane ${watcher.pane}`,
      );
      continue;
    }
    if (currentCommand === 'node') continue;

    appendWatcherRestartLog(
      sessionDir,
      `${logTag} WARN: pane ${watcher.pane} command '${currentCommand || '(empty)'}' is not node`,
    );
    const result = spawnSyncFn('tmux', ['send-keys', '-t', target, watcher.command, 'Enter'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status === 0) {
      appendWatcherRestartLog(
        sessionDir,
        `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`,
      );
    } else {
      const err = (result.stderr || result.stdout || '').toString().trim();
      appendWatcherRestartLog(
        sessionDir,
        `${logTag} WARN: failed to respawn ${watcher.name} in pane ${watcher.pane}: ${err || 'non-zero exit'}`,
      );
    }
  }
}

function isSessionInactive(sessionDir: string): boolean {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { active?: unknown };
    return state.active === false;
  } catch {
    return false;
  }
}

function readCurrentTmuxSessionName(spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const sessionName = (result.stdout || '').trim();
  return sessionName || null;
}

function readPaneCurrentCommand(target: string, spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function watcherPaneCommands(sessionDir: string, extensionRoot: string, mode: MonitorMode): WatcherPaneCommand[] {
  const binRoot = path.join(extensionRoot, 'extension', 'bin');
  const paneTwo = watcherPaneTwoCommand(sessionDir, binRoot, mode);

  return [
    {
      pane: 0,
      name: 'monitor.js',
      command: `node ${path.join(binRoot, 'monitor.js')} ${sessionDir}`,
    },
    {
      pane: 1,
      name: 'log-watcher.js',
      command: `node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}`,
    },
    paneTwo,
    {
      pane: 3,
      name: 'raw-morty.js',
      command: `node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}`,
    },
  ];
}

function watcherPaneTwoCommand(sessionDir: string, binRoot: string, mode: MonitorMode): WatcherPaneCommand {
  if (mode === 'refinement') {
    return {
      pane: 2,
      name: 'refinement-watcher.js',
      command: `node ${path.join(binRoot, 'refinement-watcher.js')} ${sessionDir}`,
    };
  }
  if (mode === 'meeseeks' || mode === 'council') {
    return {
      pane: 2,
      name: 'mux-runner.log tail',
      command: `tail -F ${path.join(sessionDir, 'mux-runner.log')}`,
    };
  }
  return {
    pane: 2,
    name: 'morty-watcher.js',
    command: `node ${path.join(binRoot, 'morty-watcher.js')} ${sessionDir}`,
  };
}

function appendWatcherRestartLog(sessionDir: string, line: string): void {
  try {
    fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best-effort diagnostic logging must not break pane recovery.
  }
}

/**
 * Idempotently creates the 4-pane monitor window in the current tmux session.
 *
 * Called at the start of every long-running pickle tmux runner (mux-runner,
 * pipeline-runner) so agents never have to invoke tmux-monitor.sh explicitly —
 * previously Step 11e of several skill prompts, silently dropped when the
 * agent's context was tight.
 *
 * Never throws. Returns a status so callers can log the outcome:
 *   - `skipped`    → not inside tmux (headless or direct invocation)
 *   - `exists`     → monitor window already present for this mode, no-op
 *   - `created`    → monitor window spawned
 *   - `recreated`  → stale monitor (different mode) killed and respawned
 *   - `error`      → tmux/bash call failed; check `reason`
 *
 * Mode compatibility: the monitor window's layout is mode-specific
 * (pickle/meeseeks/council/refinement). We persist the mode it was built for
 * via a tmux user-option (`@pickle_monitor_mode`) on the window itself, then
 * on re-entry compare against the mode this invocation wants. Mismatch =>
 * kill + recreate. Silent reuse would leave the wrong layout in place.
 */
export function ensureMonitorWindow(opts: EnsureMonitorWindowOptions): EnsureMonitorWindowResult {
  const log = opts.log || (() => { /* no-op */ });
  const inTmux = opts.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;

  if (!inTmux) {
    log('ensureMonitorWindow: not inside tmux, skipping');
    return { status: 'skipped', reason: 'not in tmux' };
  }

  activeMonitorWindowContext = {
    opts,
    log,
    tmuxBin: opts.tmuxBin || 'tmux',
    bashBin: opts.bashBin || 'bash',
    spawnSyncFn: opts.spawnSyncFn || spawnSync,
    mode: opts.mode || inferMonitorMode(opts.sessionDir),
  };
  try {
    const sessionName = getSessionName();
    if (!sessionName) return activeMonitorWindowContext.outcome || { status: 'error', reason: 'empty session name' };
    const { recreate } = checkAndRecreateWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    createMonitorWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    if (recreate) {
      log(`ensureMonitorWindow: recreated 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
      return { status: 'recreated' };
    }
    log(`ensureMonitorWindow: created 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
    return { status: 'created' };
  } finally {
    activeMonitorWindowContext = null;
  }
}

interface MonitorWindowContext {
  opts: EnsureMonitorWindowOptions;
  log: (msg: string) => void;
  tmuxBin: string;
  bashBin: string;
  spawnSyncFn: typeof spawnSync;
  mode: MonitorMode;
  outcome?: EnsureMonitorWindowResult;
}

let activeMonitorWindowContext: MonitorWindowContext | null = null;

function currentMonitorWindowContext(): MonitorWindowContext {
  if (!activeMonitorWindowContext) throw new Error('ensureMonitorWindow context not initialized');
  return activeMonitorWindowContext;
}

function getSessionName(): string | null {
  const { log, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  // Resolve session name via tmux itself — the TMUX env var alone only proves
  // we're inside *some* tmux, not which session owns this pane.
  const displayName = spawnSyncFn(tmuxBin, ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (displayName.status !== 0) {
    const err = (displayName.stderr || '').toString().trim();
    log(`ensureMonitorWindow: tmux display-message failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `display-message: ${err || 'non-zero exit'}` };
    return null;
  }
  const sessionName = (displayName.stdout || '').trim();
  if (!sessionName) {
    log('ensureMonitorWindow: empty tmux session name');
    activeMonitorWindowContext!.outcome = { status: 'error', reason: 'empty session name' };
    return null;
  }
  return sessionName;
}

function checkAndRecreateWindow(sessionName: string): { recreate: boolean } {
  const { log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;

  // Compatibility guard — a "monitor" window from a previous command (e.g.
  // anatomy-park then council) has the wrong layout. Check the window's
  // `@pickle_monitor_mode` user-option and recreate on mismatch.
  const listWindows = spawnSyncFn(tmuxBin, ['list-windows', '-t', sessionName, '-F', '#W'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (listWindows.status !== 0) return { recreate: false };
  const names = (listWindows.stdout || '').split('\n').map(s => s.trim());
  if (!names.includes('monitor')) return { recreate: false };

  const existingMode = readWindowMode(tmuxBin, target, spawnSyncFn);
  if (monitorModesCompatible(existingMode, mode)) {
    log(`ensureMonitorWindow: monitor window already exists on ${sessionName} (mode=${mode})`);
    restartDeadWatcherPanes(opts.sessionDir, resolveMonitorExtensionRoot(opts), mode, spawnSyncFn);
    activeMonitorWindowContext!.outcome = { status: 'exists' };
    return { recreate: false };
  }

  log(
    `ensureMonitorWindow: mode mismatch on ${sessionName} ` +
    `(existing=${existingMode || 'unset'}, want=${mode}) — killing stale window`,
  );
  const kill = spawnSyncFn(tmuxBin, ['kill-window', '-t', target], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (kill.status !== 0) {
    const err = (kill.stderr || '').toString().trim();
    log(`ensureMonitorWindow: kill-window failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `kill-window: ${err || 'non-zero exit'}` };
    return { recreate: false };
  }
  return { recreate: true };
}

function createMonitorWindow(sessionName: string): void {
  const { bashBin, log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;
  const extensionRoot = resolveMonitorExtensionRoot(opts);
  const script = path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh');
  if (!fs.existsSync(script)) {
    log(`ensureMonitorWindow: tmux-monitor.sh missing at ${script}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script missing: ${script}` };
    return;
  }

  const result = spawnSyncFn(bashBin, [script, sessionName, opts.sessionDir, mode], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').toString().trim();
    log(`ensureMonitorWindow: tmux-monitor.sh failed (exit ${result.status}): ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script exit ${result.status}: ${err || 'no stderr'}` };
    return;
  }

  // Stamp the mode on the freshly-created window so the next invocation can
  // detect compatibility. Non-fatal if it fails — we log and move on.
  const setOpt = spawnSyncFn(
    tmuxBin,
    ['set-option', '-w', '-t', target, '@pickle_monitor_mode', mode],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (setOpt.status !== 0) {
    const err = (setOpt.stderr || '').toString().trim();
    log(`ensureMonitorWindow: set-option @pickle_monitor_mode failed (non-fatal): ${err}`);
  }
}

function resolveMonitorExtensionRoot(opts: EnsureMonitorWindowOptions): string {
  return opts.extensionRoot ? resolveExtensionRoot(opts.extensionRoot) : getExtensionRoot();
}

/** Reads the monitor window's stamped mode via tmux user-option, or null. */
function readWindowMode(tmuxBin: string, target: string, spawnSyncFn: typeof spawnSync): string | null {
  const show = spawnSyncFn(
    tmuxBin,
    ['show-option', '-w', '-qv', '-t', target, '@pickle_monitor_mode'],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (show.status !== 0) return null;
  const val = (show.stdout || '').trim();
  return val || null;
}

/**
 * Returns true iff we can reuse an existing monitor window without recreating.
 * Unset existing mode counts as incompatible — we can't prove the layout matches
 * what this mode needs, so play it safe and rebuild.
 */
export function monitorModesCompatible(existing: string | null, want: MonitorMode): boolean {
  if (!existing) return false;
  return existing === want;
}

/** Default timeout for macOS notification shell-outs (`osascript`). Kept short
 *  because notifications run on the exit path — a wedged Notification Center /
 *  AppleEvent daemon must NOT block `process.exit` on the runner. Four prior
 *  "improve notification" passes (8db2771, 2f19356, f9f37ef, 2da7fe5, 8cc31a6)
 *  added features and fixed content but none passed a `timeout`; see trap door
 *  in extension/CLAUDE.md and anatomy-park iteration 4 commit. */
export const NOTIFICATION_TIMEOUT_MS = 5_000;

export interface DisplayMacNotificationOptions {
  /** @internal test seam — override `spawnSync` to capture invocations / inject hangs */
  spawnSyncFn?: typeof spawnSync;
  /** @internal test seam — force the darwin code path on any platform */
  forceDarwin?: boolean;
  /** Override the default NOTIFICATION_TIMEOUT_MS (primarily for tests) */
  timeoutMs?: number;
}

/** Display a macOS notification via `osascript`. No-op on non-darwin platforms.
 *  Every invocation passes an explicit `timeout` so a wedged UI server cannot
 *  block the caller indefinitely. Any error (ENOENT, SIGTERM on timeout,
 *  non-zero exit) is swallowed — notifications are best-effort at program exit. */
export function displayMacNotification(
  title: string,
  body: string,
  subtitle?: string,
  opts: DisplayMacNotificationOptions = {},
): void {
  const isDarwin = opts.forceDarwin ?? process.platform === 'darwin';
  if (!isDarwin) return;
  const timeoutMs = opts.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
  const spawnSyncFn = opts.spawnSyncFn ?? spawnSync;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = subtitle
    ? `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`
    : `display notification "${esc(body)}" with title "${esc(title)}"`;
  try {
    spawnSyncFn('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf-8' });
  } catch { /* best-effort: ENOENT / timeout / non-zero exit are all non-fatal */ }
}

/** Removes inactive session directories older than maxAgeDays from sessionsRoot. */
export function pruneOldSessions(sessionsRoot: string, maxAgeDays = 7): void {
  if (!fs.existsSync(sessionsRoot)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
  const sm = new StateManager();
  for (const entry of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, entry);
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const sessionDirMtimeMs = fs.statSync(sessionDir).mtimeMs;
      const state = sm.read(statePath);
      if (state.active === true) continue;
      const rawMs = state.started_at
        ? new Date(state.started_at).getTime()
        : NaN;
      const startedMs = Number.isFinite(rawMs) && rawMs <= maxTrustedFutureMs
        ? rawMs
        : sessionDirMtimeMs;
      if (startedMs < cutoffMs) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch { /* skip unreadable or already-deleted sessions */ }
  }
}

// --- Manager prompt composition helpers ---

/**
 * Strips the Setup section from dual-mode templates (e.g. meeseeks.md, szechuan-sauce.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Strips from "## SETUP" (with or without " MODE" suffix) to
 * the next ##-level heading, regardless of its name. This avoids coupling to a specific
 * end-marker like "## REVIEW PASS MODE" — any template layout works.
 */
export function stripSetupSection(prompt: string): string {
  const setupRe = /^## SETUP(?: MODE)?$/m;
  const setupMatch = setupRe.exec(prompt);
  if (!setupMatch) return prompt;

  const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
  const nextHeadingRe = /^## \S/m;
  const nextMatch = nextHeadingRe.exec(afterSetup);
  if (!nextMatch) return prompt;

  const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
  return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}

/**
 * Strips the "# Step 1: Initialization" block from a manager skill prompt.
 * The block contains setup.js --task examples that codex executes verbatim when
 * present in manager payloads. Strips from the heading through the start of
 * "# Step 2:", exclusive (the Step 2 heading is preserved).
 */
export function stripStepOneBlock(prompt: string): string {
  const step1Re = /^# Step 1: Initialization\s*$/m;
  const step1Match = step1Re.exec(prompt);
  if (!step1Match) return prompt;

  const afterStep1 = prompt.slice(step1Match.index);
  const step2Re = /^# Step 2:/m;
  const step2Match = step2Re.exec(afterStep1);
  if (!step2Match) return prompt;

  const endIndex = step1Match.index + step2Match.index;
  return prompt.slice(0, step1Match.index) + prompt.slice(endIndex);
}

/**
 * HTML-comment framing block injected at the top of codex manager prompts.
 * Mirrors the GIT_BOUNDARY_RULES pattern that codex demonstrably respects.
 */
export const MANAGER_ROLE_FRAMING_BLOCK = `<!-- BEGIN MANAGER_ROLE_FRAMING -->
You are the Pickle Rick manager process. Your role is to read state.json and orchestrate Morty worker agents via spawn-morty.js.

PROHIBITED in this manager session:
- Running \`node <path>/setup.js --task\` or \`node <path>/setup.js --resume\` as a Bash command
- Treating setup.js usage examples from documentation sections as executable instructions
- Executing any \`setup.js\` invocation shown in template text — those are documentation examples

Your ONLY valid setup.js invocation is the one already completed to initialize this session. Proceed directly to Step 2: Execution.
<!-- END MANAGER_ROLE_FRAMING -->`;

export interface ComposeManagerPromptOpts {
  argumentSubstitution: string;
  handoffText?: string;
  iterationSummary?: string;
  taskNotes?: string;
}

/**
 * Composes the full manager prompt from a skill file path, applying all
 * standard transforms and optionally prepending Role Framing for codex.
 * Call sites pre-resolve handoffText/iterationSummary/taskNotes strings.
 */
export function composeManagerPromptFromSkill(
  skillPath: string,
  backend: Backend,
  opts: ComposeManagerPromptOpts,
): string {
  let content = fs.readFileSync(skillPath, 'utf-8');
  content = content.replace(/\$ARGUMENTS/g, opts.argumentSubstitution);
  content = stripSetupSection(content);
  content = stripStepOneBlock(content);
  if (opts.handoffText) content += '\n\n' + opts.handoffText;
  if (opts.iterationSummary) content += '\n\n' + opts.iterationSummary;
  if (opts.taskNotes) content += '\n\n=== TASK NOTES (from previous iterations) ===\n' + opts.taskNotes;
  if (backend === 'codex') content = MANAGER_ROLE_FRAMING_BLOCK + '\n\n' + content;
  return content;
}
