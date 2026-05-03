#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, collectTickets, statusSymbol, findSessionPathForCwd, getTicketStatus } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
const sm = new StateManager();
function readSessionState(sessionPath) {
    try {
        return sm.read(path.join(sessionPath, 'state.json'));
    }
    catch {
        return null;
    }
}
function formatIteration(state) {
    const maxIter = Number(state.max_iterations) || 0;
    const curIter = Number(state.iteration) || 0;
    return maxIter > 0 ? `${curIter} of ${maxIter}` : String(curIter);
}
function formatTask(raw) {
    const task = raw || '';
    return task.length > 80 ? task.slice(0, 80) + '…' : task;
}
function renderTickets(sessionPath) {
    const tickets = collectTickets(sessionPath);
    if (tickets.length === 0)
        return;
    console.log('Tickets:');
    for (const ticket of tickets) {
        const status = ticket.id ? getTicketStatus(sessionPath, ticket.id) : ticket.status;
        console.log(`  ${statusSymbol(status)} ${ticket.id}: ${ticket.title}`);
    }
    console.log('');
}
export function showStatus(cwd) {
    const sessionPath = findSessionPathForCwd(cwd);
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.log('🥒 No active Pickle Rick session for this directory.');
        return;
    }
    const state = readSessionState(sessionPath);
    if (!state) {
        console.log('🥒 Session state is unreadable.');
        process.exit(1);
    }
    const isActive = state.active === true;
    const mode = state.tmux_mode === true ? 'tmux' : 'inline';
    printMinimalPanel('Pickle Rick — Session Status', {
        Active: isActive ? 'Yes' : 'No',
        Mode: mode,
        Phase: state.step || 'unknown',
        Iteration: formatIteration(state),
        Ticket: state.current_ticket || 'none',
        Task: formatTask(state.original_prompt),
    }, isActive ? 'GREEN' : 'RED', '🥒');
    renderTickets(sessionPath);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'status.js') {
    showStatus(process.cwd());
}
