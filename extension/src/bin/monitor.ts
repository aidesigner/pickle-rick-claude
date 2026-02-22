#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { collectTickets, statusSymbol, formatTime, getWidth, Style } from '../services/pickle-utils.js';

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function render(sessionDir: string): boolean {
  const statePath = path.join(sessionDir, 'state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    process.stdout.write('\x1b[2J\x1b[H⏳ Waiting for session...\n');
    return true;
  }

  const { GREEN: g, RED: red, YELLOW: y, BOLD: b, DIM: d, RESET: r } = Style;
  const width = getWidth();
  const sep = `${d}${'─'.repeat(width)}${r}`;

  const elapsed = Math.floor(Date.now() / 1000) - ((state.start_time_epoch as number) || 0);
  const tickets = collectTickets(sessionDir);
  const iterStr =
    (state.max_iterations as number) > 0
      ? `${state.iteration} / ${state.max_iterations}`
      : `${state.iteration}`;
  const timeStr =
    (state.max_time_minutes as number) > 0
      ? `${formatTime(elapsed)} / ${state.max_time_minutes}m`
      : formatTime(elapsed);

  const fields: [string, string][] = [
    ['Phase', (state.step as string) || 'unknown'],
    ['Iteration', iterStr],
    ['Elapsed', timeStr],
    ['Current Ticket', (state.current_ticket as string) || 'none'],
    ['Active', state.active ? `${g}Yes${r}` : `${red}No${r}`],
  ];
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
      .sort();
    if (logs.length > 0) {
      const latestLog = fs.readFileSync(path.join(sessionDir, logs[logs.length - 1]), 'utf-8');
      const cleanLines = latestLog
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .split('\n')
        .filter((l) => l.trim())
        .slice(-5);
      if (cleanLines.length > 0) {
        out.push(`\n${sep}\n${d}Recent output:${r}\n`);
        for (const logLine of cleanLines) {
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
  return state.active as boolean;
}

async function main() {
  const sessionDir = process.argv[2];
  if (!sessionDir || !fs.existsSync(sessionDir)) {
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
      render(sessionDir);
      process.stdout.write('\n🥒 Session complete. Monitor exiting.\n');
      break;
    }
    await sleep(2000);
  }
}

main().catch((err: Error) => {
  console.error(`${Style.RED}[monitor] ${err.message}${Style.RESET}`);
  process.exit(1);
});
