#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot, extractFrontmatter, writeStateFile, updateState } from '../services/pickle-utils.js';
import { Defaults } from '../types/index.js';
export function retryTicket(ticketId, cwd) {
    // Validate ticketId to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) {
        throw new Error(`Invalid ticket ID: ${ticketId}`);
    }
    const sessionsMap = path.join(getExtensionRoot(), 'current_sessions.json');
    if (!fs.existsSync(sessionsMap)) {
        throw new Error('No active Pickle Rick session found.');
    }
    let map;
    try {
        map = JSON.parse(fs.readFileSync(sessionsMap, 'utf-8'));
    }
    catch {
        throw new Error('current_sessions.json is corrupt or unreadable.');
    }
    const sessionPath = map[cwd];
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        throw new Error('No active session found for this directory.');
    }
    const statePath = path.join(sessionPath, 'state.json');
    let state;
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch {
        throw new Error(`state.json is corrupt or unreadable in ${sessionPath}`);
    }
    const sessionDir = state.session_dir;
    if (!sessionDir) {
        throw new Error('state.json is missing session_dir field.');
    }
    const ticketDir = path.join(sessionDir, ticketId);
    const ticketFile = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
    if (!fs.existsSync(ticketDir) || !fs.existsSync(ticketFile)) {
        throw new Error(`Ticket ${ticketId} not found in session ${sessionDir}`);
    }
    // Archive partial artifacts
    const artifacts = fs.readdirSync(ticketDir).filter(f => /^research_.*\.md$/.test(f) || f === 'research_review.md' ||
        /^plan_.*\.md$/.test(f) || f === 'plan_review.md');
    if (artifacts.length > 0) {
        const archiveDir = path.join(ticketDir, `_retry_${Date.now()}`);
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const artifact of artifacts) {
            fs.renameSync(path.join(ticketDir, artifact), path.join(archiveDir, artifact));
        }
        console.log(`📦 Archived ${artifacts.length} artifact(s) to ${path.basename(archiveDir)}/`);
    }
    // Reset ticket status to Todo — scope replacement to YAML frontmatter only
    const ticketContent = fs.readFileSync(ticketFile, 'utf-8');
    const fmResult = extractFrontmatter(ticketContent);
    let updatedContent;
    if (fmResult) {
        const fmSection = ticketContent.slice(0, fmResult.end).replace(/^status:.*$/m, 'status: "Todo"');
        updatedContent = fmSection + ticketContent.slice(fmResult.end);
    }
    else {
        updatedContent = ticketContent.replace(/^status:.*$/m, 'status: "Todo"');
    }
    const tmpTicket = ticketFile + `.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpTicket, updatedContent);
        fs.renameSync(tmpTicket, ticketFile);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpTicket);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
    // Re-activate session and set current ticket
    state.active = true;
    writeStateFile(statePath, state);
    updateState('current_ticket', ticketId, sessionDir);
    // Read final state for timeout/prompt values
    let finalState;
    try {
        finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    catch {
        throw new Error(`state.json became unreadable after update in ${sessionPath}`);
    }
    const rawTimeout = Number(finalState.worker_timeout_seconds);
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : Defaults.WORKER_TIMEOUT_SECONDS;
    // Shell-safe escaping: single-quote escaping + collapse newlines to spaces
    const safePrompt = (finalState.original_prompt || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/'/g, "'\\''");
    // Task is first positional arg (spawn-morty.js:13 expects args[0] as task)
    // Use single-quoting for sessionDir to prevent shell expansion of $, `, etc.
    const safeSessionDir = sessionDir.replace(/'/g, "'\\''");
    const spawnCmd = `node "${getExtensionRoot()}/extension/bin/spawn-morty.js" '${safePrompt}' --ticket-id '${ticketId}' --ticket-path '${safeSessionDir}/${ticketId}/' --ticket-file '${safeSessionDir}/${ticketId}/linear_ticket_${ticketId}.md' --timeout ${timeout}`;
    console.log(`\n✅ Ticket ${ticketId} reset to Todo. Run this command to re-spawn Morty:\n\n${spawnCmd}\n`);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'retry-ticket.js') {
    const ticketId = process.argv[2];
    if (!ticketId) {
        console.error('Usage: node retry-ticket.js <ticket-id>');
        process.exit(1);
    }
    try {
        retryTicket(ticketId, process.cwd());
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
