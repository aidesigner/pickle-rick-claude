#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { collectTickets, statusSymbol, formatTime, getWidth, Style, sleep } from '../services/pickle-utils.js';
import { State } from '../types/index.js';

/**
 * Extracts a short readable summary from a stream-json log line.
 * Returns the original line (sans ANSI) if it's not valid JSON.
 */
export function summarizeLine(raw: string): string {
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!clean) return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return clean;
  }
  if (typeof parsed !== 'object' || parsed === null) return clean;

  const type = parsed.type;

  if (type === 'assistant') {
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg || !Array.isArray(msg.content)) return '';
    const parts: string[] = [];
    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        const first = (b.text as string).split('\n')[0].trim();
        if (first) parts.push(first);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        parts.push(`🔧 ${b.name}`);
      }
    }
    return parts.join(' | ') || '';
  }
  if (type === 'result') {
    const isError = typeof parsed.subtype === 'string' && (parsed.subtype as string).startsWith('error');
    return isError ? `❌ ${parsed.subtype}` : '✅ success';
  }
  if (type === 'system' && parsed.subtype === 'init') {
    return `🚀 init (${typeof parsed.model === 'string' ? parsed.model : 'unknown'})`;
  }
  return '';
}

function render(sessionDir: string): boolean {
  // If the session directory itself is gone, signal exit (not just "waiting")
  if (!fs.existsSync(sessionDir)) return false;

  const statePath = path.join(sessionDir, 'state.json');
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as State;
  } catch {
    process.stdout.write('\x1b[2J\x1b[H⏳ Waiting for session...\n');
    return true;
  }

  const { GREEN: g, RED: red, YELLOW: y, BOLD: b, DIM: d, RESET: r } = Style;
  const width = getWidth();
  const sep = `${d}${'─'.repeat(width)}${r}`;

  const startEpoch = Number(state.start_time_epoch) || 0;
  const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
  const tickets = collectTickets(sessionDir);
  const maxIter = Number(state.max_iterations) || 0;
  const maxTime = Number(state.max_time_minutes) || 0;
  const iterStr = maxIter > 0
    ? `${state.iteration} / ${state.max_iterations}`
    : `${state.iteration}`;
  const timeStr = maxTime > 0
    ? `${formatTime(elapsed)} / ${state.max_time_minutes}m`
    : formatTime(elapsed);

  const workDir = state.working_dir || '';
  const project = workDir ? path.basename(workDir) : 'unknown';
  const task = state.original_prompt || '';
  const taskDisplay = task.length > width - 20 ? task.slice(0, width - 23) + '…' : (task || 'none');

  const fields: [string, string][] = [
    ['Project', `${b}${project}${r}`],
    ['Task', taskDisplay],
    ['Phase', state.step || 'unknown'],
    ['Iteration', iterStr],
    ['Elapsed', timeStr],
    ['Current Ticket', state.current_ticket || 'none'],
    ['Active', state.active === true ? `${g}Yes${r}` : `${red}No${r}`],
  ];

  try {
    const cbRaw = fs.readFileSync(path.join(sessionDir, 'circuit_breaker.json'), 'utf-8');
    const cb = JSON.parse(cbRaw) as { state?: string; reason?: string };
    if (cb.state === 'CLOSED') {
      fields.push(['Circuit', `${g}CLOSED${r}`]);
    } else if (cb.state === 'HALF_OPEN') {
      fields.push(['Circuit', `${y}HALF_OPEN (${cb.reason || ''})${r}`]);
    } else if (cb.state === 'OPEN') {
      fields.push(['Circuit', `${red}OPEN (${cb.reason || ''})${r}`]);
    }
  } catch {
    // circuit_breaker.json missing or corrupt — skip field
  }

  const keyWidth = Math.max(...fields.map(([k]) => k.length)) + 1;

  const out: string[] = ['\x1b[2J\x1b[H'];
  out.push(`\n${b}${g}🥒 Pickle Rick — Live Monitor${r}\n`);
  out.push(`${sep}\n`);
  for (const [k, v] of fields) {
    out.push(`  ${d}${k + ':'}${' '.repeat(keyWidth - k.length)}${r} ${v}\n`);
  }

  if (tickets.length > 0) {
    out.push(`\n${sep}\n${b}Tickets:${r}\n`);
    for (const ticket of tickets) {
      const status = (ticket.status || '').toLowerCase();
      const sym = statusSymbol(ticket.status);
      const coloredSym =
        status === 'done'
          ? `${g}${sym}${r}`
          : status === 'in progress'
            ? `${y}${sym}${r}`
            : sym;
      const isCurrent = ticket.id === state.current_ticket;
      const prefix = isCurrent ? `${y}▶${r}` : ' ';
      const titleStr = isCurrent ? `${b}${ticket.title}${r}` : ticket.title || '';
      out.push(`${prefix} ${coloredSym} ${ticket.id}: ${titleStr}\n`);
    }
  }

  try {
    const logs = fs
      .readdirSync(sessionDir)
      .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
        const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
        return (numA || 0) - (numB || 0);
      });
    if (logs.length > 0) {
      const latestLog = fs.readFileSync(path.join(sessionDir, logs[logs.length - 1]), 'utf-8');
      const summaryLines = latestLog
        .split('\n')
        .filter((l) => l.trim())
        .slice(-10)
        .map(summarizeLine)
        .filter((l) => l.length > 0)
        .slice(-5);
      if (summaryLines.length > 0) {
        out.push(`\n${sep}\n${d}Recent output:${r}\n`);
        for (const logLine of summaryLines) {
          const truncated =
            logLine.length > width - 2 ? logLine.slice(0, width - 5) + '…' : logLine;
          out.push(`${d}  ${truncated}${r}\n`);
        }
      }
    }
  } catch {
    /* ignore */
  }

  out.push(`\n${d}Refreshing every 2s  •  Ctrl+C to detach${r}\n`);
  process.stdout.write(out.join(''));
  return state.active === true;
}

async function main() {
  const sessionDir = process.argv[2];
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node monitor.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    process.stdout.write('\x1b[2J\x1b[HMonitor detached.\n');
    process.exit(0);
  });

  while (true) {
    const active = render(sessionDir);
    if (!active) {
      await sleep(3000);
      const stillInactive = !render(sessionDir);
      if (stillInactive) {
        process.stdout.write('\n🥒 Session complete. Monitor exiting.\n');
        break;
      }
    }
    await sleep(2000);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'monitor.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}[monitor] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
