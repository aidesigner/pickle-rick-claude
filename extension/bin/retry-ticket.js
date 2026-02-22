#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot } from '../services/pickle-utils.js';
import { updateState } from './update-state.js';

function retryTicket(ticketId, cwd) {
    const sessionsMap = path.join(getExtensionRoot(), 'current_sessions.json');
    if (!fs.existsSync(sessionsMap)) {
        console.error('No active Pickle Rick session found.');
        process.exit(1);
    }
    const map = JSON.parse(fs.readFileSync(sessionsMap, 'utf-8'));
    const sessionPath = map[cwd];
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.error('No active session found for this directory.');
        process.exit(1);
    }
    const statePath = path.join(sessionPath, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const sessionDir = state.session_dir;
    const ticketDir = path.join(sessionDir, ticketId);
    const ticketFile = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
    if (!fs.existsSync(ticketDir) || !fs.existsSync(ticketFile)) {
        console.error(`Ticket ${ticketId} not found in session ${sessionDir}`);
        process.exit(1);
    }
    // Archive partial artifacts
    const artifacts = fs.readdirSync(ticketDir).filter(f =>
        /^research_.*\.md$/.test(f) || f === 'research_review.md' ||
        /^plan_.*\.md$/.test(f) || f === 'plan_review.md'
    );
    if (artifacts.length > 0) {
        const archiveDir = path.join(ticketDir, `_retry_${Date.now()}`);
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const artifact of artifacts) {
            fs.renameSync(path.join(ticketDir, artifact), path.join(archiveDir, artifact));
        }
        console.log(`📦 Archived ${artifacts.length} artifact(s) to ${path.basename(archiveDir)}/`);
    }
    // Reset ticket status to Todo
    const ticketContent = fs.readFileSync(ticketFile, 'utf-8');
    fs.writeFileSync(ticketFile, ticketContent.replace(/^status: .+$/m, 'status: Todo'));
    // Re-activate session
    state.active = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    // Set current ticket
    updateState('current_ticket', ticketId, sessionDir);
    // Read fresh state for timeout
    const freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const timeout = freshState.worker_timeout_seconds || 1500;
    const originalPrompt = freshState.original_prompt || '';
    const spawnCmd = `node "$HOME/.claude/pickle-rick/extension/bin/spawn-morty.js" --ticket-id ${ticketId} --ticket-path "${sessionDir}/${ticketId}/" --ticket-file "${sessionDir}/${ticketId}/linear_ticket_${ticketId}.md" --timeout ${timeout} "${originalPrompt.replace(/"/g, '\\"')}"`;
    console.log(`\n✅ Ticket ${ticketId} reset to Todo. Run this command to re-spawn Morty:\n\n${spawnCmd}\n`);
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('retry-ticket')) {
    const ticketId = process.argv[2];
    if (!ticketId) {
        console.error('Usage: node retry-ticket.js <ticket-id>');
        process.exit(1);
    }
    retryTicket(ticketId, process.cwd());
}
