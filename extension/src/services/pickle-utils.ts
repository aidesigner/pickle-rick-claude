import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { State } from '../types/index.js';

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

interface ShellError extends Error {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

export function runCmd(
  cmd: string | string[],
  options: { cwd?: string; check?: boolean; capture?: boolean } = {}
): string {
  const { cwd, check = true, capture = true } = options;

  // Array form: use spawnSync so each argument is passed verbatim (no shell splitting).
  // String form: use execSync via the shell (supports pipes, globs, etc.).
  if (Array.isArray(cmd)) {
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (check && (result.status ?? 1) !== 0) {
      throw new Error(`Command failed: ${cmd.join(' ')}\nError: ${result.stderr || ''}`);
    }
    return (result.stdout || '').trim();
  }

  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return (stdout || '').trim();
  } catch (error) {
    if (check) {
      const stderr = error instanceof Error && 'stderr' in error
        ? String((error as ShellError).stderr || '')
        : '';
      const msg = stderr || (error instanceof Error ? error.message : String(error));
      throw new Error(`Command failed: ${cmd}\nError: ${msg}`);
    }
    const stdout = error instanceof Error && 'stdout' in error
      ? String((error as ShellError).stdout || '')
      : '';
    return stdout.trim();
  }
}

export function getExtensionRoot(): string {
  return process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
}

export function statusSymbol(status: string | null): string {
  const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
  if (s === 'done') return '[x]';
  if (s === 'in progress') return '[~]';
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

export interface TicketInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  order: number;
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
    return {
      id: get('id'),
      title: get('title'),
      status: get('status'),
      order: parseInt(get('order') || '0', 10) || 0,
    };
  } catch {
    return null;
  }
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
    return tickets.sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

export function buildHandoffSummary(state: Partial<State>, sessionDir: string): string {
  const task = state.original_prompt || '';
  const truncatedTask = task.length > 300 ? task.slice(0, 300) + ' [truncated]' : task;
  const prdPath = path.join(sessionDir, 'prd.md');
  const prdExists = fs.existsSync(prdPath);
  const tickets = collectTickets(sessionDir);
  const iter = Number(state.iteration) || 0;
  const maxIter = Number(state.max_iterations) || 0;
  const iterLine = maxIter > 0
    ? `${iter} of ${maxIter}`
    : `${iter}`;
  const lines = [
    '=== PICKLE RICK LOOP CONTEXT ===',
    `Phase: ${state.step || 'unknown'}`,
    `Iteration: ${iterLine}`,
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
  if (tickets.length > 0) {
    lines.push('Tickets:');
    for (const t of tickets) {
      const sym = statusSymbol(t.status || '');
      const title = (t.title || '').length > 60
        ? (t.title || '').slice(0, 60) + '...'
        : (t.title || '');
      lines.push(`  ${sym} ${t.id || '?'}: ${title}`);
    }
  }
  lines.push(
    '',
    'NEXT ACTION: Resume from current phase. Read state.json for context.',
    'Do NOT restart from scratch. Continue where you left off.',
  );
  return lines.join('\n');
}

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep that yields to the OS scheduler instead of busy-waiting. */
function sleepMs(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries for up to 3 seconds
 * and steals locks older than 5 seconds. Degrades gracefully on timeout.
 */
export function withSessionMapLock<T>(lockPath: string, fn: () => T): T {
  const MAX_WAIT_MS = 3000;
  const RETRY_MS = 50;
  const STALE_MS = 5000;
  const deadline = Date.now() + MAX_WAIT_MS;
  let acquired = false;

  while (!acquired) {
    // Steal stale lock if present — unlink + create in tight sequence to minimize TOCTOU window
    let stale = false;
    try {
      const stats = fs.statSync(lockPath);
      stale = Date.now() - stats.mtimeMs > STALE_MS;
    } catch { /* lock file doesn't exist — expected */ }

    if (stale) {
      // Attempt atomic steal: unlink then immediately try exclusive create
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }

    // Atomic exclusive create
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        // Proceeding without lock — concurrent writes to sessions map are possible
        console.error(`[pickle] WARNING: lock acquisition timed out (${lockPath}), proceeding without lock`);
        break;
      }
      sleepMs(Math.min(RETRY_MS, deadline - Date.now()));
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/** Async sleep — resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB

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
 * Removes inactive session directories older than maxAgeDays from sessionsRoot.
 * Called on each new session start to prevent unbounded accumulation.
 */
export function pruneOldSessions(sessionsRoot: string, maxAgeDays = 7): void {
  if (!fs.existsSync(sessionsRoot)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, entry);
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.active === true) continue;
      const rawMs = state.started_at
        ? new Date(state.started_at).getTime()
        : NaN;
      const startedMs = Number.isFinite(rawMs)
        ? rawMs
        : fs.statSync(sessionDir).mtimeMs;
      if (startedMs < cutoffMs) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch { /* skip unreadable or already-deleted sessions */ }
  }
}
