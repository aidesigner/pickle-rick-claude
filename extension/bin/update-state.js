#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { VALID_STEPS } from '../types/index.js';
import { writeStateFile } from '../hooks/resolve-state.js';
/**
 * Usage: node update-state.js <key> <value> <session_dir>
 */
export function updateState(key, value, sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) {
        throw new Error(`state.json not found at ${statePath}`);
    }
    if (key === 'step' && !VALID_STEPS.includes(value)) {
        throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
    }
    const NUMERIC_KEYS = new Set(['iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch']);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state[key] = NUMERIC_KEYS.has(key) ? Number(value) : value;
    writeStateFile(statePath, state);
    console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'update-state.js') {
    const [key, value, sessionDir] = process.argv.slice(2);
    if (!key || !value || !sessionDir) {
        console.error('Usage: node update-state.js <key> <value> <session_dir>');
        process.exit(1);
    }
    try {
        updateState(key, value, sessionDir);
    }
    catch (err) {
        console.error(`Failed to update state: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
