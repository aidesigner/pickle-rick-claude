#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot, printMinimalPanel, collectTickets, statusSymbol } from '../services/pickle-utils.js';
import { State } from '../types/index.js';

const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');

if (!fs.existsSync(SESSIONS_MAP)) {
  console.log('🥒 No active Pickle Rick session for this directory.');
  process.exit(0);
}

let map: Record<string, string>;
try {
  map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
} catch {
  console.log('🥒 Sessions map is unreadable. No active session.');
  process.exit(0);
}
const sessionPath = map[process.cwd()];

if (!sessionPath || !fs.existsSync(sessionPath)) {
  console.log('🥒 No active Pickle Rick session for this directory.');
  process.exit(0);
}

let state: State;
try {
  state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
} catch {
  console.log('🥒 Session state is unreadable.');
  process.exit(1);
}

const iterationStr = state.max_iterations
  ? `${state.iteration} of ${state.max_iterations}`
  : String(state.iteration);

const raw: string = state.original_prompt || '';
const taskStr = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

printMinimalPanel('Pickle Rick — Session Status', {
  Phase: state.step || 'unknown',
  Iteration: iterationStr,
  Ticket: state.current_ticket || 'none',
  Task: taskStr,
}, 'GREEN', '🥒');

const tickets = collectTickets(sessionPath);
if (tickets.length > 0) {
  console.log('Tickets:');
  for (const ticket of tickets) {
    console.log(`  ${statusSymbol(ticket.status)} ${ticket.id}: ${ticket.title}`);
  }
  console.log('');
}
