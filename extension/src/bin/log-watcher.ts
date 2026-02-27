#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep } from '../services/pickle-utils.js';

const CHUNK_SIZE = 65536; // 64 KiB

function latestLog(sessionDir: string): string | null {
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

/**
 * Extracts the most informative parameter from a tool_use input object.
 */
export function formatToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return typeof input.command === 'string' ? input.command : name;
    case 'Edit':
    case 'Read':
    case 'Write': return typeof input.file_path === 'string' ? input.file_path : name;
    case 'Glob': return typeof input.pattern === 'string' ? input.pattern : name;
    case 'Grep': return typeof input.pattern === 'string' ? input.pattern : name;
    case 'Task': return typeof input.description === 'string' ? input.description : name;
    default: return name;
  }
}

/**
 * Processes a single line from a stream-json log.
 * Returns a human-readable string or null to skip.
 */
export function processLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — display as-is (backward compat with non-stream-json output)
    return trimmed;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const type = parsed.type;

  if (type === 'assistant') {
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg || !Array.isArray(msg.content)) return null;
    const parts: string[] = [];
    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const input = (typeof b.input === 'object' && b.input !== null)
          ? b.input as Record<string, unknown>
          : {};
        parts.push(`🔧 ${b.name}: ${formatToolUse(b.name, input)}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (type === 'result') {
    const isError = typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error');
    const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : '?';
    const cost = typeof parsed.total_cost_usd === 'number'
      ? `$${(parsed.total_cost_usd as number).toFixed(2)}`
      : '$?';
    return isError
      ? `❌ Session ${parsed.subtype} (${turns} turns, ${cost})`
      : `✅ Session success (${turns} turns, ${cost})`;
  }

  if (type === 'system') {
    const subtype = parsed.subtype;
    if (subtype === 'init') {
      const model = typeof parsed.model === 'string' ? parsed.model : 'unknown';
      return `🚀 Session started (model: ${model})`;
    }
    return null;
  }

  // Unknown type — skip
  return null;
}

/**
 * Reads stream-json log from `offset`, parses complete lines, emits readable output.
 * Returns `{ offset, lineBuf }` — new byte offset and any partial trailing line.
 */
export function drainStreamJson(
  logPath: string,
  offset: number,
  lineBuf: string,
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
      const toRead = Math.min(CHUNK_SIZE, size - pos);
      const raw = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
      if (bytesRead === 0) break;
      buf += raw.subarray(0, bytesRead).toString('utf-8');
      pos += bytesRead;
    }
    fs.closeSync(fd);
    fd = null;

    // Split into complete lines; keep any partial trailing line
    const lines = buf.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      const result = processLine(line);
      if (result !== null) emit(result);
    }
    return { offset: pos, lineBuf: trailing };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { offset, lineBuf };
  }
}

async function main() {
  const sessionDir = process.argv[2];
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node log-watcher.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    process.stdout.write('\nDetached.\n');
    process.exit(0);
  });

  const { GREEN: g, CYAN: c, BOLD: b, DIM: d, RESET: r } = Style;
  const width = () => Math.min((process.stdout.columns || 60) - 2, 60);
  const sep = () => `${d}${'─'.repeat(width())}${r}`;
  const emit = (text: string) => {
    for (const line of text.split('\n')) {
      const truncated = line.length > width() ? line.slice(0, width() - 3) + '…' : line;
      process.stdout.write(truncated + '\n');
    }
  };

  process.stdout.write(`\n${b}${g}🥒 Pickle Rick — Log Stream${r}\n${sep()}\n`);

  let currentLog: string | null = null;
  let offset = 0;
  let lineBuf = '';

  while (true) {
    const log = latestLog(sessionDir);

    if (!log) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        if (state.active !== true) {
          process.stdout.write(`\n${sep()}\n${g}🥒 Session complete (no iteration logs).${r}\n`);
          break;
        }
      } catch { /* ignore */ }
      process.stdout.write(`\r${d}Waiting for first iteration...${r}\x1b[K`);
      await sleep(1000);
      continue;
    }

    if (log !== currentLog) {
      currentLog = log;
      offset = 0;
      lineBuf = '';
      const n = path.basename(log, '.log').replace('tmux_iteration_', '');
      process.stdout.write(`\n${sep()}\n${b}${c}Iteration ${n}${r}\n${sep()}\n`);
    }

    const result = drainStreamJson(currentLog, offset, lineBuf, emit);
    offset = result.offset;
    lineBuf = result.lineBuf;

    try {
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      if (state.active !== true) {
        await sleep(2000);
        drainStreamJson(currentLog, offset, lineBuf, emit);
        process.stdout.write(`\n${sep()}\n${g}🥒 Session complete.${r}\n`);
        break;
      }
    } catch {
      /* ignore */
    }

    await sleep(500);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'log-watcher.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}[log-watcher] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
