#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { sleep } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';

const POLL_INTERVAL_MS = 2000;
const MICROVERSE_STEPS = new Set(['anatomy-park', 'szechuan-sauce']);
const sm = new StateManager();

/**
 * Resolves the pointer line for pane 1.2 based on the current pipeline step.
 * Exported for direct unit testing without subprocess spawning.
 */
export function resolvePointerLine(
  state: Record<string, unknown>,
  microverse: Record<string, unknown> | null,
): string {
  const step = typeof state.step === 'string' ? state.step : '';
  if (MICROVERSE_STEPS.has(step)) {
    if (!microverse) return '▸ —';
    const sub = typeof microverse.current_subsystem === 'string' && microverse.current_subsystem
      ? microverse.current_subsystem
      : null;
    if (!sub) return '▸ —';
    // Read iterations: test fixtures write `iterations` directly; real microverse state uses history length
    const conv = microverse.convergence as Record<string, unknown> | undefined;
    const iter = typeof microverse.iterations === 'number'
      ? microverse.iterations
      : Array.isArray(conv?.history) ? conv.history.length : null;
    return iter !== null ? `▸ ${sub} (iter ${iter})` : `▸ ${sub}`;
  }
  const ticket = typeof state.current_ticket === 'string' && state.current_ticket
    ? state.current_ticket
    : null;
  return ticket ? `▸ ${ticket}` : '▸ —';
}

async function main() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional startup guard
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node pane-1-2-pointer.js <session-dir>');
    process.exit(1);
  }

  // Suppress stale-stdin warning: when the producer process exits (phase advance),
  // stdin will close and we exit 0 cleanly rather than ever logging a warning.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));

  const statePath = path.join(sessionDir, 'state.json');
  const microversePath = path.join(sessionDir, 'microverse.json');
  let lastRendered: string | undefined;

  while (true) {
    let stateSnap: Record<string, unknown> = {};
    try {
      stateSnap = sm.read(statePath) as unknown as Record<string, unknown>;
    } catch { /* session dir unreadable — keep polling */ }

    const microverseData = readRecoverableJsonObject(microversePath) as Record<string, unknown> | null;
    const line = resolvePointerLine(stateSnap, microverseData);

    if (line !== lastRendered) {
      lastRendered = line;
      process.stdout.write(`${line}\n`);
    }

    // Exit after rendering current data (mirrors subsystem-watcher pattern)
    if (stateSnap.active === false) break;

    await sleep(POLL_INTERVAL_MS);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'pane-1-2-pointer.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pane-1-2-pointer] ${msg}`);
    process.exit(1);
  });
}
