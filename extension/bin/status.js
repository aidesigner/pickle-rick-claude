#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot, printMinimalPanel, collectTickets, statusSymbol } from '../services/pickle-utils.js';
export function showStatus(cwd) {
    const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');
    if (!fs.existsSync(SESSIONS_MAP)) {
        console.log('🥒 No active Pickle Rick session for this directory.');
        return;
    }
    let map;
    try {
        map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
    }
    catch {
        console.log('🥒 Sessions map is unreadable. No active session.');
        return;
    }
    const sessionPath = map[cwd];
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.log('🥒 No active Pickle Rick session for this directory.');
        return;
    }
    let state;
    try {
        state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
    }
    catch {
        console.log('🥒 Session state is unreadable.');
        process.exit(1);
    }
    const maxIter = Number(state.max_iterations) || 0;
    const curIter = Number(state.iteration) || 0;
    const iterationStr = maxIter > 0
        ? `${curIter} of ${maxIter}`
        : String(curIter);
    const raw = state.original_prompt || '';
    const taskStr = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    const isActive = state.active === true;
    const mode = state.tmux_mode === true ? 'tmux' : 'inline';
    printMinimalPanel('Pickle Rick — Session Status', {
        Active: isActive ? 'Yes' : 'No',
        Mode: mode,
        Phase: state.step || 'unknown',
        Iteration: iterationStr,
        Ticket: state.current_ticket || 'none',
        Task: taskStr,
    }, isActive ? 'GREEN' : 'RED', '🥒');
    const tickets = collectTickets(sessionPath);
    if (tickets.length > 0) {
        console.log('Tickets:');
        for (const ticket of tickets) {
            console.log(`  ${statusSymbol(ticket.status)} ${ticket.id}: ${ticket.title}`);
        }
        console.log('');
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'status.js') {
    showStatus(process.cwd());
}
