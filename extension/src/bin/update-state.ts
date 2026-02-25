#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { VALID_STEPS } from '../types/index.js';
import { writeStateFile } from '../hooks/resolve-state.js';

/**
 * Usage: node update-state.js <key> <value> <session_dir>
 */

export function updateState(key: string, value: string, sessionDir: string) {
  const statePath = path.join(sessionDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}`);
  }

  if (key === 'step' && !(VALID_STEPS as readonly string[]).includes(value)) {
    throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
  }

  const NUMERIC_KEYS = new Set(['iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch']);
  const BOOLEAN_KEYS = new Set(['active', 'tmux_mode']);
  const ALLOWED_KEYS = new Set([
    ...NUMERIC_KEYS, ...BOOLEAN_KEYS, 'step', 'working_dir', 'completion_promise',
    'original_prompt', 'current_ticket', 'started_at', 'session_dir',
  ]);
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(`Unknown state key "${key}". Allowed: ${[...ALLOWED_KEYS].join(', ')}`);
  }

  const state: Record<string, unknown> = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Key "${key}" requires a finite number, got "${value}"`);
    }
    state[key] = num;
  } else if (BOOLEAN_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
    }
    state[key] = value === 'true';
  } else {
    state[key] = value;
  }

  writeStateFile(statePath, state);
  console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'update-state.js') {
  const [key, value, sessionDir] = process.argv.slice(2);

  if (!key || !value || !sessionDir || sessionDir.startsWith('--')) {
    console.error('Usage: node update-state.js <key> <value> <session_dir>');
    process.exit(1);
  }

  try {
    updateState(key, value, sessionDir);
  } catch (err) {
    console.error(`Failed to update state: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
